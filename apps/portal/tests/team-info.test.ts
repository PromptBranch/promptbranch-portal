import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/team/v1/info/route";

// /info is public discovery: no auth, no protocol header, no secrets
// (contract C4). Headers must follow the private no-store conventions.

let cleanup: () => Promise<void>;

beforeAll(async () => {
  const setup = await import("./team-test-setup");
  const instance = await setup.setupTeamTest();
  cleanup = instance.cleanup;
});

afterAll(async () => {
  await cleanup();
});

function infoRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1:4317/api/team/v1/info");
}

describe("GET /api/team/v1/info", () => {
  it("returns protocol, contract version, features, clients and exact limits", async () => {
    const response = await GET(infoRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.protocol).toBe(1);
    expect(body.contractVersion).toBe("1.0.0");
    expect(body.issuer).toBe("http://127.0.0.1:48080/realms/promptbranch-dev");
    expect(body.nativeClientId).toBe("promptbranch-desktop");
    expect(body.cliClientId).toBe("promptbranch-cli");
    expect(body.audience).toBe("promptbranch-team-api");
    expect(body.serverId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.serverEpoch).toMatch(/^[0-9a-f-]{36}$/);
    expect((body.features as string[]).sort()).toEqual([
      "agent-token-v1",
      "catalog-v1",
      "changes-v1",
      "review-v1",
    ]);
    expect(body.limits).toEqual({
      maxRequestBytes: 262144,
      maxResponsePageBytes: 524288,
      maxContentBytes: 65536,
      maxPageSize: 100,
      maxMembers: 50,
      maxPrompts: 5000,
      maxPublishedContentBytes: 209715200,
      maxProposals: 50000,
      maxActiveTokensPerMember: 20,
    });
  });

  it("applies the team wire conventions to every response", async () => {
    const response = await GET(infoRequest());
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie, Authorization");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("fails closed with 503 when the team feature is disabled", async () => {
    process.env.TEAM_ENABLED = "false";
    try {
      const response = await GET(infoRequest());
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNAVAILABLE");
    } finally {
      delete process.env.TEAM_ENABLED;
    }
  });
});
