import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as listPromptsRoute } from "@/app/api/team/v1/workspaces/[w]/prompts/route";
import { GET as promptDetailRoute } from "@/app/api/team/v1/workspaces/[w]/prompts/[p]/route";
import { GET as revisionsRoute } from "@/app/api/team/v1/workspaces/[w]/prompts/[p]/revisions/route";
import { GET as revisionRoute } from "@/app/api/team/v1/workspaces/[w]/revisions/[r]/route";
import { GET as tagsRoute } from "@/app/api/team/v1/workspaces/[w]/tags/route";
import { GET as proposalsRoute } from "@/app/api/team/v1/workspaces/[w]/proposals/route";
import { GET as proposalDetailRoute } from "@/app/api/team/v1/workspaces/[w]/proposals/[p]/route";
import { setupTeamTest, nativeClaims, TEST_ORIGIN, type TeamTestSetup } from "./team-test-setup";

// P4 catalogue surfaces over real HTTP handlers: members browse approved
// content, viewers are refused on collaboration surfaces, and candidate
// content never appears outside proposal detail.

let setup: TeamTestSetup;

beforeAll(async () => {
  setup = await setupTeamTest();
});

afterAll(async () => {
  await setup.cleanup();
});

function request(path: string, options: { bearer?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "x-promptbranch-team-protocol": "1" };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  return new NextRequest(`${TEST_ORIGIN}/api/team/v1/${path}`, { headers });
}

async function bearer(sub: string): Promise<string> {
  return setup.signToken(nativeClaims({ sub: `${sub}-sub`, sid: `${sub}-sid`, email: `${sub}@promptbranch.test` }));
}

interface WorkspaceDto {
  id: string;
  serverEpoch: string;
  membershipGeneration: string;
  entityVersion: number;
}

interface Fixtures {
  owner: string;
  viewer: string;
  contributor: string;
  workspace: WorkspaceDto;
  promptId: string;
  headRevisionId: string;
  candidateRevisionId: string;
  proposalId: string;
}

async function fixtures(): Promise<Fixtures> {
  const owner = await bearer("p4owner");
  const create = await setup.signToken(nativeClaims({}));
  const createResponse = await (
    await import("@/app/api/team/v1/workspaces/route")
  ).POST(
    new NextRequest(`${TEST_ORIGIN}/api/team/v1/workspaces`, {
      method: "POST",
      headers: { "x-promptbranch-team-protocol": "1", authorization: `Bearer ${create}` },
      body: JSON.stringify({ commandId: randomUUID(), name: "P4 Catalogue WS" }),
    }),
  );
  const workspace = ((await createResponse.json()) as { workspace: WorkspaceDto }).workspace;

  const seedResponse = await (
    await import("@/app/api/team/v1/workspaces/[w]/commands/route")
  ).POST(
    new NextRequest(`${TEST_ORIGIN}/api/team/v1/workspaces/${workspace.id}/commands`, {
      method: "POST",
      headers: {
        "x-promptbranch-team-protocol": "1",
        authorization: `Bearer ${create}`,
        "x-promptbranch-team-epoch": workspace.serverEpoch,
      },
      body: JSON.stringify({
        commandId: randomUUID(),
        membershipGeneration: workspace.membershipGeneration,
        operation: { type: "prompt.create", title: "Approved HTTP prompt", description: "", content: "approved http body", tagIds: [], collectionIds: [], changeNote: "" },
      }),
    }),
    { params: Promise.resolve({ w: workspace.id }) },
  );
  expect(seedResponse.status).toBe(200);
  const promptId = ((await seedResponse.json()) as { result: { id: string } }).result.id;
  const headRow = await setup.pool.query<{ approved_revision_id: string }>(
    "SELECT approved_revision_id FROM team_prompts WHERE id = $1",
    [promptId],
  );

  // Add a contributor and a viewer.
  for (const [sub, role] of [["p4contrib", "contributor"], ["p4viewer", "viewer"]] as const) {
    const userRow = await setup.pool.query<{ id: string }>(
      `INSERT INTO team_users (issuer, subject, verified_email, normalized_email, display_name)
       VALUES ('http://127.0.0.1:48080/realms/promptbranch-dev', $1, $2, $2, $3)
       ON CONFLICT (issuer, subject) DO UPDATE SET verified_email = EXCLUDED.verified_email
       RETURNING id`,
      [`${sub}-sub`, `${sub}@promptbranch.test`, sub],
    );
    await setup.pool.query(
      `INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, $3, gen_random_uuid())`,
      [workspace.id, userRow.rows[0]!.id, role],
    );
  }

  // Contributor submits a candidate.
  const contributor = await bearer("p4contrib");
  const submitResponse = await (
    await import("@/app/api/team/v1/workspaces/[w]/commands/route")
  ).POST(
    new NextRequest(`${TEST_ORIGIN}/api/team/v1/workspaces/${workspace.id}/commands`, {
      method: "POST",
      headers: {
        "x-promptbranch-team-protocol": "1",
        authorization: `Bearer ${contributor}`,
        "x-promptbranch-team-epoch": workspace.serverEpoch,
      },
      body: JSON.stringify({
        commandId: randomUUID(),
        membershipGeneration: await generationFor("p4contrib", workspace.id),
        operation: { type: "proposal.submit", promptId, baseRevisionId: headRow.rows[0]!.approved_revision_id, content: "http-candidate-secret-marker", rationale: "http flow", supersedesProposalId: null },
      }),
    }),
    { params: Promise.resolve({ w: workspace.id }) },
  );
  expect(submitResponse.status).toBe(200);
  const proposalId = ((await submitResponse.json()) as { result: { id: string } }).result.id;
  const candidateRow = await setup.pool.query<{ candidate_revision_id: string }>(
    "SELECT candidate_revision_id FROM team_proposals WHERE id = $1",
    [proposalId],
  );

  return {
    owner,
    viewer: await bearer("p4viewer"),
    contributor,
    workspace,
    promptId,
    headRevisionId: headRow.rows[0]!.approved_revision_id!,
    candidateRevisionId: candidateRow.rows[0]!.candidate_revision_id,
    proposalId,
  };
}

async function generationFor(sub: string, workspaceId: string): Promise<string> {
  const row = await setup.pool.query<{ generation: string }>(
    `SELECT m.generation FROM team_memberships m JOIN team_users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND u.subject = $2`,
    [workspaceId, `${sub}-sub`],
  );
  return row.rows[0]!.generation;
}

describe("catalogue read authorization over HTTP", () => {
  it("members browse approved prompts; viewers are refused on collaboration surfaces; candidates stay invisible", async () => {
    const f = await fixtures();

    // Viewer browses the catalogue…
    const browse = await listPromptsRoute(request(`workspaces/${f.workspace.id}/prompts?q=http`, { bearer: f.viewer }), {
      params: Promise.resolve({ w: f.workspace.id }),
    });
    expect(browse.status).toBe(200);
    const body = (await browse.json()) as { items: { id: string }[] };
    expect(body.items.some((p) => p.id === f.promptId)).toBe(true);
    // …and cannot find candidate strings through search.
    const candidateSearch = await listPromptsRoute(request(`workspaces/${f.workspace.id}/prompts?q=http-candidate-secret-marker`, { bearer: f.viewer }), {
      params: Promise.resolve({ w: f.workspace.id }),
    });
    expect(((await candidateSearch.json()) as { items: unknown[] }).items).toHaveLength(0);

    const detail = await promptDetailRoute(request(`workspaces/${f.workspace.id}/prompts/${f.promptId}`, { bearer: f.viewer }), {
      params: Promise.resolve({ w: f.workspace.id, p: f.promptId }),
    });
    expect(detail.status).toBe(200);
    expect(JSON.stringify(await detail.json())).not.toContain("http-candidate-secret-marker");

    const history = await revisionsRoute(request(`workspaces/${f.workspace.id}/prompts/${f.promptId}/revisions`, { bearer: f.viewer }), {
      params: Promise.resolve({ w: f.workspace.id, p: f.promptId }),
    });
    expect(history.status).toBe(200);
    expect(((await history.json()) as { items: unknown[] }).items).toHaveLength(1);

    // The candidate revision id is NOT fetchable on the exact-revision route.
    const candidateFetch = await revisionRoute(request(`workspaces/${f.workspace.id}/revisions/${f.candidateRevisionId}`, { bearer: f.viewer }), {
      params: Promise.resolve({ w: f.workspace.id, r: f.candidateRevisionId }),
    });
    expect(candidateFetch.status).toBe(404);
    const publishedFetch = await revisionRoute(request(`workspaces/${f.workspace.id}/revisions/${f.headRevisionId}`, { bearer: f.viewer }), {
      params: Promise.resolve({ w: f.workspace.id, r: f.headRevisionId }),
    });
    expect(publishedFetch.status).toBe(200);

    // Tags readable by members.
    const tags = await tagsRoute(request(`workspaces/${f.workspace.id}/tags`, { bearer: f.viewer }), {
      params: Promise.resolve({ w: f.workspace.id }),
    });
    expect(tags.status).toBe(200);

    // Collaboration surfaces refuse viewers.
    const proposals = await proposalsRoute(request(`workspaces/${f.workspace.id}/proposals`, { bearer: f.viewer }), {
      params: Promise.resolve({ w: f.workspace.id }),
    });
    expect(proposals.status).toBe(403);
    expect(((await proposals.json()) as { error: { code: string } }).error.code).toBe("ROLE_FORBIDDEN");

    // Contributors see the proposal; the detail is where candidates live.
    const contributorProposals = await proposalsRoute(request(`workspaces/${f.workspace.id}/proposals`, { bearer: f.contributor }), {
      params: Promise.resolve({ w: f.workspace.id }),
    });
    expect(contributorProposals.status).toBe(200);
    const detailResponse = await proposalDetailRoute(request(`workspaces/${f.workspace.id}/proposals/${f.proposalId}`, { bearer: f.contributor }), {
      params: Promise.resolve({ w: f.workspace.id, p: f.proposalId }),
    });
    expect(detailResponse.status).toBe(200);
    expect(JSON.stringify(await detailResponse.json())).toContain("http-candidate-secret-marker");

    // Foreign workspace members get 404 for nested ids, generic 403 for the workspace.
    const outsider = await bearer("p4outsider");
    const foreignDetail = await promptDetailRoute(request(`workspaces/${f.workspace.id}/prompts/${f.promptId}`, { bearer: outsider }), {
      params: Promise.resolve({ w: f.workspace.id, p: f.promptId }),
    });
    expect(foreignDetail.status).toBe(403);
    void f.owner;
  });
});
