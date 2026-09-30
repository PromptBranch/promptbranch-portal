import { NextResponse, type NextRequest } from "next/server";
import { DEMO_PROMPT } from "@/lib/demo-prompt";
import { clientIp } from "@/lib/ip";
import { readLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function GET(request: NextRequest): NextResponse {
  const limit = readLimiter.check(clientIp(request));
  if (!limit.ok) {
    return new NextResponse("Read rate limit exceeded", {
      status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) },
    });
  }
  return new NextResponse(DEMO_PROMPT.content, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
