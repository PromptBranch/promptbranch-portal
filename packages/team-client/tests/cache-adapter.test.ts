import { describe, expect, it } from "vitest";
import { fixtures } from "@promptbranch/team-contract/testing";
import { catalogRecordSchema, type CatalogRecord, type ChangesPage } from "@promptbranch/team-contract";
import {
  bootstrapPageToRows,
  catalogRecordToRow,
  changesPageToBatch,
} from "../src/cache-adapter.js";

const seed = fixtures.catalogSeed;
const WORKSPACE_ID = seed.workspace.id;
const EPOCH = seed.server.serverEpoch;
const GENERATION = seed.workspace.membershipGeneration;

describe("catalogRecordToRow", () => {
  it("maps every catalogue entity kind to a storage row", () => {
    const tag = catalogRecordToRow({ entity: "tag", value: seed.tags[0]! });
    expect(tag.entity).toBe("tag");
    expect(tag.id).toBe(seed.tags[0]!.id);
    expect(JSON.parse(tag.json)).toMatchObject({ id: seed.tags[0]!.id, name: seed.tags[0]!.name });

    const collection = catalogRecordToRow({ entity: "collection", value: seed.collections[0]! });
    expect(collection.entity).toBe("collection");

    const prompt = catalogRecordToRow({ entity: "prompt", value: seed.prompts[0]!.prompt });
    expect(prompt.entity).toBe("prompt");
    expect(prompt.id).toBe(seed.prompts[0]!.prompt.id);

    const revision = catalogRecordToRow({ entity: "revision", value: seed.prompts[0]!.revisions[0]! });
    expect(revision.entity).toBe("revision");
    expect(JSON.parse(revision.json)).toMatchObject({ promptId: seed.prompts[0]!.prompt.id });
  });

  it("strips unknown additive fields for forward compatibility (C2)", () => {
    const withExtra = { ...seed.tags[0]!, futureField: "ignored" };
    const row = catalogRecordToRow({ entity: "tag", value: withExtra });
    expect(JSON.parse(row.json)).not.toHaveProperty("futureField");
  });

  it("rejects unknown discriminated entity kinds as an invalid response (sync must pause)", () => {
    const poisoned = { entity: "hologram", value: { id: seed.tags[0]!.id } } as unknown as CatalogRecord;
    expect(() => catalogRecordToRow(poisoned)).toThrowError(
      expect.objectContaining({ name: "TeamTransportError", reason: "invalid-response" }),
    );
  });

  it("rejects structurally invalid records", () => {
    const broken = { entity: "tag", value: { id: "not-a-uuid", workspaceId: WORKSPACE_ID, name: "x", entityVersion: 1 } };
    expect(() => catalogRecordToRow(broken as unknown as CatalogRecord)).toThrowError(
      expect.objectContaining({ reason: "invalid-response" }),
    );
  });
});

describe("changesPageToBatch", () => {
  const basePage = {
    nextCursor: "7",
    hasMore: false,
    serverEpoch: EPOCH,
    membershipGeneration: GENERATION,
  };

  it("flattens records and tombstones across the page's changes", () => {
    const page: ChangesPage = {
      ...basePage,
      changes: [
        { seq: "6", records: [{ entity: "tag", value: seed.tags[0]! }], tombstones: [] },
        {
          seq: "7",
          records: [{ entity: "prompt", value: seed.prompts[0]!.prompt }],
          tombstones: [{ entity: "collection", id: seed.collections[0]!.id }],
        },
      ],
    };
    const batch = changesPageToBatch(page, "5");
    expect(batch).not.toBeNull();
    expect(batch!.expectedCursor).toBe("5");
    expect(batch!.nextCursor).toBe("7");
    expect(batch!.upserts.map((row) => row.entity)).toEqual(["tag", "prompt"]);
    expect(batch!.deletes).toEqual([{ entity: "collection", id: seed.collections[0]!.id }]);
  });

  it("returns null for an empty page (no cursor movement needed)", () => {
    const page: ChangesPage = { ...basePage, nextCursor: "5", changes: [] };
    expect(changesPageToBatch(page, "5")).toBeNull();
  });

  it("rejects a page carrying an unknown record kind instead of caching it", () => {
    const page: ChangesPage = {
      ...basePage,
      changes: [
        {
          seq: "6",
          records: [{ entity: "hologram", value: { id: seed.tags[0]!.id } } as unknown as CatalogRecord],
          tombstones: [],
        },
      ],
    };
    expect(() => changesPageToBatch(page, "5")).toThrowError(
      expect.objectContaining({ reason: "invalid-response" }),
    );
  });

  it("accepts every record the contract schema accepts", () => {
    for (const { prompt, revisions } of seed.prompts) {
      expect(catalogRecordSchema.parse({ entity: "prompt", value: prompt })).toBeDefined();
      for (const revision of revisions) {
        expect(catalogRecordSchema.parse({ entity: "revision", value: revision })).toBeDefined();
      }
    }
  });
});

describe("bootstrapPageToRows", () => {
  it("maps a bootstrap page into storage rows", () => {
    const rows = bootstrapPageToRows({
      snapshotId: "11111111-1111-4111-8111-111111111111",
      records: [
        { entity: "tag", value: seed.tags[0]! },
        { entity: "revision", value: seed.prompts[0]!.revisions[0]! },
      ],
      nextPageToken: null,
      highWater: "10",
      serverEpoch: EPOCH,
      membershipGeneration: GENERATION,
    });
    expect(rows.map((row) => row.entity)).toEqual(["tag", "revision"]);
    expect(JSON.parse(rows[1]!.json)).toMatchObject({ id: seed.prompts[0]!.revisions[0]!.id });
  });
});
