import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getWorkspace, listWorkspaces, type WorkspaceDto } from "@promptbranch/team-server";
import { TEAM_SESSION_COOKIE } from "./env";
import { getTeamService, type TeamService } from "./service";
import type { HumanAuthContext } from "./auth";

/**
 * Authenticated server-rendering entrypoint. Server components resolve the
 * BFF cookie ONCE here and call the domain services directly — no loopback
 * HTTP to our own API and no second authorization implementation. Pages
 * redirect unauthenticated visitors to the sign-in flow; team surfaces are
 * additionally noindex via their layout metadata.
 */

export interface TeamPageSession {
  service: TeamService;
  auth: HumanAuthContext;
}

export async function getTeamPageSession(): Promise<TeamPageSession | null> {
  const service = getTeamService();
  if (!service) return null;
  const jar = await cookies();
  const token = jar.get(TEAM_SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const webSession = await service.sessions.resolveWebSession(token);
    return {
      service,
      auth: {
        kind: "human",
        userId: webSession.userId,
        sessionId: webSession.sessionId,
        authenticatedAt: webSession.authenticatedAt.toISOString(),
        via: "cookie",
        webSession,
      },
    };
  } catch {
    return null;
  }
}

export interface WorkspacePageContext {
  service: TeamService;
  auth: HumanAuthContext;
  workspace: WorkspaceDto;
}

/** Workspace-aware page guard: signed-in members only, fresh role each load. */
export async function requireWorkspacePage(workspaceId: string): Promise<WorkspacePageContext> {
  const session = await getTeamPageSession();
  if (!session) redirect("/team/auth/login");
  try {
    const workspace = await getWorkspace(session.service.pool, session.auth, workspaceId);
    return { ...session, workspace };
  } catch {
    // Not a member (or the workspace is gone): back to the picker, without
    // leaking which one it was.
    redirect("/team");
  }
}

/** Picker data for /team — the caller's active workspaces. */
export async function requireSignedIn(): Promise<TeamPageSession> {
  const session = await getTeamPageSession();
  if (!session) redirect("/team/auth/login");
  return session;
}

export async function listOwnWorkspaces(session: TeamPageSession): Promise<WorkspaceDto[]> {
  return listWorkspaces(session.service.pool, session.auth);
}
