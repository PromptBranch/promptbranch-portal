import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isTeamError, teamError } from "@promptbranch/team-server";
import { TEAM_LIMITS, TEAM_PROTOCOL_HEADER, TEAM_PROTOCOL_VERSION } from "./env";

/**
 * Wire conventions for every /api/team/v1 response (contract C2): private
 * no-store caching, Vary on both auth modes, nosniff, an X-Request-ID, and
 * the stable error body shape. Error responses never echo request bodies or
 * stack traces.
 */

export function teamBaseHeaders(requestId: string): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    vary: "Cookie, Authorization",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  };
}

export function teamJson(requestId: string, data: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(data, {
    status: init?.status ?? 200,
    headers: teamBaseHeaders(requestId),
  });
}

export function teamErrorResponse(requestId: string, error: unknown): NextResponse {
  if (isTeamError(error)) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          requestId,
          retryable: error.retryable,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.httpStatus, headers: teamBaseHeaders(requestId) },
    );
  }
  // Unknown failures collapse to a generic unavailable — no internals leak.
  return NextResponse.json(
    {
      error: {
        code: "UNAVAILABLE",
        message: "Team service is unavailable",
        requestId,
        retryable: true,
      },
    },
    { status: 503, headers: teamBaseHeaders(requestId) },
  );
}

/** Wire cap from the contract limits — enforced before reading bodies. */
export const MAX_TEAM_REQUEST_BYTES = TEAM_LIMITS.maxRequestBytes;

/**
 * Reads a JSON request body under the wire cap. The content-length
 * pre-check rejects oversized declared bodies without reading, but chunked
 * streaming bodies carry no content-length — the stream itself is counted
 * and cut off at the cap so no caller can stream unbounded bytes into
 * memory. Unparseable/empty bodies return null and let the caller's schema
 * validation produce the client-facing error.
 */
export async function readTeamJsonBody(request: NextRequest): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_TEAM_REQUEST_BYTES) {
    throw teamError("PAYLOAD_TOO_LARGE", "Request body exceeds the 256 KiB limit");
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > MAX_TEAM_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw teamError("PAYLOAD_TOO_LARGE", "Request body exceeds the 256 KiB limit");
      }
      chunks.push(value);
    }
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Protocol gate: every team API route except discovery requires the client's
 * protocol header; a mismatched major is rejected before any domain work.
 */
export function requireProtocol(request: NextRequest): void {
  const header = request.headers.get(TEAM_PROTOCOL_HEADER);
  if (header !== String(TEAM_PROTOCOL_VERSION)) {
    throw teamError("PROTOCOL_UNSUPPORTED", `Send ${TEAM_PROTOCOL_HEADER}: ${TEAM_PROTOCOL_VERSION}`);
  }
}
