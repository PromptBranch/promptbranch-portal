import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  MAX_PAYLOAD_BYTES,
  generateDeleteToken,
  generateSnapshotId,
  hashToken,
  publishRequestSchema,
  scanForSecrets,
} from "@promptbranch/share";
import { getDb, getSnapshot, insertDeleteToken, insertSnapshot } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { clientIp, hashIp } from "@/lib/ip";
import { publishLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

function jsonError(status: number, error: string, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error }, { status, headers });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = getEnv();
  const ip = clientIp(request);

  // Reject declared-oversized bodies before buffering them; chunked bodies
  // may lack content-length, so the post-read byte check below stays.
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_PAYLOAD_BYTES) {
    return jsonError(413, "payload exceeds the 256 KB limit");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) {
    return jsonError(413, "payload exceeds the 256 KB limit");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return jsonError(400, "request body must be JSON");
  }

  const limit = publishLimiter.check(ip);
  if (!limit.ok) {
    return jsonError(429, "publish rate limit exceeded", {
      "retry-after": String(limit.retryAfterSeconds),
    });
  }

  const parsed = publishRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, `invalid snapshot: ${parsed.error.issues[0]?.message ?? "schema violation"}`);
  }
  const { snapshot } = parsed.data;

  // Server-side second scan layer: the client scan can be bypassed, this one
  // cannot. High findings reject; medium findings pass silently here (the
  // client already warned the publisher). Every publisher-supplied free-text
  // field is scanned, including change notes and tags.
  const scannedText = [
    snapshot.title,
    snapshot.description ?? "",
    snapshot.content,
    ...snapshot.tags,
    ...(snapshot.history ?? []).flatMap((entry) => [entry.content, entry.changeNote]),
  ].join("\n");
  const findings = scanForSecrets(scannedText);
  if (findings.some((finding) => finding.severity === "high")) {
    return NextResponse.json({ findings }, { status: 422 });
  }

  const db = getDb();
  // Lineage must point at a real snapshot; a deleted parent still qualifies
  // (soft delete keeps the row precisely so lineage survives revocation).
  if (snapshot.parentId && !getSnapshot(db, snapshot.parentId)) {
    return jsonError(400, `unknown parentId: ${snapshot.parentId}`);
  }

  const id = generateSnapshotId();
  const deleteToken = generateDeleteToken();
  // Snapshot + delete token insert atomically: a crash between the two would
  // otherwise leave a published snapshot nobody can revoke.
  db.transaction(() => {
    insertSnapshot(db, {
      id,
      payload: JSON.stringify(snapshot),
      contentHash: createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex"),
      parentId: snapshot.parentId ?? null,
      publishedAt: snapshot.publishedAt,
      publisherIpHash: hashIp(ip),
    });
    insertDeleteToken(db, id, hashToken(deleteToken));
  })();

  return NextResponse.json(
    { id, url: `${env.PUBLIC_BASE_URL}/p/${id}`, deleteToken },
    { status: 201 },
  );
}
