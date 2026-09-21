import { describe, it, expect, afterAll } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { randomBytes } from "node:crypto";
import { SecretBox, secretsMatch, sha256Bytes } from "../src/auth/crypto.js";
import { createAccessTokenValidator } from "../src/auth/oidc.js";
import {
  Sessions,
  withRefreshLock,
  WEB_SESSION_INACTIVITY_MS,
} from "../src/auth/sessions.js";
import { principalId } from "../src/auth/principal.js";
import { teamError } from "../src/errors.js";
import { createTeamTestHarness, DEV_ISSUER, type TeamTestHarness } from "./helpers.js";

const ISSUER = DEV_ISSUER;
const AUDIENCE = "promptbranch-team-api";
const NATIVE = "promptbranch-desktop";
const CLI = "promptbranch-cli";
const WEB = "promptbranch-web";

// ---------------------------------------------------------------------------
// SecretBox (refresh-token sealing)
// ---------------------------------------------------------------------------

describe("SecretBox", () => {
  it("round-trips secrets and reports its key id", () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.seal("refresh-token-value");
    expect(box.keyId).toBeTypeOf("string");
    expect(box.open(sealed).toString("utf8")).toBe("refresh-token-value");
  });

  it("round-trips the string form used for correlation cookies", () => {
    const box = SecretBox.fromBase64(Buffer.from(randomBytes(32)).toString("base64"));
    const blob = JSON.stringify({ state: "s", nonce: "n", verifier: "v" });
    expect(box.openFromString(box.sealToString(blob))).toBe(blob);
  });

  it("refuses to open a secret sealed under a different key", () => {
    const a = new SecretBox(randomBytes(32));
    const b = new SecretBox(randomBytes(32));
    expect(() => b.open(a.seal("secret"))).toThrow(/different encryption key/);
  });

  it("compares secrets in constant time without length leaks", () => {
    expect(secretsMatch(sha256Bytes("x"), sha256Bytes("x"))).toBe(true);
    expect(secretsMatch(sha256Bytes("x"), sha256Bytes("y"))).toBe(false);
    expect(secretsMatch("short", "a-much-longer-value")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Access-token validation (contract C5 negatives)
// ---------------------------------------------------------------------------

async function makeSigning() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwks = { keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] };
  // jose v6 SignJWT takes claims in the constructor; no fluent claim setters.
  const now = Math.floor(Date.now() / 1000);
  const sign = async (
    claims: Record<string, unknown>,
    options: { typ?: string; key?: CryptoKey } = {},
  ) =>
    new SignJWT({ iat: now, exp: now + 300, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key", ...(options.typ ? { typ: options.typ } : {}) })
      .sign(options.key ?? privateKey);
  return { jwks, sign, privateKey, publicKey };
}

describe("access token validation", () => {
  it("accepts a valid native access token", async () => {
    const { jwks, sign } = await makeSigning();
    const validator = createAccessTokenValidator({
      issuer: ISSUER,
      audience: AUDIENCE,
      allowedClients: [NATIVE, CLI],
      jwksJson: jwks,
    });
    const token = await sign({
      iss: ISSUER,
      sub: "alice-sub",
      aud: AUDIENCE,
      azp: NATIVE,
      sid: "session-1",
      email: "alice@promptbranch.test",
      email_verified: true,
      auth_time: Math.floor(Date.now() / 1000) - 60,
    });
    const result = await validator.validate(token);
    expect(result).toMatchObject({
      subject: "alice-sub",
      sessionId: "session-1",
      clientId: NATIVE,
      email: "alice@promptbranch.test",
    });
  });

  it("rejects wrong issuer, wrong audience, foreign azp, ID tokens, expired, unsigned-key and incomplete claims", async () => {
    const { jwks, sign, privateKey } = await makeSigning();
    const otherKey = await generateKeyPair("RS256");
    const validator = createAccessTokenValidator({
      issuer: ISSUER,
      audience: AUDIENCE,
      allowedClients: [NATIVE, CLI],
      jwksJson: jwks,
    });
    const base = {
      iss: ISSUER,
      sub: "alice-sub",
      aud: AUDIENCE,
      azp: NATIVE,
      sid: "session-1",
      email: "alice@promptbranch.test",
      email_verified: true,
    };
    const cases: Array<[string, Promise<string>]> = [
      ["wrong issuer", sign({ ...base, iss: "http://evil.example/realms/other" })],
      ["wrong audience", sign({ ...base, aud: "some-other-api" })],
      ["web client azp", sign({ ...base, azp: WEB })],
      ["unknown azp", sign({ ...base, azp: "rogue-client" })],
      ["missing sid", sign({ ...base, sid: undefined })],
      ["unverified email", sign({ ...base, email_verified: false })],
      ["missing email", sign({ ...base, email: undefined })],
      ["missing sub", sign({ ...base, sub: undefined })],
      ["ID token typ", sign(base, { typ: "ID" })],
      ["expired", sign({ ...base, exp: Math.floor(Date.now() / 1000) - 3600 })],
      ["wrong signing key", new SignJWT(base)
        .setProtectedHeader({ alg: "RS256" })
        .sign(otherKey.privateKey)],
    ];
    for (const [label, tokenPromise] of cases) {
      await expect(validator.validate(await tokenPromise), label).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
    }
  });

  it("accepts session_state as the legacy sid claim", async () => {
    const { jwks, sign } = await makeSigning();
    const validator = createAccessTokenValidator({
      issuer: ISSUER,
      audience: AUDIENCE,
      allowedClients: [NATIVE, CLI],
      jwksJson: jwks,
    });
    const token = await sign({
      iss: ISSUER,
      sub: "s",
      aud: AUDIENCE,
      azp: CLI,
      session_state: "legacy-sid",
      email: "s@promptbranch.test",
      email_verified: true,
      iat: Math.floor(Date.now() / 1000),
    });
    expect((await validator.validate(token)).sessionId).toBe("legacy-sid");
  });
});

// ---------------------------------------------------------------------------
// Sessions against real PostgreSQL
// ---------------------------------------------------------------------------

const harnesses: TeamTestHarness[] = [];
async function makeHarness() {
  const harness = await createTeamTestHarness();
  harnesses.push(harness);
  return harness;
}
afterAll(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

function aliceCtx(sid = "provider-sid-1", clientId = NATIVE) {
  return { issuer: ISSUER, subject: "alice-sub", providerSessionId: sid, clientId };
}

describe("account mapping", () => {
  it("maps by (issuer, sub) — never by email — and updates presentation", async () => {
    const h = await makeHarness();
    const sessions = new Sessions(h.pool, new SecretBox(randomBytes(32)));
    const first = await sessions.mapUser({
      issuer: ISSUER,
      subject: "alice-sub",
      email: "Alice@PromptBranch.test",
      displayName: "Alice",
    });
    // Same sub, changed email case + display name → same account, updated.
    const second = await sessions.mapUser({
      issuer: ISSUER,
      subject: "alice-sub",
      email: "alice@promptbranch.test",
      displayName: "Alice Synthetic",
    });
    expect(second.userId).toBe(first.userId);
    expect(second.displayName).toBe("Alice Synthetic");
    // Same email, DIFFERENT subject → a different account (no email linking).
    const stranger = await sessions.mapUser({
      issuer: ISSUER,
      subject: "alice-lookalike",
      email: "alice@promptbranch.test",
      displayName: "Lookalike",
    });
    expect(stranger.userId).not.toBe(first.userId);
    // Different issuer, same subject → different account.
    const otherIdp = await sessions.mapUser({
      issuer: "http://127.0.0.1:48080/realms/other",
      subject: "alice-sub",
      email: "alice@promptbranch.test",
      displayName: "Alice",
    });
    expect(otherIdp.userId).not.toBe(first.userId);
  });

  it("rejects disabled accounts on every request", async () => {
    const h = await makeHarness();
    const sessions = new Sessions(h.pool, new SecretBox(randomBytes(32)));
    const user = await sessions.mapUser({
      issuer: ISSUER,
      subject: "bob-sub",
      email: "bob@promptbranch.test",
      displayName: "Bob",
    });
    await h.pool.query("UPDATE team_users SET disabled_at = now() WHERE id = $1", [user.userId]);
    await expect(
      sessions.mapUser({ issuer: ISSUER, subject: "bob-sub", email: "bob@promptbranch.test", displayName: "Bob" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("application sessions", () => {
  it("creates on first validated login and reuses the row afterwards", async () => {
    const h = await makeHarness();
    const sessions = new Sessions(h.pool, new SecretBox(randomBytes(32)));
    const user = await sessions.mapUser({
      issuer: ISSUER,
      subject: "casey-sub",
      email: "casey@promptbranch.test",
      displayName: "Casey",
    });
    const ctx = aliceCtx("casey-sid", NATIVE);
    const first = await sessions.resolveAppSession(ctx, user.userId);
    const second = await sessions.resolveAppSession(ctx, user.userId);
    expect(second.appSessionId).toBe(first.appSessionId);
    expect(await h.count("team_sessions")).toBe(1);
  });

  it("never auto-registers a revoked session key", async () => {
    const h = await makeHarness();
    const sessions = new Sessions(h.pool, new SecretBox(randomBytes(32)));
    const user = await sessions.mapUser({
      issuer: ISSUER,
      subject: "dana-sub",
      email: "dana@promptbranch.test",
      displayName: "Dana",
    });
    const ctx = aliceCtx("dana-sid", CLI);
    const created = await sessions.resolveAppSession(ctx, user.userId);
    await sessions.revokeUserSession(user.userId, created.appSessionId);
    // Same (issuer, sid, client, user) coming back after revocation is
    // rejected — the IdP must mint a NEW sid for a fresh sign-in.
    await expect(sessions.resolveAppSession(ctx, user.userId)).rejects.toMatchObject({
      code: "SESSION_REVOKED",
    });
    // A new provider sid registers cleanly.
    const fresh = await sessions.resolveAppSession(aliceCtx("dana-sid-2", CLI), user.userId);
    expect(fresh.appSessionId).not.toBe(created.appSessionId);
    expect(await h.count("team_sessions")).toBe(2);
  });
});

describe("web sessions", () => {
  it("stores only hashes; cookie resolves with CSRF and decryptable refresh", async () => {
    const h = await makeHarness();
    const box = new SecretBox(randomBytes(32));
    const sessions = new Sessions(h.pool, box);
    const user = await sessions.mapUser({
      issuer: ISSUER,
      subject: "erin-sub",
      email: "erin@promptbranch.test",
      displayName: "Erin",
    });
    const app = await sessions.resolveAppSession(aliceCtx("erin-sid", WEB), user.userId);
    const created = await sessions.createWebSession({
      appSessionId: app.appSessionId,
      refreshToken: "provider-refresh-secret",
      csrfToken: "csrf-token-value",
    });

    const resolved = await sessions.resolveWebSession(created.token);
    expect(resolved.userId).toBe(user.userId);
    expect(resolved.email).toBe("erin@promptbranch.test");
    expect(resolved.decryptRefreshToken()).toBe("provider-refresh-secret");
    expect(sessions.csrfMatches(resolved, "csrf-token-value")).toBe(true);
    expect(sessions.csrfMatches(resolved, "wrong")).toBe(false);

    // Raw cookie value and refresh secret never appear at rest.
    const rows = await h.pool.query<{ token_hash: Buffer; encrypted_refresh: Buffer }>(
      "SELECT token_hash, encrypted_refresh FROM team_web_sessions",
    );
    expect(rows.rows.length).toBe(1);
    const rawToken = Buffer.from(created.token, "utf8");
    expect(rows.rows[0]!.token_hash.equals(sha256Bytes(created.token))).toBe(true);
    expect(rows.rows[0]!.token_hash.equals(rawToken)).toBe(false);
    expect(rows.rows[0]!.encrypted_refresh.toString("utf8")).not.toContain("provider-refresh-secret");
    // Wrong cookie value → generic unauthenticated, no existence leak.
    await expect(sessions.resolveWebSession("forged")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("enforces sliding inactivity and absolute lifetimes", async () => {
    const h = await makeHarness();
    const box = new SecretBox(randomBytes(32));
    // Short windows so expiry paths are exercisable without waiting.
    const sessions = new Sessions(h.pool, box, { inactivityMs: 60_000, absoluteMs: 120_000 });
    const user = await sessions.mapUser({
      issuer: ISSUER,
      subject: "short-sub",
      email: "short@promptbranch.test",
      displayName: "Short",
    });
    const app = await sessions.resolveAppSession(aliceCtx("short-sid", WEB), user.userId);
    const created = await sessions.createWebSession({
      appSessionId: app.appSessionId,
      refreshToken: null,
      csrfToken: "c",
    });
    await expect(sessions.resolveWebSession(created.token)).resolves.toBeTruthy();

    // Age past the inactivity window: expired regardless of activity.
    await h.pool.query("UPDATE team_web_sessions SET expires_at = now() - interval '1 second'");
    await expect(sessions.resolveWebSession(created.token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await h.count("team_web_sessions")).toBe(0);

    // Absolute cap: a session whose app session is older than the absolute
    // window is rejected even with a far-future sliding expiry.
    const app2 = await sessions.resolveAppSession(aliceCtx("short-sid-2", WEB), user.userId);
    const created2 = await sessions.createWebSession({
      appSessionId: app2.appSessionId,
      refreshToken: null,
      csrfToken: "c",
    });
    await h.pool.query("UPDATE team_sessions SET created_at = now() - interval '1 hour' WHERE id = $1", [
      app2.appSessionId,
    ]);
    await expect(sessions.resolveWebSession(created2.token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects the web cookie once the app session is revoked", async () => {
    const h = await makeHarness();
    const sessions = new Sessions(h.pool, new SecretBox(randomBytes(32)));
    const user = await sessions.mapUser({
      issuer: ISSUER,
      subject: "revoke-sub",
      email: "revoke@promptbranch.test",
      displayName: "Revoke",
    });
    const app = await sessions.resolveAppSession(aliceCtx("revoke-sid", WEB), user.userId);
    const created = await sessions.createWebSession({
      appSessionId: app.appSessionId,
      refreshToken: null,
      csrfToken: "c",
    });
    await sessions.revokeUserSession(user.userId, app.appSessionId);
    await expect(sessions.resolveWebSession(created.token)).rejects.toMatchObject({ code: "SESSION_REVOKED" });
  });

  it("logout drops the cookie row and revokes the app session", async () => {
    const h = await makeHarness();
    const sessions = new Sessions(h.pool, new SecretBox(randomBytes(32)));
    const user = await sessions.mapUser({
      issuer: ISSUER,
      subject: "logout-sub",
      email: "logout@promptbranch.test",
      displayName: "Logout",
    });
    const app = await sessions.resolveAppSession(aliceCtx("logout-sid", WEB), user.userId);
    const created = await sessions.createWebSession({
      appSessionId: app.appSessionId,
      refreshToken: "r",
      csrfToken: "c",
    });
    expect(await sessions.revokeWebSessionByToken(created.token)).toBe(true);
    expect(await h.count("team_web_sessions")).toBe(0);
    const row = await h.pool.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM team_sessions WHERE id = $1",
      [app.appSessionId],
    );
    expect(row.rows[0]!.revoked_at).not.toBeNull();
  });
});

describe("session management endpoints' backing store", () => {
  it("lists, revokes one own session (404 for foreign) and revoke-all", async () => {
    const h = await makeHarness();
    const sessions = new Sessions(h.pool, new SecretBox(randomBytes(32)));
    const user = await sessions.mapUser({
      issuer: ISSUER,
      subject: "list-sub",
      email: "list@promptbranch.test",
      displayName: "List",
    });
    const other = await sessions.mapUser({
      issuer: ISSUER,
      subject: "other-sub",
      email: "other@promptbranch.test",
      displayName: "Other",
    });
    const a = await sessions.resolveAppSession(aliceCtx("list-sid-a", NATIVE), user.userId);
    const b = await sessions.resolveAppSession(aliceCtx("list-sid-b", CLI), user.userId);
    await sessions.resolveAppSession(aliceCtx("other-sid", NATIVE), other.userId);

    const list = await sessions.listUserSessions(user.userId);
    expect(list).toHaveLength(2);
    expect(list.every((entry) => entry.revokedAt === null)).toBe(true);

    // Foreign session ids are indistinguishable from missing ones.
    const foreign = await sessions.resolveAppSession(aliceCtx("other-sid", NATIVE), other.userId);
    await expect(sessions.revokeUserSession(user.userId, foreign.appSessionId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await sessions.revokeUserSession(user.userId, a.appSessionId);
    const afterOne = await sessions.listUserSessions(user.userId);
    expect(afterOne.find((entry) => entry.id === a.appSessionId)?.revokedAt).toBeTruthy();
    expect(afterOne.find((entry) => entry.id === b.appSessionId)?.revokedAt).toBeNull();

    const revokedCount = await sessions.revokeAllUserSessions(user.userId);
    expect(revokedCount).toBe(1); // only b was still active
    expect((await sessions.listUserSessions(user.userId)).every((entry) => entry.revokedAt)).toBe(true);
    expect((await sessions.listUserSessions(other.userId)).every((entry) => entry.revokedAt === null)).toBe(true);
  });
});

describe("account deletion", () => {
  it("requires fresh login, matching email, and no sole-owned workspace", async () => {
    const h = await makeHarness();
    const sessions = new Sessions(h.pool, new SecretBox(randomBytes(32)));
    const user = await sessions.mapUser({
      issuer: ISSUER,
      subject: "del-sub",
      email: "del@promptbranch.test",
      displayName: "Del",
    });
    const app = await sessions.resolveAppSession(aliceCtx("del-sid", WEB), user.userId);

    // Not fresh: app session created "an hour ago".
    await h.pool.query("UPDATE team_sessions SET created_at = now() - interval '1 hour' WHERE id = $1", [
      app.appSessionId,
    ]);
    await expect(
      sessions.deleteAccount({ userId: user.userId, appSessionId: app.appSessionId, confirmEmail: "del@promptbranch.test", freshWindowMs: 10 * 60_000 }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    // Fresh again.
    await h.pool.query("UPDATE team_sessions SET created_at = now() WHERE id = $1", [app.appSessionId]);
    await expect(
      sessions.deleteAccount({ userId: user.userId, appSessionId: app.appSessionId, confirmEmail: "wrong@promptbranch.test", freshWindowMs: 10 * 60_000 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // Sole owner → LAST_OWNER.
    const w = await h.createWorkspace("Sole Owned", user.userId);
    await expect(
      sessions.deleteAccount({ userId: user.userId, appSessionId: app.appSessionId, confirmEmail: "del@promptbranch.test", freshWindowMs: 10 * 60_000 }),
    ).rejects.toMatchObject({ code: "LAST_OWNER" });

    // A second owner unlocks deletion.
    const coOwner = await sessions.mapUser({
      issuer: ISSUER,
      subject: "co-sub",
      email: "co@promptbranch.test",
      displayName: "Co",
    });
    await h.pool.query(
      `INSERT INTO team_memberships (workspace_id, user_id, role, generation)
       VALUES ($1, $2, 'owner', gen_random_uuid())`,
      [w.workspaceId, coOwner.userId],
    );
    await sessions.deleteAccount({
      userId: user.userId,
      appSessionId: app.appSessionId,
      confirmEmail: "Del@PromptBranch.Test", // normalized comparison
      freshWindowMs: 10 * 60_000,
    });

    const after = await h.pool.query<{ disabled_at: Date | null; deleted_at: Date | null }>(
      "SELECT disabled_at, deleted_at FROM team_users WHERE id = $1",
      [user.userId],
    );
    expect(after.rows[0]!.disabled_at).not.toBeNull();
    expect(after.rows[0]!.deleted_at).not.toBeNull();
    expect((await sessions.listUserSessions(user.userId)).every((entry) => entry.revokedAt)).toBe(true);
    await expect(
      sessions.mapUser({ issuer: ISSUER, subject: "del-sub", email: "del@promptbranch.test", displayName: "Del" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("refresh single-flight", () => {
  it("serializes concurrent refreshes per session while other keys proceed", async () => {
    const order: string[] = [];
    const slow = (key: string, ms: number) =>
      withRefreshLock(key, async () => {
        order.push(`start:${key}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`end:${key}`);
        return key;
      });

    const [a1, a2, b] = await Promise.all([slow("session-a", 60), slow("session-a", 10), slow("session-b", 30)]);
    expect([a1, a2, b]).toEqual(["session-a", "session-a", "session-b"]);
    // Same key never interleaves; different keys may.
    expect(order.indexOf("end:session-a")).toBeLessThan(order.lastIndexOf("start:session-a") + 1);
    const aStarts = order.filter((entry) => entry === "start:session-a").length;
    expect(aStarts).toBe(2);
  });
});

describe("principal identity", () => {
  it("derives server-authored principal ids for humans and agents", () => {
    expect(
      principalId({ kind: "human", userId: "u1", sessionId: "s1", authenticatedAt: new Date().toISOString() }),
    ).toBe("human:u1");
    expect(principalId({ kind: "agent", userId: "u1", tokenId: "t1", scopes: ["catalog:read"] })).toBe("agent:t1");
    expect(WEB_SESSION_INACTIVITY_MS).toBe(24 * 60 * 60 * 1000);
    expect(teamError("SESSION_REVOKED", "x").httpStatus).toBe(401);
  });
});
