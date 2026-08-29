import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb, getSnapshot, insertReport } from "@/lib/db";
import { clientIp, hashIp } from "@/lib/ip";
import { reportLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

const reportSchema = z.object({
  snapshotId: z.string().min(1),
  reason: z.string().trim().min(1).max(1000),
});

/**
 * Takedown path (v1): append to the reports table and log a line the
 * operator can follow; review is manual (spec: abuse controls).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = clientIp(request);
  const limit = reportLimiter.check(ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "report rate limit exceeded" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be JSON" }, { status: 400 });
  }
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid report" }, { status: 400 });
  }
  const db = getDb();
  if (!getSnapshot(db, parsed.data.snapshotId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const reportId = insertReport(db, {
    snapshotId: parsed.data.snapshotId,
    reason: parsed.data.reason,
    createdAt: new Date().toISOString(),
    reporterIpHash: hashIp(ip),
  });
  console.warn(`[reports] report #${reportId} filed against snapshot ${parsed.data.snapshotId}`);
  return NextResponse.json({ ok: true }, { status: 201 });
}
