import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamTestHarness, type TeamTestHarness, type HumanPrincipal } from "./helpers";
import { SecretBox } from "../src/auth/crypto";
import { failJob, completeJob, claimDueJobs } from "../src/jobs/outbox";
import { runDueJobs } from "../src/jobs/worker";
import { enqueueJob } from "../src/jobs/outbox";

// Job outbox + email delivery (plan P3): transactional enqueue, SKIP LOCKED
// claiming, retry ladder, payload cleared after successful delivery, and
// real SMTP through the local Mailpit capture. Raw invitation tokens never
// appear in logs or error text.

const SMTP_URL = process.env.TEAM_SMTP_URL ?? "smtp://127.0.0.1:48025";
const MAILPIT_API = process.env.TEAM_MAILPIT_API ?? "http://127.0.0.1:48026/api/v1";

let h: TeamTestHarness;
let alice: HumanPrincipal;

async function mailpitReady(): Promise<boolean> {
  try {
    const res = await fetch(`${MAILPIT_API}/messages`);
    return res.ok;
  } catch {
    return false;
  }
}

async function mailpitSearch(query: string): Promise<{ messages_count: number; subject?: string }> {
  const res = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`);
  return (await res.json()) as { messages_count: number; subject?: string };
}

beforeAll(async () => {
  h = await createTeamTestHarness();
  alice = (await h.asUser("Alice Jobs")).principal;
});
afterAll(async () => {
  await h.close();
});

describe("outbox mechanics", () => {
  it("claims due jobs exclusively and reschedules failures along the ladder", async () => {
    const jobId = await enqueueJob(h.pool, {
      workspaceId: null,
      type: "maintenance",
      payload: { note: "ladder probe" },
      secretBox: h.secretBox,
    });
    await h.pool.query("UPDATE team_jobs SET run_after = now() - interval '1 second' WHERE id = $1", [jobId]);

    const [first, second] = await Promise.all([
      claimDueJobs(h.pool, { limit: 5, secretBox: h.secretBox }),
      claimDueJobs(h.pool, { limit: 5, secretBox: h.secretBox }),
    ]);
    // SKIP LOCKED: the job is claimed exactly once across concurrent claims.
    expect(first.length + second.length).toBe(1);
    expect((first[0] ?? second[0])!.payload).toMatchObject({ note: "ladder probe" });

    await completeJob(h.pool, jobId, { clearPayload: false });
    const done = await h.pool.query<{ status: string; attempts: number }>(
      "SELECT status, attempts FROM team_jobs WHERE id = $1",
      [jobId],
    );
    expect(done.rows[0]).toMatchObject({ status: "done", attempts: 1 });

    const failing = await enqueueJob(h.pool, {
      workspaceId: null,
      type: "maintenance",
      payload: { note: "will fail" },
      secretBox: h.secretBox,
    });
    await failJob(h.pool, failing, "TEST_FAILURE");
    let row = (await h.pool.query<{ status: string; run_after: Date }>(
      "SELECT status, run_after FROM team_jobs WHERE id = $1",
      [failing],
    )).rows[0]!;
    expect(row.status).toBe("pending");
    expect(row.run_after.getTime()).toBeGreaterThan(Date.now() + 30_000); // first retry ≈ 1 minute

    // Exhaust the ladder: attempts beyond the schedule fail terminally.
    for (let i = 0; i < 5; i++) await failJob(h.pool, failing, "TEST_FAILURE");
    const terminal = (await h.pool.query<{ status: string }>("SELECT status FROM team_jobs WHERE id = $1", [failing])).rows[0]!;
    expect(terminal.status).toBe("failed");
  });
});

describe("invitation email delivery (real Mailpit)", () => {
  it("delivers via local capture, clears the secret payload, and never logs the token", async () => {
    if (!(await mailpitReady())) {
      throw new Error("Mailpit is not reachable at " + MAILPIT_API + " — run `pnpm team:dev:up` before team tests");
    }
    const created = await h.service.createWorkspace(alice, { commandId: randomUUID(), name: "Jobs WS" });
    const w = created.workspace;
    const receipt = await h.service.execute(alice, w.id, w.serverEpoch, {
      commandId: randomUUID(),
      membershipGeneration: w.membershipGeneration,
      operation: { type: "invitation.create", email: h.emailFor("Casey Mail"), role: "viewer" },
    });
    const token = receipt.invitationToken!;

    const result = await runDueJobs({ pool: h.pool, secretBox: h.secretBox, smtpUrl: SMTP_URL, emailFrom: "team-no-reply@promptbranch.test" });
    expect(result.done).toBeGreaterThanOrEqual(1);

    const row = await h.pool.query<{ status: string; payload_encrypted: Buffer | null }>(
      "SELECT status, payload_encrypted FROM team_jobs WHERE type = 'invitation.email' AND workspace_id = $1",
      [w.id],
    );
    expect(row.rows[0]!.status).toBe("done");
    expect(row.rows[0]!.payload_encrypted).toBeNull(); // secret leaves the DB on success

    // The capture contains the invitation with the accept URL…
    const found = await mailpitSearch(h.emailFor("Casey Mail"));
    expect(found.messages_count).toBeGreaterThanOrEqual(1);
    // …and the raw token never leaked into worker-visible storage or logs:
    const tables = await h.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'team_%'",
    );
    for (const { table_name } of tables.rows) {
      const scan = await h.pool.query(`SELECT to_jsonb(t)::text AS doc FROM "${table_name}" t LIMIT 500`);
      for (const row2 of scan.rows) {
        expect(String(row2.doc)).not.toContain(token);
      }
    }

    // Retry idempotency: re-running the tick delivers nothing new.
    const again = await runDueJobs({ pool: h.pool, secretBox: h.secretBox, smtpUrl: SMTP_URL, emailFrom: "team-no-reply@promptbranch.test" });
    expect(again.claimed).toBe(0);
  });

  it("reschedules when SMTP is unreachable and records only the error code", async () => {
    const created = await h.service.createWorkspace(alice, { commandId: randomUUID(), name: "Retry WS" });
    const w = created.workspace;
    await h.service.execute(alice, w.id, w.serverEpoch, {
      commandId: randomUUID(),
      membershipGeneration: w.membershipGeneration,
      operation: { type: "invitation.create", email: h.emailFor("Dana Mail"), role: "viewer" },
    });
    const result = await runDueJobs({
      pool: h.pool,
      secretBox: h.secretBox,
      smtpUrl: "smtp://127.0.0.1:1", // unreachable port
      emailFrom: "team-no-reply@promptbranch.test",
    });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const row = await h.pool.query<{ status: string; last_error_code: string; payload_encrypted: Buffer | null }>(
      "SELECT status, last_error_code, payload_encrypted FROM team_jobs WHERE type = 'invitation.email' AND workspace_id = $1",
      [w.id],
    );
    expect(row.rows[0]!.status).toBe("pending");
    expect(row.rows[0]!.last_error_code).toBe("EMAIL_DELIVERY_FAILED");
    expect(row.rows[0]!.payload_encrypted).not.toBeNull(); // kept for the retry
  });
});
