import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { hashToken } from "@promptbranch/share";
import { getDb, getDeleteTokenHash, getSnapshot, softDeleteSnapshot } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { clientIp } from "@/lib/ip";
import { readLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const limit = readLimiter.check(clientIp(request));
  if (!limit.ok) {
    return NextResponse.json(
      { error: "read rate limit exceeded" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }
  const { id } = await context.params;
  const row = getSnapshot(getDb(), id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (row.deleted_at) return NextResponse.json({ error: "snapshot deleted" }, { status: 410 });
  return NextResponse.json({
    id: row.id,
    url: `${getEnv().PUBLIC_BASE_URL}/p/${row.id}`,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.payload),
  });
}

/** Constant-time compare of token hashes: timing oracles must not reveal
    whether a guessed delete token is close to the real one. */
function tokenMatches(providedToken: string, storedHash: string): boolean {
  const provided = Buffer.from(hashToken(providedToken), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return provided.length === stored.length && timingSafeEqual(provided, stored);
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : null;
  if (!token) return NextResponse.json({ error: "missing bearer token" }, { status: 401 });

  const db = getDb();
  const row = getSnapshot(db, id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const storedHash = getDeleteTokenHash(db, id);
  if (!storedHash || !tokenMatches(token, storedHash)) {
    return NextResponse.json({ error: "invalid delete token" }, { status: 403 });
  }
  // Idempotent: re-deleting an already-deleted snapshot is a success.
  if (!row.deleted_at) softDeleteSnapshot(db, id, new Date().toISOString());
  return NextResponse.json({ ok: true });
}
