import { NextResponse, type NextRequest } from "next/server";
import { snapshotIdSchema } from "@promptbranch/share";
import { getDb, getSnapshot } from "@/lib/db";
import { getDemoSnapshot } from "@/lib/demo-prompt";
import { buildEmbedResponse } from "@/lib/embed-response";
import { clientIp } from "@/lib/ip";
import { readLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function jsonResponse(body: unknown, status: number, extraHeaders?: HeadersInit): NextResponse {
  const headers = new Headers(extraHeaders);
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return NextResponse.json(body, { status, headers });
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const limit = readLimiter.check(clientIp(request));
  if (!limit.ok) {
    return jsonResponse(
      { error: "read rate limit exceeded" },
      429,
      { "retry-after": String(limit.retryAfterSeconds) },
    );
  }

  const { id } = await context.params;
  if (!snapshotIdSchema.safeParse(id).success) return jsonResponse({ error: "not found" }, 404);

  try {
    const row = getDemoSnapshot(id) ?? getSnapshot(getDb(), id);
    if (!row) return jsonResponse({ error: "not found" }, 404);
    if (row.deleted_at) return jsonResponse({ error: "snapshot deleted" }, 410);

    return jsonResponse(await buildEmbedResponse(row), 200);
  } catch {
    // Stored payloads are normally validated at publish time. Fail closed if
    // a damaged row cannot be parsed, and keep the same browser-safe headers.
    return jsonResponse({ error: "unable to render snapshot" }, 500);
  }
}
