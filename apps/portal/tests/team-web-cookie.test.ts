import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getMe } from "@/app/api/team/v1/me/route";
import { DELETE as deleteSession } from "@/app/api/team/v1/sessions/[id]/route";
import { POST as logout } from "@/app/team/auth/logout/route";
import { getTeamService } from "@/lib/team/service";
import { setupTeamTest, TEST_ORIGIN, type TeamTestSetup } from "./team-test-setup";

// Browser (BFF) cookie auth: opaque __Host-pb-team cookie resolves the web
// session, mutations demand CSRF + same-origin, logout revokes server-side.

let setup: TeamTestSetup;

beforeAll(async () => {
  setup = await setupTeamTest();
});

afterAll(async () => {
  await setup.cleanup();
});

async function mintWebSession(email: string) {
  const service = getTeamService();
  if (!service) throw new Error("team service unavailable in test");
  const localPart = email.split("@")[0] ?? "member";
  const user = await service.sessions.mapUser({
    issuer: "http://127.0.0.1:48080/realms/promptbranch-dev",
    subject: `web-${localPart}`,
    email,
    displayName: localPart,
  });
  const app = await service.sessions.resolveAppSession(
    {
      issuer: "http://127.0.0.1:48080/realms/promptbranch-dev",
      subject: `web-${localPart}`,
      providerSessionId: `web-sid-${localPart}`,
      clientId: "promptbranch-web",
    },
    user.userId,
  );
  const web = await service.sessions.createWebSession({
    appSessionId: app.appSessionId,
    refreshToken: "stored-refresh",
    csrfToken: "csrf-secret",
  });
  return { service, user, app, web };
}

function cookieRequest(
  path: string,
  cookie: string,
  options: { method?: string; csrf?: string; origin?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {
    "x-promptbranch-team-protocol": "1",
    cookie: `__Host-pb-team=${cookie}`,
  };
  if (options.csrf) headers["x-pb-team-csrf"] = options.csrf;
  if (options.origin) headers.origin = options.origin;
  return new NextRequest(`${TEST_ORIGIN}/api/team/v1/${path}`, {
    method: options.method ?? "GET",
    headers,
  });
}

describe("cookie-authenticated /me", () => {
  it("resolves the opaque cookie to the signed-in user", async () => {
    const { web } = await mintWebSession("cookie@promptbranch.test");
    const response = await getMe(cookieRequest("me", web.token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { email: string } };
    expect(body.user.email).toBe("cookie@promptbranch.test");
  });

  it("rejects an expired web session and removes it", async () => {
    const { web } = await mintWebSession("expired@promptbranch.test");
    await setup.pool.query("UPDATE team_web_sessions SET expires_at = now() - interval '1 second'");
    const response = await getMe(cookieRequest("me", web.token));
    expect(response.status).toBe(401);
    const rows = await setup.pool.query("SELECT count(*)::int AS n FROM team_web_sessions");
    expect(rows.rows[0].n).toBe(1); // only the previous test's row remains
  });

  it("reports SESSION_REVOKED after the app session is revoked elsewhere", async () => {
    const { service, app, web } = await mintWebSession("revoked@promptbranch.test");
    await service.sessions.revokeUserSession(app.userId, app.appSessionId);
    const response = await getMe(cookieRequest("me", web.token));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SESSION_REVOKED");
  });
});

describe("CSRF protection on cookie mutations", () => {
  it("blocks cookie mutations without the CSRF token", async () => {
    const { web, app } = await mintWebSession("csrf1@promptbranch.test");
    const response = await deleteSession(
      cookieRequest(`sessions/${app.appSessionId}`, web.token, { method: "DELETE" }),
      { params: Promise.resolve({ id: app.appSessionId }) },
    );
    expect(response.status).toBe(401);
  });

  it("blocks a correct token with a foreign Origin", async () => {
    const { web, app } = await mintWebSession("csrf2@promptbranch.test");
    const response = await deleteSession(
      cookieRequest(`sessions/${app.appSessionId}`, web.token, {
        method: "DELETE",
        csrf: "csrf-secret",
        origin: "https://evil.example",
      }),
      { params: Promise.resolve({ id: app.appSessionId }) },
    );
    expect(response.status).toBe(401);
  });

  it("allows the token + same-origin combination and revokes the session", async () => {
    const { web, app } = await mintWebSession("csrf3@promptbranch.test");
    const response = await deleteSession(
      cookieRequest(`sessions/${app.appSessionId}`, web.token, {
        method: "DELETE",
        csrf: "csrf-secret",
        origin: TEST_ORIGIN,
      }),
      { params: Promise.resolve({ id: app.appSessionId }) },
    );
    expect(response.status).toBe(200);
    const after = await getMe(cookieRequest("me", web.token));
    expect(after.status).toBe(401);
  });
});

describe("POST /team/auth/logout", () => {
  it("requires CSRF and Origin, then clears the cookie and revokes server-side", async () => {
    const { web, app } = await mintWebSession("logout@promptbranch.test");

    const noCsrf = await logout(
      new NextRequest(`${TEST_ORIGIN}/team/auth/logout`, {
        method: "POST",
        headers: { cookie: `__Host-pb-team=${web.token}` },
      }),
    );
    expect(noCsrf.status).toBe(401);

    const wrongOrigin = await logout(
      new NextRequest(`${TEST_ORIGIN}/team/auth/logout`, {
        method: "POST",
        headers: {
          cookie: `__Host-pb-team=${web.token}`,
          "x-pb-team-csrf": "csrf-secret",
          origin: "https://evil.example",
        },
      }),
    );
    expect(wrongOrigin.status).toBe(401);
    // Both rejections leave the session usable.
    expect((await getMe(cookieRequest("me", web.token))).status).toBe(200);

    const ok = await logout(
      new NextRequest(`${TEST_ORIGIN}/team/auth/logout`, {
        method: "POST",
        headers: {
          cookie: `__Host-pb-team=${web.token}`,
          "x-pb-team-csrf": "csrf-secret",
          origin: TEST_ORIGIN,
        },
      }),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
    const cleared = ok.headers.getSetCookie().find((value) => value.startsWith("__Host-pb-team="));
    expect(cleared).toContain("Max-Age=0");

    const after = await getMe(cookieRequest("me", web.token));
    expect(after.status).toBe(401);
    // The logged-out web session row is gone entirely.
    const rows = await setup.pool.query<{ app: string }>(
      "SELECT app_session_id::text AS app FROM team_web_sessions WHERE app_session_id = $1",
      [app.appSessionId],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("is idempotent when already signed out", async () => {
    const response = await logout(
      new NextRequest(`${TEST_ORIGIN}/team/auth/logout`, { method: "POST" }),
    );
    expect(response.status).toBe(200);
  });
});
