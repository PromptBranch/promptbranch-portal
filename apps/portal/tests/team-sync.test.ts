import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as bootstrapRoute } from "@/app/api/team/v1/workspaces/[w]/bootstrap/route";
import { GET as bootstrapPageRoute } from "@/app/api/team/v1/workspaces/[w]/bootstrap/[s]/route";
import { GET as changesRoute } from "@/app/api/team/v1/workspaces/[w]/changes/route";
import { POST as commandsRoute } from "@/app/api/team/v1/workspaces/[w]/commands/route";
import { setupTeamTest, nativeClaims, TEST_ORIGIN, type TeamTestSetup } from "./team-test-setup";

// P5 over HTTP: bootstrap materializes and pages with signed tokens; the
// change stream serves grouped events after the highWater; generation and
// epoch rebinding is enforced on every sync call.

let setup: TeamTestSetup;

beforeAll(async () => {
  setup = await setupTeamTest();
});

afterAll(async () => {
  await setup.cleanup();
});

function request(path: string, options: { bearer?: string; method?: string; body?: unknown } = {}): NextRequest {
  const headers: Record<string, string> = { "x-promptbranch-team-protocol": "1" };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  return new NextRequest(`${TEST_ORIGIN}/api/team/v1/${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

describe("sync routes", () => {
  it("bootstraps, pages, and streams changes after the highWater", async () => {
    const owner = await setup.signToken(nativeClaims({}));
    const createResponse = await (
      await import("@/app/api/team/v1/workspaces/route")
    ).POST(
      new NextRequest(`${TEST_ORIGIN}/api/team/v1/workspaces`, {
        method: "POST",
        headers: { "x-promptbranch-team-protocol": "1", authorization: `Bearer ${owner}` },
        body: JSON.stringify({ commandId: randomUUID(), name: "Sync WS" }),
      }),
    );
    const workspace = ((await createResponse.json()) as { workspace: { id: string; serverEpoch: string; membershipGeneration: string } }).workspace;

    const command = async (operation: Record<string, unknown>) => {
      const response = await commandsRoute(
        new NextRequest(`${TEST_ORIGIN}/api/team/v1/workspaces/${workspace.id}/commands`, {
          method: "POST",
          headers: {
            "x-promptbranch-team-protocol": "1",
            authorization: `Bearer ${owner}`,
            "x-promptbranch-team-epoch": workspace.serverEpoch,
          },
          body: JSON.stringify({ commandId: randomUUID(), membershipGeneration: workspace.membershipGeneration, operation }),
        }),
        { params: Promise.resolve({ w: workspace.id }) },
      );
      return response;
    };

    await command({ type: "tag.create", name: "SyncTag" });
    await command({ type: "prompt.create", title: "Sync prompt", description: "", content: "sync approved body", tagIds: [], collectionIds: [], changeNote: "" });

    const bootstrap = await bootstrapRoute(
      request(`workspaces/${workspace.id}/bootstrap`, {
        bearer: owner,
        method: "POST",
        body: { membershipGeneration: workspace.membershipGeneration, serverEpoch: workspace.serverEpoch },
      }),
      { params: Promise.resolve({ w: workspace.id }) },
    );
    expect(bootstrap.status).toBe(201);
    const start = (await bootstrap.json()) as { snapshotId: string; highWater: string; expiresAt: string };

    // Reuse returns 200 with the same snapshot.
    const reuse = await bootstrapRoute(
      request(`workspaces/${workspace.id}/bootstrap`, {
        bearer: owner,
        method: "POST",
        body: { membershipGeneration: workspace.membershipGeneration, serverEpoch: workspace.serverEpoch },
      }),
      { params: Promise.resolve({ w: workspace.id }) },
    );
    expect(reuse.status).toBe(200);
    expect(((await reuse.json()) as { snapshotId: string }).snapshotId).toBe(start.snapshotId);

    const page = await bootstrapPageRoute(request(`workspaces/${workspace.id}/bootstrap/${start.snapshotId}`, { bearer: owner }), {
      params: Promise.resolve({ w: workspace.id, s: start.snapshotId }),
    });
    expect(page.status).toBe(200);
    const pageBody = (await page.json()) as { records: { entity: string }[]; highWater: string; nextPageToken: string | null };
    expect(pageBody.records.map((r) => r.entity).sort()).toEqual(["prompt", "revision", "tag"]);
    expect(pageBody.nextPageToken).toBeNull();

    // A new catalogue change streams after the highWater.
    const tagCommand = await command({ type: "tag.create", name: "AfterBootstrap" });
    const tagReceipt = (await tagCommand.json()) as { catalogSeq: string };
    expect(tagReceipt.catalogSeq).not.toBe("0");

    const changes = await changesRoute(
      request(`workspaces/${workspace.id}/changes?after=${start.highWater}&serverEpoch=${workspace.serverEpoch}&membershipGeneration=${workspace.membershipGeneration}`, { bearer: owner }),
      { params: Promise.resolve({ w: workspace.id }) },
    );
    expect(changes.status).toBe(200);
    const changeBody = (await changes.json()) as { changes: { seq: string; records: { entity: string }[]; tombstones: unknown[] }[]; nextCursor: string; hasMore: boolean };
    expect(changeBody.changes.map((c) => c.seq)).toEqual([tagReceipt.catalogSeq]);
    expect(changeBody.changes[0]!.records[0]!.entity).toBe("tag");
    expect(changeBody.nextCursor).toBe(tagReceipt.catalogSeq);
    expect(changeBody.hasMore).toBe(false);

    // Generation rebinding: a stale generation is MEMBERSHIP_CHANGED.
    const stale = await changesRoute(
      request(`workspaces/${workspace.id}/changes?after=${start.highWater}&serverEpoch=${workspace.serverEpoch}&membershipGeneration=${randomUUID()}`, { bearer: owner }),
      { params: Promise.resolve({ w: workspace.id }) },
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("MEMBERSHIP_CHANGED");

    // Future cursors are validation failures.
    const future = await changesRoute(
      request(`workspaces/${workspace.id}/changes?after=99999&serverEpoch=${workspace.serverEpoch}&membershipGeneration=${workspace.membershipGeneration}`, { bearer: owner }),
      { params: Promise.resolve({ w: workspace.id }) },
    );
    expect(future.status).toBe(422);
  });
});
