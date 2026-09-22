import fs from "node:fs";
import type {
  Change,
  Role,
  Scope,
  Workspace,
  Tag,
  Collection,
  Prompt,
  Revision,
  TeamInfo,
} from "../index.js";
import type { ErrorBody } from "../errors.js";

/**
 * Canonical fixture loader. Fixture files are data, validated by the schema
 * and compatibility suites; operation payloads are typed loosely on purpose so
 * tests can mutate them into invalid variants without fighting the compiler.
 * The relative path resolves identically from src/ (vitest) and dist/ (packed).
 */
export interface FixtureEnvelope {
  commandId: string;
  membershipGeneration: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  operation: any;
}

export interface CatalogSeedFixture {
  description: string;
  server: TeamInfo;
  users: {
    id: string;
    displayName: string;
    email: string;
    role: Role | null;
    bearerToken: string;
  }[];
  agentTokens: {
    id: string;
    name: string;
    ownerUserId: string;
    scopes: Scope[];
    bearerToken: string;
    expiresAt: string;
  }[];
  workspace: Workspace;
  tags: Tag[];
  collections: Collection[];
  prompts: { prompt: Prompt; revisions: Revision[] }[];
  seedCommands: FixtureEnvelope[];
}

export interface CatalogChangesFixture {
  description: string;
  workspaceId: string;
  membershipGeneration: string;
  serverEpoch: string;
  baseSeq: string;
  entries: { command: FixtureEnvelope; change: Change }[];
  expectedPage: {
    request: { after: string; limit: number };
    response: {
      nextCursor: string;
      hasMore: boolean;
      serverEpoch: string;
      membershipGeneration: string;
    };
  };
}

export interface ProposalLifecycleFixture {
  description: string;
  normativeEnvelope: FixtureEnvelope;
  workspaceId: string;
  membershipGeneration: string;
  serverEpoch: string;
  privacyMarker: string;
  promptId: string;
  baseRevisionId: string;
  candidateRevisionId: string;
  candidateContentHash: string;
  proposalId: string;
  envelopes: {
    submit: FixtureEnvelope;
    submitExpectation: {
      status: number;
      resultKind: string;
      receiptReplay: string;
      reusedIdDifferentBytes: string;
    };
    withdraw: FixtureEnvelope;
    reviewApprove: FixtureEnvelope;
    reviewReject: FixtureEnvelope;
    supersedeSubmit: FixtureEnvelope;
    commentAdd: FixtureEnvelope;
    noteAdd: FixtureEnvelope;
    runReport: FixtureEnvelope;
    runReportUnknowns: FixtureEnvelope;
  };
  concurrency: {
    description: string;
    proposalBId: string;
    proposalCId: string;
    approveB: FixtureEnvelope;
    approveC: FixtureEnvelope;
    approveCExpectation: { status: number; code: string };
  };
}

export interface ErrorsFixture {
  description: string;
  errors: { code: string; status: number; retryable: boolean; body: ErrorBody }[];
}

export interface MembershipRevocationFixture {
  description: string;
  workspaceId: string;
  serverEpoch: string;
  generationBefore: string;
  generationAfter: string;
  invitationId: string;
  envelopes: {
    memberRole: FixtureEnvelope;
    memberRemove: FixtureEnvelope;
    memberRemoveLastOwner: FixtureEnvelope;
    invitationCreate: FixtureEnvelope;
    invitationRevoke: FixtureEnvelope;
    workspaceRename: FixtureEnvelope;
    workspaceDelete: FixtureEnvelope;
  };
  expectations: {
    removedMemberBearer: string;
    removedMemberAgentBearer: string;
    memberRemoveLastOwner: { status: number; code: string };
    afterRemoval: { status: number; code: string };
    oldGenerationCommand: { status: number; code: string };
    replayAfterRemoval: string;
  };
}

const fixturesDir = new URL("../../fixtures/", import.meta.url);

function readFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(new URL(name, fixturesDir), "utf8")) as T;
}

export const fixtures = {
  catalogSeed: readFixture<CatalogSeedFixture>("catalog.seed.json"),
  catalogChanges: readFixture<CatalogChangesFixture>("catalog.changes.json"),
  proposalLifecycle: readFixture<ProposalLifecycleFixture>("proposal.lifecycle.json"),
  errors: readFixture<ErrorsFixture>("errors.json"),
  membershipRevocation: readFixture<MembershipRevocationFixture>(
    "membership-revocation.json",
  ),
};

/** Convenience alias matching the D0 plan's example test naming. */
export const proposalSubmit = fixtures.proposalLifecycle.envelopes.submit;
