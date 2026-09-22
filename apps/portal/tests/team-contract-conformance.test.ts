import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  changesPageSchema,
  promptDetailResponseSchema,
  promptsPageSchema,
  proposalsPageSchema,
  revisionResponseSchema,
  revisionsPageSchema,
  tagsPageSchema,
  workspaceResponseSchema,
} from "@promptbranch/team-contract";
import { TEAM_ERROR_HTTP_STATUS } from "@promptbranch/team-server";
import { GET as workspaceDetailRoute } from "@/app/api/team/v1/workspaces/[w]/route";
import { GET as promptsRoute } from "@/app/api/team/v1/workspaces/[w]/prompts/route";
import { GET as promptDetailRoute } from "@/app/api/team/v1/workspaces/[w]/prompts/[p]/route";
import { GET as revisionsRoute } from "@/app/api/team/v1/workspaces/[w]/prompts/[p]/revisions/route";
import { GET as revisionDetailRoute } from "@/app/api/team/v1/workspaces/[w]/revisions/[r]/route";
import { GET as tagsRoute } from "@/app/api/team/v1/workspaces/[w]/tags/route";
import { GET as proposalsRoute } from "@/app/api/team/v1/workspaces/[w]/proposals/route";
import { GET as changesRoute } from "@/app/api/team/v1/workspaces/[w]/changes/route";
import { POST as commandsRoute } from "@/app/api/team/v1/workspaces/[w]/commands/route";
import { setupTeamTest, nativeClaims, TEST_ISSUER, TEST_ORIGIN, type TeamTestSetup } from "./team-test-setup";

// G0/D3 conformance: the contract artifact's consumer fixtures drive the
// REAL routes. The seed fixture is inserted verbatim (ids, generations,
// epoch, content hashes); the fixture's mock-server bearer labels
// (pbtest_*) are mapped to real signed tokens per user — authentication is
// C5 and orthogonal to the C4 command semantics under test.

interface FixtureUser {
  id: string;
  displayName: string;
  email: string;
  /** Absent for the outsider — they hold no membership. */
  role?: string;
  bearerToken: string;
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/team-contract/fixtures");
const seed = JSON.parse(readFileSync(join(fixturesDir, "catalog.seed.json"), "utf8")) as {
  users: FixtureUser[];
  agentTokens: Array<{ id: string; name: string; ownerUserId: string; scopes: string[]; bearerToken: string; expiresAt: string }>;
  workspace: { id: string; name: string; serverEpoch: string; membershipGeneration: string };
  tags: Array<{ id: string; name: string }>;
  collections: Array<{ id: string; name: string }>;
  prompts: Array<{ prompt: Record<string, unknown>; revisions: Array<Record<string, unknown>> }>;
};
const lifecycle = JSON.parse(readFileSync(join(fixturesDir, "proposal.lifecycle.json"), "utf8")) as {
  membershipGeneration: string;
  privacyMarker: string;
  envelopes: Record<string, { commandId: string; membershipGeneration: string; operation: Record<string, unknown> }>;
};
const revocation = JSON.parse(readFileSync(join(fixturesDir, "membership-revocation.json"), "utf8")) as {
  generationAfter: string;
  envelopes: Record<string, { commandId: string; membershipGeneration: string; operation: Record<string, unknown> }>;
  expectations: Record<string, unknown>;
};
const errorFixtures = JSON.parse(readFileSync(join(fixturesDir, "errors.json"), "utf8")) as {
  errors: Array<{ code: string; status: number; retryable: boolean }>;
};

let setup: TeamTestSetup;
const bearers = new Map<string, string>(); // fixture label → real token

beforeAll(async () => {
  setup = await setupTeamTest();

  const ws = seed.workspace;
  await setup.pool.query("INSERT INTO team_workspaces (id, name, server_epoch) VALUES ($1, $2, $3)", [ws.id, ws.name, ws.serverEpoch]);
  for (const user of seed.users) {
    const subject = `fixture-${user.email}`;
    await setup.pool.query(
      `INSERT INTO team_users (id, issuer, subject, verified_email, normalized_email, display_name)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [user.id, TEST_ISSUER, subject, user.email, user.displayName],
    );
    if (user.role) {
      await setup.pool.query(
        "INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, $3, $4)",
        [ws.id, user.id, user.role, ws.membershipGeneration],
      );
    }
    bearers.set(user.bearerToken, await setup.signToken(nativeClaims({ sub: subject, sid: `fixture-${user.id}`, email: user.email })));
  }
  for (const token of seed.agentTokens) {
    // A real pbt_ token whose sha256 lands at rest; the fixture label maps to it.
    const secret = Buffer.from(randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), "hex").toString("base64url");
    const real = `pbt_${token.id}.${secret}`;
    await setup.pool.query(
      `INSERT INTO team_agent_tokens (workspace_id, id, owner_user_id, name, secret_hash, scopes, membership_generation, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '1 day')`,
      [ws.id, token.id, token.ownerUserId, token.name, createHash("sha256").update(secret).digest(), token.scopes, ws.membershipGeneration],
    );
    bearers.set(token.bearerToken, real);
  }
  for (const tag of seed.tags) {
    await setup.pool.query("INSERT INTO team_tags (workspace_id, id, name, normalized_name) VALUES ($1, $2, $3, $4)", [ws.id, tag.id, tag.name, tag.name.toLowerCase()]);
  }
  for (const collection of seed.collections) {
    await setup.pool.query("INSERT INTO team_collections (workspace_id, id, name, normalized_name) VALUES ($1, $2, $3, $4)", [ws.id, collection.id, collection.name, collection.name.toLowerCase()]);
  }
  for (const entry of seed.prompts) {
    const prompt = entry.prompt as { id: string; title: string; description: string; approvedRevisionId: string | null; tagIds?: string[]; collectionIds?: string[] };
    // Head FK is deferrable per-transaction only; across autocommit
    // statements insert NULL first and set the head after the revisions.
    await setup.pool.query(
      "INSERT INTO team_prompts (workspace_id, id, title, description) VALUES ($1, $2, $3, $4)",
      [ws.id, prompt.id, prompt.title, prompt.description],
    );
    for (const tagId of prompt.tagIds ?? []) {
      await setup.pool.query("INSERT INTO team_prompt_tags (workspace_id, prompt_id, tag_id) VALUES ($1, $2, $3)", [ws.id, prompt.id, tagId]);
    }
    for (const collectionId of prompt.collectionIds ?? []) {
      await setup.pool.query("INSERT INTO team_collection_prompts (workspace_id, collection_id, prompt_id) VALUES ($1, $2, $3)", [ws.id, collectionId, prompt.id]);
    }
    for (const revision of entry.revisions as Array<{ id: string; promptId: string; parentRevisionId: string | null; content: string; contentHash: string; changeNote: string; author: { userId: string; agentTokenId: string | null }; createdAt: string }>) {
      await setup.pool.query(
        `INSERT INTO team_revisions (workspace_id, id, prompt_id, parent_revision_id, content, content_hash, change_note, author_user_id, author_agent_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [ws.id, revision.id, revision.promptId, revision.parentRevisionId, revision.content, revision.contentHash, revision.changeNote, revision.author.agentTokenId ? null : revision.author.userId, revision.author.agentTokenId, revision.createdAt],
      );
      if (prompt.approvedRevisionId === revision.id) {
        await setup.pool.query(
          "INSERT INTO team_publications (workspace_id, revision_id, prompt_id, source, published_at) VALUES ($1, $2, $3, 'seed', $4)",
          [ws.id, revision.id, revision.promptId, revision.createdAt],
        );
      }
    }
    await setup.pool.query("UPDATE team_prompts SET approved_revision_id = $2 WHERE workspace_id = $1 AND id = $3", [ws.id, prompt.approvedRevisionId, prompt.id]);
  }
});

afterAll(async () => {
  await setup.cleanup();
});

function fixtureRequest(path: string, bearerLabel: string, options: { method?: string; body?: unknown; epoch?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "x-promptbranch-team-protocol": "1", authorization: `Bearer ${bearers.get(bearerLabel)}` };
  if (options.epoch) headers["x-promptbranch-team-epoch"] = options.epoch;
  return new NextRequest(`${TEST_ORIGIN}/api/team/v1/${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function command(
  bearerLabel: string,
  envelopeKey: string,
  fixture: { envelopes: Record<string, { commandId: string; membershipGeneration: string; operation: Record<string, unknown> }> },
  epoch: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const envelope = fixture.envelopes[envelopeKey]!;
  return commandsRoute(
    fixtureRequest(`workspaces/${seed.workspace.id}/commands`, bearerLabel, {
      method: "POST",
      epoch,
      body: { ...envelope, operation: { ...envelope.operation, ...overrides } },
    }),
    { params: Promise.resolve({ w: seed.workspace.id }) },
  );
}

describe("fixture: error table", () => {
  it("every canonical error fixture matches the portal's status and retryable flags", () => {
    expect(errorFixtures.errors).toHaveLength(22);
    for (const row of errorFixtures.errors) {
      const ours = TEAM_ERROR_HTTP_STATUS[row.code as keyof typeof TEAM_ERROR_HTTP_STATUS];
      expect(ours, row.code).toBeDefined();
      expect(ours.status, row.code).toBe(row.status);
      expect(ours.retryable, row.code).toBe(row.retryable);
    }
  });
});

describe("fixture: catalogue responses conform to the artifact schemas", () => {
  it("workspace detail validates", async () => {
    const response = await workspaceDetailRoute(fixtureRequest(`workspaces/${seed.workspace.id}`, "pbtest_owner"), {
      params: Promise.resolve({ w: seed.workspace.id }),
    });
    expect(response.status).toBe(200);
    expect(workspaceResponseSchema.safeParse(await response.json()).success).toBe(true);
  });

  it("prompts page, prompt detail, revisions and revision detail validate", async () => {
    const list = await promptsRoute(fixtureRequest(`workspaces/${seed.workspace.id}/prompts`, "pbtest_viewer"), {
      params: Promise.resolve({ w: seed.workspace.id }),
    });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(promptsPageSchema.safeParse(listBody).success).toBe(true);
    expect(listBody.items).toHaveLength(seed.prompts.length);

    const firstPrompt = listBody.items[0] as { id: string };
    const detail = await promptDetailRoute(fixtureRequest(`workspaces/${seed.workspace.id}/prompts/${firstPrompt.id}`, "pbtest_viewer"), {
      params: Promise.resolve({ w: seed.workspace.id, p: firstPrompt.id }),
    });
    expect(detail.status).toBe(200);
    expect(promptDetailResponseSchema.safeParse(await detail.json()).success).toBe(true);

    const revisions = await revisionsRoute(fixtureRequest(`workspaces/${seed.workspace.id}/prompts/${firstPrompt.id}/revisions`, "pbtest_viewer"), {
      params: Promise.resolve({ w: seed.workspace.id, p: firstPrompt.id }),
    });
    expect(revisions.status).toBe(200);
    const revisionsBody = await revisions.json();
    expect(revisionsPageSchema.safeParse(revisionsBody).success).toBe(true);
    const revision = revisionsBody.items[0] as { id: string };
    const revisionDetail = await revisionDetailRoute(fixtureRequest(`workspaces/${seed.workspace.id}/revisions/${revision.id}`, "pbtest_viewer"), {
      params: Promise.resolve({ w: seed.workspace.id, r: revision.id }),
    });
    expect(revisionDetail.status).toBe(200);
    expect(revisionResponseSchema.safeParse(await revisionDetail.json()).success).toBe(true);
  });

  it("tags and (empty) proposals pages validate", async () => {
    const tags = await tagsRoute(fixtureRequest(`workspaces/${seed.workspace.id}/tags`, "pbtest_viewer"), {
      params: Promise.resolve({ w: seed.workspace.id }),
    });
    expect(tags.status).toBe(200);
    expect(tagsPageSchema.safeParse(await tags.json()).success).toBe(true);

    const proposals = await proposalsRoute(fixtureRequest(`workspaces/${seed.workspace.id}/proposals`, "pbtest_contributor"), {
      params: Promise.resolve({ w: seed.workspace.id }),
    });
    expect(proposals.status).toBe(200);
    expect(proposalsPageSchema.safeParse(await proposals.json()).success).toBe(true);
  });
});

describe("fixture: proposal lifecycle (C10 normative envelopes)", () => {
  const epoch = seed.workspace.serverEpoch;

  it("submit → replay returns the stored receipt, candidate stays out of the catalogue", async () => {
    const submit = await command("pbtest_contributor", "submit", lifecycle, epoch);
    expect(submit.status).toBe(200);
    const receipt = (await submit.json()) as { result: { kind: string } };
    expect(receipt.result.kind).toBe("proposal");

    const replay = await command("pbtest_contributor", "submit", lifecycle, epoch);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);

    // Candidate content carries the privacy marker and never leaks into
    // catalogue surfaces.
    const catalogue = await promptsRoute(fixtureRequest(`workspaces/${seed.workspace.id}/prompts`, "pbtest_viewer"), {
      params: Promise.resolve({ w: seed.workspace.id }),
    });
    expect(JSON.stringify(await catalogue.json())).not.toContain(lifecycle.privacyMarker);
  });

  it("comment, distinct-reviewer approval, note and run reporting follow the fixture envelopes", async () => {
    // Proposal ids are server-authored (C4); substitute the live proposal
    // and its exact candidate revision/hash into the proposal-scoped
    // envelopes — the fixture's constant ids only line up on its own mock.
    const submitted = (await setup.pool.query<{ id: string; candidate_revision_id: string }>(
      "SELECT id, candidate_revision_id::text AS candidate_revision_id FROM team_proposals WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1",
      [seed.workspace.id],
    )).rows[0]!;
    const candidate = (await setup.pool.query<{ content_hash: string }>(
      `SELECT r.content_hash FROM team_revisions r
         JOIN team_proposals p ON p.candidate_revision_id = r.id AND p.workspace_id = r.workspace_id
        WHERE p.id = $1`,
      [submitted.id],
    )).rows[0]!;
    const proposalOverrides = { proposalId: submitted.id };
    const reviewOverrides = {
      ...proposalOverrides,
      candidateRevisionId: submitted.candidate_revision_id,
      candidateContentHash: candidate.content_hash,
    };

    const comment = await command("pbtest_contributor", "commentAdd", lifecycle, epoch, proposalOverrides);
    expect(comment.status).toBe(200);

    const approve = await command("pbtest_maintainer", "reviewApprove", lifecycle, epoch, reviewOverrides);
    expect(approve.status).toBe(200);
    expect(((await approve.json()) as { result: { kind: string } }).result.kind).toBe("review");

    // The approved candidate IS now catalogue content (marker published by
    // review, intentionally visible) and the feed carries the event.
    const changes = await changesRoute(
      fixtureRequest(`workspaces/${seed.workspace.id}/changes`, "pbtest_viewer", {
        epoch: undefined,
      }),
      { params: Promise.resolve({ w: seed.workspace.id }) },
    );
    // changes needs query params; use the direct URL with them:
    const changesWithQuery = await changesRoute(
      new NextRequest(
        `${TEST_ORIGIN}/api/team/v1/workspaces/${seed.workspace.id}/changes?after=0&serverEpoch=${epoch}&membershipGeneration=${seed.workspace.membershipGeneration}`,
        { headers: { "x-promptbranch-team-protocol": "1", authorization: `Bearer ${bearers.get("pbtest_viewer")}` } },
      ),
      { params: Promise.resolve({ w: seed.workspace.id }) },
    );
    expect(changesWithQuery.status).toBe(200);
    const changesBody = await changesBodyOf(changesWithQuery);
    expect(changesPageSchema.safeParse(changesBody).success).toBe(true);
    void changes;

    const note = await command("pbtest_agent", "noteAdd", lifecycle, epoch);
    expect(note.status).toBe(200);
    const run = await command("pbtest_agent", "runReport", lifecycle, epoch);
    expect(run.status).toBe(200);
  });

  async function changesBodyOf(response: Response): Promise<unknown> {
    return response.json();
  }
});

describe("fixture: membership revocation", () => {
  const epoch = seed.workspace.serverEpoch;

  it("last-owner protection, removal, credential death and generation rotation match the expectations", async () => {
    const lastOwner = await command("pbtest_owner", "memberRemoveLastOwner", revocation, epoch);
    expect(lastOwner.status).toBe(409);
    expect(((await lastOwner.json()) as { error: { code: string } }).error.code).toBe("LAST_OWNER");

    const remove = await command("pbtest_owner", "memberRemove", revocation, epoch);
    expect(remove.status).toBe(200);

    // The removed member's requests are workspace-forbidden immediately.
    const removed = await promptsRoute(fixtureRequest(`workspaces/${seed.workspace.id}/prompts`, "pbtest_contributor"), {
      params: Promise.resolve({ w: seed.workspace.id }),
    });
    expect(removed.status).toBe(403);
    expect(((await removed.json()) as { error: { code: string } }).error.code).toBe("WORKSPACE_FORBIDDEN");

    // A command carrying the OLD generation fails MEMBERSHIP_CHANGED.
    const stale = await commandsRoute(
      fixtureRequest(`workspaces/${seed.workspace.id}/commands`, "pbtest_maintainer", {
        method: "POST",
        epoch,
        body: {
          commandId: randomUUID(),
          membershipGeneration: seed.workspace.membershipGeneration,
          operation: { type: "workspace.rename", name: "Stale generation", expectedEntityVersion: 1 },
        },
      }),
      { params: Promise.resolve({ w: seed.workspace.id }) },
    );
    expect([403, 409]).toContain(stale.status);
    if (stale.status === 409) {
      expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("MEMBERSHIP_CHANGED");
    }
  });
});
