import type { Pool } from "../db.js";
import { sha256Bytes, randomTokenUrlSafe, secretsMatch, type SecretBox } from "./crypto.js";
import { teamError } from "../errors.js";

/**
 * Account mapping and revocable sessions (contract C5/C6).
 *
 * - Accounts map by (issuer, sub) — never by email; no auto-linking.
 * - Application sessions are keyed by the validated (issuer, sid, clientId,
 *   user). Revoked rows are retained forever and can never auto-register
 *   again; a fresh IdP login must produce a new sid.
 * - Web (BFF) sessions store only the opaque cookie token hash, an encrypted
 *   provider refresh token and a CSRF hash; sliding inactivity 24h capped by
 *   an absolute 30-day window anchored at the app session's creation.
 */

export const WEB_SESSION_INACTIVITY_MS = 24 * 60 * 60 * 1000;
export const WEB_SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

export interface MappedUser {
  userId: string;
  email: string;
  displayName: string;
}

export interface MapUserInput {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
}

export interface AppSessionContext {
  issuer: string;
  subject: string;
  /** Validated provider session id (sid claim). */
  providerSessionId: string;
  clientId: string;
}

export interface ResolvedAppSession {
  appSessionId: string;
  userId: string;
  createdAt: Date;
}

export interface CreateWebSessionInput {
  appSessionId: string;
  refreshToken: string | null;
  /** Generated when omitted; callers only supply it in tests. */
  csrfToken?: string;
}

export interface CreatedWebSession {
  /** Raw opaque cookie value — shown once here, stored only hashed. */
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface ResolvedWebSession {
  appSessionId: string;
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  csrfHash: Buffer;
  /** Lazily-decrypted provider refresh token (null when the IdP issued none). */
  decryptRefreshToken: () => string | null;
  authenticatedAt: Date;
}

export interface SessionSummary {
  id: string;
  clientId: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

function normalizeEmail(email: string): string {
  // Comparison normalization only (trim + lower-case); no provider-specific
  // alias rewriting such as `+` or dots (contract C8).
  return email.trim().toLowerCase();
}

export interface SessionsOptions {
  inactivityMs?: number;
  absoluteMs?: number;
}

export class Sessions {
  constructor(
    private readonly pool: Pool,
    private readonly secretBox: SecretBox,
    private readonly options: SessionsOptions = {},
  ) {}

  /**
   * Maps a verified identity to a user row, creating it on first sight and
   * refreshing contact metadata afterwards. Disabled/deleted accounts are
   * rejected on every request, not only at login.
   */
  async mapUser(input: MapUserInput): Promise<MappedUser> {
    const email = normalizeEmail(input.email);
    const displayName = input.displayName.trim() || email.split("@")[0] || "Team member";
    const result = await this.pool.query<{
      id: string;
      verified_email: string;
      normalized_email: string;
      display_name: string;
      disabled_at: Date | null;
      deleted_at: Date | null;
    }>(
      `INSERT INTO team_users (issuer, subject, verified_email, normalized_email, display_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (issuer, subject) DO UPDATE
         SET verified_email = EXCLUDED.verified_email,
             normalized_email = EXCLUDED.normalized_email,
             display_name = EXCLUDED.display_name,
             updated_at = now()
       RETURNING id, verified_email, normalized_email, display_name, disabled_at, deleted_at`,
      [input.issuer, input.subject, email, email, displayName],
    );
    const row = result.rows[0];
    if (!row) throw teamError("UNAVAILABLE", "Account mapping failed");
    if (row.disabled_at || row.deleted_at) {
      throw teamError("UNAUTHENTICATED", "Account is disabled");
    }
    return { userId: row.id, email: row.verified_email, displayName: row.display_name };
  }

  /**
   * Resolves the application session for a validated provider session. The
   * first valid login creates it; a previously revoked (issuer, sid, client,
   * user) key never registers again — the unique index turns the insert into
   * a conflict and the retained revoked row forces SESSION_REVOKED.
   */
  async resolveAppSession(context: AppSessionContext, userId: string): Promise<ResolvedAppSession> {
    const existing = await this.pool.query<{
      id: string;
      user_id: string;
      created_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, user_id, created_at, revoked_at
         FROM team_sessions
        WHERE issuer = $1 AND sid = $2 AND client_id = $3 AND user_id = $4`,
      [context.issuer, context.providerSessionId, context.clientId, userId],
    );
    const row = existing.rows[0];
    if (row) {
      if (row.revoked_at) {
        throw teamError("SESSION_REVOKED", "This sign-in session was revoked; sign in again");
      }
      await this.pool.query("UPDATE team_sessions SET last_seen_at = now() WHERE id = $1", [row.id]);
      return { appSessionId: row.id, userId: row.user_id, createdAt: row.created_at };
    }

    const inserted = await this.pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO team_sessions (user_id, issuer, sid, client_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (issuer, sid, client_id, user_id) DO NOTHING
       RETURNING id, created_at`,
      [userId, context.issuer, context.providerSessionId, context.clientId],
    );
    if (inserted.rows[0]) {
      return { appSessionId: inserted.rows[0].id, userId, createdAt: inserted.rows[0].created_at };
    }
    // Lost the insert race or the key exists as revoked: re-read and decide.
    const reread = await this.pool.query<{ id: string; user_id: string; created_at: Date; revoked_at: Date | null }>(
      `SELECT id, user_id, created_at, revoked_at
         FROM team_sessions
        WHERE issuer = $1 AND sid = $2 AND client_id = $3 AND user_id = $4`,
      [context.issuer, context.providerSessionId, context.clientId, userId],
    );
    const found = reread.rows[0];
    if (!found) throw teamError("UNAVAILABLE", "Session resolution failed");
    if (found.revoked_at) {
      throw teamError("SESSION_REVOKED", "This sign-in session was revoked; sign in again");
    }
    return { appSessionId: found.id, userId: found.user_id, createdAt: found.created_at };
  }

  /** Creates a browser session; the raw cookie value is returned exactly once. */
  async createWebSession(input: CreateWebSessionInput): Promise<CreatedWebSession> {
    const token = randomTokenUrlSafe(32);
    const csrfToken = input.csrfToken || randomTokenUrlSafe(32);
    const sealed = input.refreshToken ? this.secretBox.seal(input.refreshToken) : null;
    const absoluteDeadline = await this.absoluteDeadline(input.appSessionId);
    const expiresAt = new Date(
      Math.min(Date.now() + this.inactivityMs(), absoluteDeadline.getTime()),
    );
    await this.pool.query(
      `INSERT INTO team_web_sessions
         (token_hash, app_session_id, encrypted_refresh, refresh_nonce, refresh_key_id, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sha256Bytes(token),
        input.appSessionId,
        sealed ? sealed.ciphertext : Buffer.alloc(0),
        sealed ? sealed.nonce : Buffer.alloc(0),
        sealed ? sealed.keyId : "none",
        sha256Bytes(csrfToken),
        expiresAt,
      ],
    );
    return { token, csrfToken, expiresAt };
  }

  /**
   * Validates the opaque cookie: existence, sliding inactivity, absolute
   * window, app-session revocation and account status are all rechecked —
   * JWT-style "validated once" is never assumed for browser sessions.
   */
  async resolveWebSession(token: string): Promise<ResolvedWebSession> {
    const result = await this.pool.query<{
      app_session_id: string;
      csrf_hash: Buffer;
      encrypted_refresh: Buffer;
      refresh_nonce: Buffer;
      refresh_key_id: string;
      expires_at: Date;
      user_id: string;
      verified_email: string;
      display_name: string;
      disabled_at: Date | null;
      deleted_at: Date | null;
      session_id: string;
      session_created_at: Date;
      session_revoked_at: Date | null;
    }>(
      `SELECT w.app_session_id, w.csrf_hash, w.encrypted_refresh, w.refresh_nonce, w.refresh_key_id,
              w.expires_at,
              u.id AS user_id, u.verified_email, u.display_name, u.disabled_at, u.deleted_at,
              s.id AS session_id, s.created_at AS session_created_at, s.revoked_at AS session_revoked_at
         FROM team_web_sessions w
         JOIN team_sessions s ON s.id = w.app_session_id
         JOIN team_users u ON u.id = s.user_id
        WHERE w.token_hash = $1`,
      [sha256Bytes(token)],
    );
    const row = result.rows[0];
    if (!row) throw teamError("UNAUTHENTICATED", "Sign in required");
    if (row.session_revoked_at) {
      // Keep the row until first observation so a revoked browser session
      // hears SESSION_REVOKED (not a generic sign-in prompt); drop it after.
      await this.dropWebSession(token);
      throw teamError("SESSION_REVOKED", "Session was revoked; sign in again");
    }
    if (row.disabled_at || row.deleted_at) throw teamError("UNAUTHENTICATED", "Account is disabled");
    const now = Date.now();
    if (now > row.expires_at.getTime()) {
      await this.dropWebSession(token);
      throw teamError("UNAUTHENTICATED", "Session expired; sign in again");
    }
    const absoluteDeadline = row.session_created_at.getTime() + this.absoluteMs();
    if (now > absoluteDeadline) {
      await this.dropWebSession(token);
      throw teamError("UNAUTHENTICATED", "Session exceeded its maximum lifetime; sign in again");
    }
    // Sliding renewal touches both the web session and its provider session.
    const renewed = new Date(Math.min(now + this.inactivityMs(), absoluteDeadline));
    await this.pool.query(
      "UPDATE team_web_sessions SET last_seen_at = now(), expires_at = $2 WHERE token_hash = $1",
      [sha256Bytes(token), renewed],
    );
    await this.pool.query("UPDATE team_sessions SET last_seen_at = now() WHERE id = $1", [row.app_session_id]);

    const sealed = { ciphertext: row.encrypted_refresh, nonce: row.refresh_nonce, keyId: row.refresh_key_id };
    return {
      appSessionId: row.app_session_id,
      sessionId: row.session_id,
      userId: row.user_id,
      email: row.verified_email,
      displayName: row.display_name,
      csrfHash: row.csrf_hash,
      decryptRefreshToken: () =>
        sealed.keyId === "none" || sealed.ciphertext.length === 0
          ? null
          : this.secretBox.open(sealed).toString("utf8"),
      authenticatedAt: row.session_created_at,
    };
  }

  async dropWebSession(token: string): Promise<void> {
    await this.pool.query("DELETE FROM team_web_sessions WHERE token_hash = $1", [sha256Bytes(token)]);
  }

  /** Logs the browser out: web row deleted, app session revoked. */
  async revokeWebSessionByToken(token: string): Promise<boolean> {
    const result = await this.pool.query<{ app_session_id: string }>(
      "DELETE FROM team_web_sessions WHERE token_hash = $1 RETURNING app_session_id",
      [sha256Bytes(token)],
    );
    const row = result.rows[0];
    if (!row) return false;
    await this.pool.query("UPDATE team_sessions SET revoked_at = now() WHERE id = $1", [row.app_session_id]);
    return true;
  }

  async listUserSessions(userId: string): Promise<SessionSummary[]> {
    const result = await this.pool.query<{
      id: string;
      client_id: string;
      created_at: Date;
      last_seen_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, client_id, created_at, last_seen_at, revoked_at
         FROM team_sessions
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    }));
  }

  /** Revokes one of the user's own sessions. 404 when foreign; dependent web
   *  rows are left in place so their next use observes SESSION_REVOKED. */
  async revokeUserSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM team_sessions WHERE id = $1 AND user_id = $2",
      [sessionId, userId],
    );
    if (!result.rows[0]) throw teamError("NOT_FOUND", "Session not found");
    await this.pool.query("UPDATE team_sessions SET revoked_at = now() WHERE id = $1", [sessionId]);
  }

  /** Revokes every human session of the user (web rows observe lazily). */
  async revokeAllUserSessions(userId: string): Promise<number> {
    const result = await this.pool.query(
      "UPDATE team_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
      [userId],
    );
    return result.rowCount ?? 0;
  }

  /** True when the acting session's provider login is within the fresh window. */
  async isFreshLogin(appSessionId: string, windowMs: number): Promise<boolean> {
    const result = await this.pool.query<{ created_at: Date; revoked_at: Date | null }>(
      "SELECT created_at, revoked_at FROM team_sessions WHERE id = $1",
      [appSessionId],
    );
    const row = result.rows[0];
    if (!row || row.revoked_at) return false;
    return Date.now() - row.created_at.getTime() <= windowMs;
  }

  /**
   * Account deletion (contract C8): fresh login + confirmed email + no
   * sole-owned workspace. Disables the account and revokes every session;
   * display anonymization and retention jobs complete in P9.
   */
  async deleteAccount(input: {
    userId: string;
    appSessionId: string;
    confirmEmail: string;
    freshWindowMs: number;
  }): Promise<void> {
    if (!(await this.isFreshLogin(input.appSessionId, input.freshWindowMs))) {
      throw teamError("UNAUTHENTICATED", "Account deletion requires a fresh login");
    }
    const user = await this.pool.query<{ verified_email: string; normalized_email: string }>(
      "SELECT verified_email, normalized_email FROM team_users WHERE id = $1 AND disabled_at IS NULL",
      [input.userId],
    );
    const row = user.rows[0];
    if (!row) throw teamError("NOT_FOUND", "Account not found");
    if (normalizeEmail(input.confirmEmail) !== row.normalized_email) {
      throw teamError("VALIDATION_FAILED", "confirmEmail does not match the account email");
    }
    const soleOwner = await this.pool.query<{ workspace_id: string }>(
      `SELECT m.workspace_id
         FROM team_memberships m
        WHERE m.user_id = $1 AND m.role = 'owner' AND m.removed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM team_memberships other
             WHERE other.workspace_id = m.workspace_id
               AND other.user_id <> m.user_id
               AND other.role = 'owner'
               AND other.removed_at IS NULL
          )`,
      [input.userId],
    );
    if (soleOwner.rows.length > 0) {
      throw teamError("LAST_OWNER", "Transfer ownership of your workspace before deleting the account");
    }
    await this.revokeAllUserSessions(input.userId);
    await this.pool.query(
      "UPDATE team_agent_tokens SET revoked_at = now() WHERE owner_user_id = $1 AND revoked_at IS NULL",
      [input.userId],
    );
    // Anonymize identity columns: historical actor IDs stay valid in audit
    // and revision authorship, but the person behind them is no longer
    // identifiable. The synthesized address keeps any unique index satisfied.
    // Revision rows never carried a denormalized name/email copy (by design),
    // so online presentation resolves to "Former member" automatically.
    await this.pool.query(
      `UPDATE team_users
          SET display_name = 'Former member',
              verified_email = 'former+' || $1::text || '@deleted.invalid',
              normalized_email = 'former+' || $1::text || '@deleted.invalid',
              disabled_at = now(), deleted_at = now(), updated_at = now()
        WHERE id = $1`,
      [input.userId],
    );
  }

  /** Constant-time CSRF check: the presented token is hashed before comparing. */
  csrfMatches(webSession: ResolvedWebSession, presented: string): boolean {
    return secretsMatch(webSession.csrfHash, sha256Bytes(presented));
  }

  private inactivityMs(): number {
    return this.options.inactivityMs ?? WEB_SESSION_INACTIVITY_MS;
  }

  private absoluteMs(): number {
    return this.options.absoluteMs ?? WEB_SESSION_ABSOLUTE_MS;
  }

  private async absoluteDeadline(appSessionId: string): Promise<Date> {
    const result = await this.pool.query<{ created_at: Date }>(
      "SELECT created_at FROM team_sessions WHERE id = $1",
      [appSessionId],
    );
    const created = result.rows[0]?.created_at;
    return new Date((created ? created.getTime() : Date.now()) + this.absoluteMs());
  }
}

// Per-session single-flight: refresh rotation must never race itself, even
// across concurrent requests in one process (contract C5).
const refreshLocks = new Map<string, Promise<unknown>>();

export async function withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = refreshLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const settle = run.catch(() => undefined);
  refreshLocks.set(key, settle);
  try {
    return await run;
  } finally {
    // Remove only our own entry so a queued successor keeps its chain.
    void settle.then(() => {
      if (refreshLocks.get(key) === settle) refreshLocks.delete(key);
    });
  }
}
