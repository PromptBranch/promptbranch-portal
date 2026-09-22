import { describe, expect, it } from "vitest";
import {
  bootstrapInputSchema,
  bootstrapPageSchema,
  bootstrapStartSchema,
  catalogRecordSchema,
  changeSchema,
  changesPageSchema,
  commandEnvelopeSchema,
  commandReceiptSchema,
  errorBodySchema,
  proposalSchema,
  revisionSchema,
  teamInfoSchema,
  teamOperationSchema,
  workspaceSchema,
} from "../src/index.js";
import { fixtures } from "../src/testing/fixtures.js";

const seed = fixtures.catalogSeed;
const lifecycle = fixtures.proposalLifecycle;
const revocation = fixtures.membershipRevocation;
const changesFixture = fixtures.catalogChanges;

function allFixtureEnvelopes(): unknown[] {
  const lifecycleEnvelopes = Object.values(lifecycle.envelopes).filter(
    (entry) => typeof entry === "object" && entry !== null && "operation" in entry,
  );
  return [
    ...seed.seedCommands,
    ...changesFixture.entries.map((entry) => entry.command),
    ...lifecycleEnvelopes,
    lifecycle.concurrency.approveB,
    lifecycle.concurrency.approveC,
    ...Object.values(revocation.envelopes),
    lifecycle.normativeEnvelope,
  ];
}

describe("fixture envelopes", () => {
  it("parses every fixture command envelope", () => {
    for (const envelope of allFixtureEnvelopes()) {
      const result = commandEnvelopeSchema.safeParse(envelope);
      expect(result.success, JSON.stringify(envelope)).toBe(true);
    }
  });

  it("covers every TeamOperation literal with at least one valid example", () => {
    const covered = new Set(
      allFixtureEnvelopes().map(
        (envelope) => (envelope as { operation: { type: string } }).operation.type,
      ),
    );
    const declared = teamOperationSchema.options.map(
      (option) => option.shape.type.value,
    ) as string[];
    for (const type of declared) expect(covered.has(type), type).toBe(true);
    // The C4 operation table defines exactly 23 operation types.
    expect(declared.length).toBe(23);
  });

  it("rejects a spoofed actorId on proposal.submit", () => {
    expect(
      teamOperationSchema.safeParse({
        ...lifecycle.envelopes.submit.operation,
        actorId: "spoofed",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown operation types", () => {
    expect(teamOperationSchema.safeParse({ type: "prompt.hack" }).success).toBe(false);
  });
});

describe("strict request objects", () => {
  it("rejects unknown fields on operations", () => {
    const base = seed.seedCommands[3]!.operation;
    expect(
      teamOperationSchema.safeParse({ ...base, unexpected: true }).success,
    ).toBe(false);
  });

  it("rejects unknown fields on the envelope", () => {
    const envelope = lifecycle.envelopes.submit;
    expect(
      commandEnvelopeSchema.safeParse({ ...envelope, workspaceId: "spoofed" }).success,
    ).toBe(false);
  });

  it("rejects unknown fields on bootstrap input", () => {
    expect(
      bootstrapInputSchema.safeParse({
        membershipGeneration: seed.workspace.membershipGeneration,
        serverEpoch: seed.server.serverEpoch,
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe("id and sequence formats", () => {
  it("rejects invalid UUIDs", () => {
    const envelope = structuredClone(lifecycle.envelopes.submit);
    envelope.commandId = "not-a-uuid";
    expect(commandEnvelopeSchema.safeParse(envelope).success).toBe(false);
    envelope.commandId = "ca000101-0000-4000-8000-00000000010";
    expect(commandEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it("accepts only canonical decimal sequences", () => {
    for (const seq of ["0", "6", "14", "9007199254740993"]) {
      expect(
        changeSchema.safeParse({ seq, records: [], tombstones: [] }).success,
        seq,
      ).toBe(true);
    }
    for (const seq of ["007", "-1", "1.5", "abc", ""]) {
      expect(
        changeSchema.safeParse({ seq, records: [], tombstones: [] }).success,
        seq,
      ).toBe(false);
    }
  });

  it("requires UTC RFC3339 timestamps", () => {
    const workspace = structuredClone(seed.workspace);
    expect(workspaceSchema.safeParse(workspace).success).toBe(true);
    workspace.updatedAt = "2026-09-21T14:00:00+02:00";
    expect(workspaceSchema.safeParse(workspace).success).toBe(false);
    workspace.updatedAt = "2026-09-21 12:00:00";
    expect(workspaceSchema.safeParse(workspace).success).toBe(false);
  });
});

describe("UTF-8 byte bounds", () => {
  it("caps content at 64 KiB of UTF-8", () => {
    const submit = structuredClone(lifecycle.envelopes.submit.operation);
    submit.content = "x".repeat(65536);
    expect(teamOperationSchema.safeParse(submit).success).toBe(true);
    submit.content = "x".repeat(65537);
    expect(teamOperationSchema.safeParse(submit).success).toBe(false);
    // Multi-byte characters count by bytes, not code points.
    submit.content = "é".repeat(40000);
    expect(teamOperationSchema.safeParse(submit).success).toBe(false);
  });

  it("bounds title, description, rationale and tag names", () => {
    const create = structuredClone(seed.seedCommands[3]!.operation);
    create.title = "t".repeat(200);
    expect(teamOperationSchema.safeParse(create).success).toBe(true);
    create.title = "t".repeat(201);
    expect(teamOperationSchema.safeParse(create).success).toBe(false);
    create.title = "";
    expect(teamOperationSchema.safeParse(create).success).toBe(false);

    const ok = structuredClone(seed.seedCommands[3]!.operation);
    ok.description = "d".repeat(2000);
    expect(teamOperationSchema.safeParse(ok).success).toBe(true);
    ok.description = "d".repeat(2001);
    expect(teamOperationSchema.safeParse(ok).success).toBe(false);

    const submit = structuredClone(lifecycle.envelopes.submit.operation);
    submit.rationale = "r".repeat(8000);
    expect(teamOperationSchema.safeParse(submit).success).toBe(true);
    submit.rationale = "r".repeat(8001);
    expect(teamOperationSchema.safeParse(submit).success).toBe(false);
    submit.rationale = "   ";
    expect(teamOperationSchema.safeParse(submit).success).toBe(false);

    const tag = structuredClone(seed.seedCommands[0]!.operation);
    tag.name = "n".repeat(50);
    expect(teamOperationSchema.safeParse(tag).success).toBe(true);
    tag.name = "n".repeat(51);
    expect(teamOperationSchema.safeParse(tag).success).toBe(false);
  });

  it("limits tag and collection membership counts", () => {
    const create = structuredClone(seed.seedCommands[3]!.operation);
    create.tagIds = Array.from({ length: 20 }, (_, i) => seed.tags[0]!.id);
    expect(teamOperationSchema.safeParse(create).success).toBe(true);
    create.tagIds = Array.from({ length: 21 }, (_, i) => seed.tags[0]!.id);
    expect(teamOperationSchema.safeParse(create).success).toBe(false);
  });
});

describe("unsafe numbers", () => {
  const runReport = () => structuredClone(lifecycle.envelopes.runReport.operation);

  it("rejects non-finite and negative metrics", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const op = runReport();
      op.latencyMs = bad;
      expect(teamOperationSchema.safeParse(op).success, String(bad)).toBe(false);
    }
  });

  it("rejects fractional token counts and unsafe integers", () => {
    const fractional = runReport();
    fractional.inputTokens = 1.5;
    expect(teamOperationSchema.safeParse(fractional).success).toBe(false);
    const unsafe = runReport();
    unsafe.outputTokens = 2 ** 53;
    expect(teamOperationSchema.safeParse(unsafe).success).toBe(false);
  });

  it("accepts null unknowns and zero", () => {
    expect(
      teamOperationSchema.safeParse(lifecycle.envelopes.runReportUnknowns.operation)
        .success,
    ).toBe(true);
    const zero = runReport();
    zero.latencyMs = 0;
    zero.estimatedCostUsd = 0;
    expect(teamOperationSchema.safeParse(zero).success).toBe(true);
  });

  it("rejects unsafe entity versions", () => {
    const op = structuredClone(seed.seedCommands[4]!.operation);
    op.expectedEntityVersion = 2 ** 53;
    expect(teamOperationSchema.safeParse(op).success).toBe(false);
    op.expectedEntityVersion = 0;
    expect(teamOperationSchema.safeParse(op).success).toBe(false);
    op.expectedEntityVersion = 1.5;
    expect(teamOperationSchema.safeParse(op).success).toBe(false);
  });
});

describe("entity and page schemas", () => {
  it("parses the seed catalogue records", () => {
    for (const tag of seed.tags) {
      expect(
        catalogRecordSchema.safeParse({ entity: "tag", value: tag }).success,
      ).toBe(true);
    }
    for (const collection of seed.collections) {
      expect(
        catalogRecordSchema.safeParse({ entity: "collection", value: collection })
          .success,
      ).toBe(true);
    }
    for (const { prompt, revisions } of seed.prompts) {
      expect(
        catalogRecordSchema.safeParse({ entity: "prompt", value: prompt }).success,
      ).toBe(true);
      for (const revision of revisions) {
        expect(revisionSchema.safeParse(revision).success).toBe(true);
        expect(
          catalogRecordSchema.safeParse({ entity: "revision", value: revision })
            .success,
        ).toBe(true);
      }
    }
  });

  it("rejects unknown catalogue record kinds", () => {
    expect(
      catalogRecordSchema.safeParse({
        entity: "hologram",
        value: { id: seed.tags[0]!.id },
      }).success,
    ).toBe(false);
  });

  it("parses change feed pages and rejects unknown record kinds inside them", () => {
    const page = {
      changes: changesFixture.entries.map((entry) => entry.change),
      nextCursor: changesFixture.expectedPage.response.nextCursor,
      hasMore: false,
      serverEpoch: changesFixture.serverEpoch,
      membershipGeneration: changesFixture.membershipGeneration,
    };
    expect(changesPageSchema.safeParse(page).success).toBe(true);
    const poisoned = structuredClone(page);
    poisoned.changes[0]!.records.push({ entity: "hologram", value: {} } as never);
    expect(changesPageSchema.safeParse(poisoned).success).toBe(false);
  });

  it("parses bootstrap start and pages", () => {
    const start = {
      snapshotId: "5a900001-0000-4000-8000-000000000001",
      highWater: "6",
      expiresAt: "2026-09-21T12:10:00.000Z",
      serverEpoch: seed.server.serverEpoch,
      membershipGeneration: seed.workspace.membershipGeneration,
    };
    expect(bootstrapStartSchema.safeParse(start).success).toBe(true);
    const page = {
      snapshotId: start.snapshotId,
      records: seed.tags.map((tag) => ({ entity: "tag", value: tag })),
      nextPageToken: null,
      highWater: "6",
      serverEpoch: seed.server.serverEpoch,
      membershipGeneration: seed.workspace.membershipGeneration,
    };
    expect(bootstrapPageSchema.safeParse(page).success).toBe(true);
  });

  it("parses team info with exact limits keys", () => {
    expect(teamInfoSchema.safeParse(seed.server).success).toBe(true);
    expect(teamInfoSchema.parse(seed.server).limits.maxContentBytes).toBe(65536);
    const missing = structuredClone(seed.server) as Record<string, unknown>;
    delete missing.serverId;
    expect(teamInfoSchema.safeParse(missing).success).toBe(false);
  });

  it("parses command receipts", () => {
    expect(
      commandReceiptSchema.safeParse({
        commandId: lifecycle.envelopes.submit.commandId,
        committedAt: "2026-09-21T14:00:00.000Z",
        catalogSeq: "15",
        result: { kind: "proposal", id: lifecycle.proposalId, entityVersion: 1 },
      }).success,
    ).toBe(true);
  });
});

describe("error bodies", () => {
  it("parses every canonical error example", () => {
    for (const example of fixtures.errors.errors) {
      expect(
        errorBodySchema.safeParse(example.body).success,
        example.code,
      ).toBe(true);
    }
  });

  it("requires code, message, requestId and retryable", () => {
    expect(
      errorBodySchema.safeParse({
        error: { code: "STALE_BASE", message: "x", requestId: "r", retryable: false },
      }).success,
    ).toBe(true);
    expect(errorBodySchema.safeParse({ error: { code: "STALE_BASE" } }).success).toBe(
      false,
    );
  });
});

describe("proposal state vocabulary", () => {
  it("accepts only the five terminal-aware statuses", () => {
    const base = {
      id: lifecycle.proposalId,
      workspaceId: seed.workspace.id,
      promptId: lifecycle.promptId,
      baseRevisionId: lifecycle.baseRevisionId,
      candidateRevisionId: lifecycle.candidateRevisionId,
      rationale: "r",
      author: {
        userId: seed.users[2]!.id,
        displayName: seed.users[2]!.displayName,
        agentTokenId: null,
      },
      supersedesProposalId: null,
      entityVersion: 1,
      createdAt: "2026-09-21T14:00:00.000Z",
      updatedAt: "2026-09-21T14:00:00.000Z",
    };
    for (const status of ["open", "approved", "rejected", "withdrawn", "superseded"]) {
      expect(proposalSchema.safeParse({ ...base, status }).success, status).toBe(true);
    }
    expect(proposalSchema.safeParse({ ...base, status: "merged" }).success).toBe(false);
  });
});
