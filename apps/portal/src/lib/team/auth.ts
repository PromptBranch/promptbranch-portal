import type { NextRequest } from "next/server";
import type { ResolvedWebSession, Scope } from "@promptbranch/team-server";
import { resolveAgentBearer, teamError } from "@promptbranch/team-server";
import { TEAM_SESSION_COOKIE } from "./env";
import type { TeamService } from "./service";

/**
 * Request authentication (contract C5). Exactly one mode per request:
 * a validated native Bearer access token, or the browser's opaque session
 * cookie. Supplying both is rejected. Both paths recheck account status and
 * session revocation in the database on every request — JWT expiry alone
 * never authorizes anything.
 */

export interface HumanAuthContext {
  kind: "human";
  userId: string;
  /** Application session id (team_sessions.id) — revocable, server-side. */
  sessionId: string;
  authenticatedAt: string;
  via: "bearer" | "cookie";
  /** Present for cookie-authenticated requests (mutations need CSRF). */
  webSession?: ResolvedWebSession;
}

export interface AgentAuthContext {
  kind: "agent";
  /** The owning member — agent authority is always scoped to a human. */
  userId: string;
  tokenId: string;
  scopes: Scope[];
  via: "bearer";
}

export type AuthContext = HumanAuthContext | AgentAuthContext;

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer" || !value) {
    throw teamError("UNAUTHENTICATED", "Authorization header must be a Bearer token");
  }
  return value.trim();
}

function sessionCookie(request: NextRequest): string | null {
  return request.cookies.get(TEAM_SESSION_COOKIE)?.value ?? null;
}

export async function authenticateRequest(
  service: TeamService,
  request: NextRequest,
): Promise<HumanAuthContext | AgentAuthContext> {
  const bearer = bearerToken(request);
  const cookie = sessionCookie(request);
  if (bearer && cookie) {
    throw teamError("UNAUTHENTICATED", "Send either a Bearer token or a session cookie, not both");
  }

  if (bearer) {
    if (bearer.startsWith("pbt_")) {
      const agent = await resolveAgentBearer(service.pool, bearer);
      return {
        kind: "agent",
        userId: agent.ownerUserId,
        tokenId: agent.principal.tokenId,
        scopes: agent.principal.scopes,
        via: "bearer",
      };
    }
    const access = await service.accessTokenValidator.validate(bearer);
    const user = await service.sessions.mapUser({
      issuer: access.issuer,
      subject: access.subject,
      email: access.email,
      displayName: access.email.split("@")[0] ?? "Team member",
    });
    const appSession = await service.sessions.resolveAppSession(
      {
        issuer: access.issuer,
        subject: access.subject,
        providerSessionId: access.sessionId,
        clientId: access.clientId,
      },
      user.userId,
    );
    return {
      kind: "human",
      userId: user.userId,
      sessionId: appSession.appSessionId,
      authenticatedAt: new Date(access.authenticatedAtMs).toISOString(),
      via: "bearer",
    };
  }

  if (cookie) {
    const webSession = await service.sessions.resolveWebSession(cookie);
    return {
      kind: "human",
      userId: webSession.userId,
      sessionId: webSession.sessionId,
      authenticatedAt: webSession.authenticatedAt.toISOString(),
      via: "cookie",
      webSession,
    };
  }

  throw teamError("UNAUTHENTICATED", "Authentication required");
}

/** Loads the user presentation row for /me without exposing hashes. */
export async function loadUserRow(
  service: TeamService,
  userId: string,
): Promise<{ id: string; displayName: string; email: string }> {
  const result = await service.pool.query<{ id: string; display_name: string; verified_email: string }>(
    "SELECT id, display_name, verified_email FROM team_users WHERE id = $1 AND disabled_at IS NULL AND deleted_at IS NULL",
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw teamError("UNAUTHENTICATED", "Account is disabled");
  return { id: row.id, displayName: row.display_name, email: row.verified_email };
}

export interface WorkspaceDto {
  id: string;
  name: string;
  role: "owner" | "maintainer" | "contributor" | "viewer";
  membershipGeneration: string;
  serverEpoch: string;
  entityVersion: number;
  updatedAt: string;
}

/** Active memberships of the user with fresh role/generation resolution. */
export async function listUserWorkspaces(service: TeamService, userId: string): Promise<WorkspaceDto[]> {
  const result = await service.pool.query<{
    id: string;
    name: string;
    role: WorkspaceDto["role"];
    generation: string;
    server_epoch: string;
    entity_version: number;
    updated_at: Date;
  }>(
    `SELECT w.id, w.name, m.role, m.generation, w.server_epoch, w.entity_version, w.updated_at
       FROM team_memberships m
       JOIN team_workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1 AND m.removed_at IS NULL AND w.deleted_at IS NULL
      ORDER BY w.updated_at DESC, w.id`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    membershipGeneration: row.generation,
    serverEpoch: row.server_epoch,
    entityVersion: row.entity_version,
    updatedAt: row.updated_at.toISOString(),
  }));
}
