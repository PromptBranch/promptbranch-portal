import type { Pool } from "../db.js";
import type { SecretBox } from "../auth/crypto.js";
import { claimDueJobs, completeJob, failJob, type ClaimedJob } from "./outbox.js";
import { sendInvitationEmail, type InvitationEmailPayload } from "./email.js";
import { sweepExpiredSyncState } from "../sync/retention.js";

/**
 * Job worker tick. Runs one claim-deliver-settle cycle; the CLI wrapper
 * (`pnpm team:worker`) loops it. Delivery failures reschedule along the
 * retry ladder; success clears the encrypted invitation secret.
 */

export interface WorkerOptions {
  pool: Pool;
  secretBox: SecretBox;
  smtpUrl: string;
  emailFrom: string;
  batchSize?: number;
}

export interface WorkerTickResult {
  claimed: number;
  done: number;
  failed: number;
}

const jobPayloadSchema = (payload: unknown): payload is InvitationEmailPayload =>
  typeof payload === "object" && payload !== null &&
  typeof (payload as InvitationEmailPayload).to === "string" &&
  typeof (payload as InvitationEmailPayload).workspaceName === "string" &&
  typeof (payload as InvitationEmailPayload).acceptUrl === "string";

async function handle(job: ClaimedJob, options: WorkerOptions): Promise<void> {
  switch (job.type) {
    case "invitation.email": {
      if (!jobPayloadSchema(job.payload)) {
        // Unparseable payloads fail terminally without retries.
        throw Object.assign(new Error("malformed invitation.email payload"), { code: "JOB_PAYLOAD_INVALID" });
      }
      await sendInvitationEmail({ smtpUrl: options.smtpUrl, from: options.emailFrom }, job.payload);
      return;
    }
    default:
      // Later phases implement the remaining job types; an unhandled type
      // stays pending rather than crashing the worker.
      throw Object.assign(new Error(`job type ${job.type} not implemented yet`), { code: "JOB_TYPE_UNHANDLED" });
  }
}

export async function runDueJobs(options: WorkerOptions): Promise<WorkerTickResult> {
  // Retention rides along with every tick: bootstrap rows expire after 10
  // minutes, feed events after 30 days, floor advanced transactionally.
  await sweepExpiredSyncState(options.pool).catch(() => undefined);
  const jobs = await claimDueJobs(options.pool, { limit: options.batchSize ?? 10, secretBox: options.secretBox });
  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await handle(job, options);
      await completeJob(options.pool, job.id, {
        // The invitation secret leaves the database on first success.
        clearPayload: job.type === "invitation.email",
      });
      done += 1;
    } catch (error) {
      const code = (error as { code?: string }).code ?? "JOB_FAILED";
      await failJob(options.pool, job.id, code).catch(() => undefined);
      failed += 1;
    }
  }
  return { claimed: jobs.length, done, failed };
}
