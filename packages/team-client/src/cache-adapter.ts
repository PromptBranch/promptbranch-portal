import {
  catalogRecordSchema,
  type BootstrapPage,
  type CatalogRecord,
  type ChangesPage,
} from "@promptbranch/team-contract";
import { TeamTransportError } from "./errors.js";

/**
 * Wire-to-storage mapping for the team cache. Wire DTOs are re-validated with
 * the contract schemas here (the sync layer's pause signal on malformed data
 * is `invalid-response`), then serialized to the row shape Core's team
 * primitives persist. Unknown additive fields are stripped per C2 tolerance;
 * unknown discriminated kinds reject the whole page.
 */

/** Structural twin of Core's `TeamCatalogRow` (packages/core/src/team/types.ts). */
export interface TeamCatalogRowInput {
  entity: "prompt" | "revision" | "tag" | "collection";
  id: string;
  json: string;
}

/** Structural twin of Core's `TeamCatalogTombstone`. */
export interface TeamCatalogTombstoneInput {
  entity: "prompt" | "tag" | "collection";
  id: string;
}

/** Structural twin of Core's `TeamChangeBatch`. */
export interface TeamChangeBatchInput {
  expectedCursor: string;
  nextCursor: string;
  upserts: TeamCatalogRowInput[];
  deletes: TeamCatalogTombstoneInput[];
}

function invalidRow(message: string): TeamTransportError {
  // Path/code-level detail only: record payloads never enter the error (C2).
  return new TeamTransportError("invalid-response", message);
}

/** Validates one wire record and maps it to its storage row. */
export function catalogRecordToRow(record: CatalogRecord): TeamCatalogRowInput {
  const parsed = catalogRecordSchema.safeParse(record);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue ? issue.path.map(String).join(".") : "(root)";
    throw invalidRow(`A catalogue record failed contract validation at ${path || "(root)"}.`);
  }
  const { entity, value } = parsed.data;
  return { entity, id: value.id, json: JSON.stringify(value) };
}

/** Maps one bootstrap page to storage rows; a bad record rejects the page. */
export function bootstrapPageToRows(page: BootstrapPage): TeamCatalogRowInput[] {
  return page.records.map(catalogRecordToRow);
}

/**
 * Flattens one change-feed page into a single atomic batch for Core's
 * `applyTeamChangeBatch`. Returns null for an empty page, where the cursor
 * must not move. Reference integrity is checked by Core at transaction end,
 * which is why the whole page applies as one unit (C7).
 */
export function changesPageToBatch(page: ChangesPage, expectedCursor: string): TeamChangeBatchInput | null {
  if (page.changes.length === 0) return null;
  const upserts: TeamCatalogRowInput[] = [];
  const deletes: TeamCatalogTombstoneInput[] = [];
  for (const change of page.changes) {
    for (const record of change.records) upserts.push(catalogRecordToRow(record));
    for (const tombstone of change.tombstones) deletes.push({ entity: tombstone.entity, id: tombstone.id });
  }
  return { expectedCursor, nextCursor: page.nextCursor, upserts, deletes };
}
