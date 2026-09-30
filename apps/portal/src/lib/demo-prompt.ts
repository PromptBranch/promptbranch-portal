import { createHash } from "node:crypto";
import { snapshotSchema } from "@promptbranch/share";
import type { SnapshotRow } from "@/lib/db";

export const DEMO_SNAPSHOT_ID = "demo_code_review_0001";
export const DEMO_MARKDOWN_PATH = "/examples/code-review.md";

// This intentionally public, bundled example keeps the landing demos usable
// on a fresh self-hosted instance without publishing or exposing a user's share.
// Once shipped, use a new demo ID for content changes to keep snapshots immutable.
export const DEMO_PROMPT = snapshotSchema.parse({
  formatVersion: 1,
  title: "Code review companion",
  description: "A focused second pair of eyes for your next change.",
  content: "## Review this change\n\nYou are a thoughtful code reviewer. Read the diff and focus on:\n\n- **Correctness** — edge cases and unintended behavior.\n- **Security** — input validation and access boundaries.\n- **Clarity** — the smallest change that makes the code easier to follow.\n\nFor each finding, explain the impact and suggest a concrete fix. If the change looks sound, say so.",
  tags: ["code-review", "development"],
  publishedAt: "2026-09-30T12:00:00.000Z",
});

const payload = JSON.stringify(DEMO_PROMPT);
const row: SnapshotRow = {
  id: DEMO_SNAPSHOT_ID,
  payload,
  content_hash: createHash("sha256").update(payload).digest("hex"),
  parent_id: null,
  published_at: DEMO_PROMPT.publishedAt,
  publisher_ip_hash: "",
  deleted_at: null,
};

/** Read surfaces may serve this one example; publish/delete paths stay DB-only. */
export function getDemoSnapshot(id: string): SnapshotRow | undefined {
  return id === DEMO_SNAPSHOT_ID ? row : undefined;
}
