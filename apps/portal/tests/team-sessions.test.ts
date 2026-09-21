import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getSessions } from "@/app/api/team/v1/sessions/route";
import { DELETE as deleteSession } from "@/app/api/team/v1/sessions/[id]/route";
import { POST as revokeAll } from "@/app/api/team/v1/sessions/revoke-all/route";
import { GET as getMe } from "@/app/api/team/v1/me/route";
import { setupTeamTest, nativeClaims, type TeamTestSetup } from "./team-test-setup";

let setup: TeamTestSetup;

beforeAll(async () => {
  setup = await setupTeamTest();
});

afterAll(async () => {
  await setup.cleanup();
});

function request(
  path: string,
  options: { bearer?: string; method?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { "x-promptbranch-team-protocol": "1" };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  return new NextRequest(`http://127.0.0.1:4317/api/team/v1/${path}`, {
    method: options.method ?? "GET",
    headers,
  });
}

describe("session management routes", () => {
  it("lists the caller's own sessions with client ids", async () => {
    const token = await setup.signToken(nativeClaims());
    const response = await getSessions(request("sessions", { bearer: token }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { id: string; clientId: string; createdAt: string; lastSeenAt: string; revokedAt: string | null }[];
      nextPageToken: string | null;
    };
    expect(body.nextPageToken).toBeNull();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((item) => item.clientId === "promptbranch-desktop")).toBe(true);
  });

  it("returns 404 (not 403) for a foreign session id", async () => {
    const token = await setup.signToken(nativeClaims());
    const foreign = await setup.signToken(
      nativeClaims({ sub: "other-sub", email: "other@promptbranch.test", sid: "other-sid" }),
    );
    await getSessions(request("sessions", { bearer: foreign }));
    const otherRow = await setup.pool.query<{ id: string }>(
      "SELECT s.id FROM team_sessions s JOIN team_users u ON u.id = s.user_id WHERE u.normalized_email = 'other@promptbranch.test'",
    );
    const response = await deleteSession(
      request(`sessions/${otherRow.rows[0]!.id}`, { bearer: token, method: "DELETE" }),
      { params: Promise.resolve({ id: otherRow.rows[0]!.id }) },
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("revoke-all invalidates the acting session immediately", async () => {
    const token = await setup.signToken(
      nativeClaims({ sub: "revoke-sub", email: "revoke@promptbranch.test", sid: "revoke-sid" }),
    );
    expect((await getMe(request("me", { bearer: token }))).status).toBe(200);

    const response = await revokeAll(request("sessions/revoke-all", { bearer: token, method: "POST" }));
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);

    const after = await getMe(request("me", { bearer: token }));
    expect(after.status).toBe(401);
    const body = (await after.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SESSION_REVOKED");
  });
});
