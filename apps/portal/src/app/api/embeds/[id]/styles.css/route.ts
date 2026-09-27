import { NextResponse, type NextRequest } from "next/server";
import { snapshotIdSchema } from "@promptbranch/share";
import { getDb, getSnapshot } from "@/lib/db";
import { buildEmbedTokenStyles } from "@/lib/embed-response";
import { clientIp } from "@/lib/ip";
import { readLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function cssResponse(body: string, status: number, extraHeaders?: HeadersInit): NextResponse {
  const headers = new Headers(extraHeaders);
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", "no-store");
  headers.set("content-type", "text/css; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return new NextResponse(body, { status, headers });
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const limit = readLimiter.check(clientIp(request));
  if (!limit.ok) {
    return cssResponse("", 429, { "retry-after": String(limit.retryAfterSeconds) });
  }

  const { id } = await context.params;
  if (!snapshotIdSchema.safeParse(id).success) return cssResponse("", 404);

  try {
    const row = getSnapshot(getDb(), id);
    if (!row) return cssResponse("", 404);
    if (row.deleted_at) return cssResponse("", 410);
    return cssResponse(await buildEmbedTokenStyles(row), 200);
  } catch {
    return cssResponse("", 500);
  }
}
