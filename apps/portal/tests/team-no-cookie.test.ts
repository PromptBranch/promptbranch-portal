import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { PublishRequest, SnapshotPayload } from "@promptbranch/share";
import { POST } from "@/app/api/snapshots/route";

// The anonymous snapshot service stays cookie-free (contract C5): no route
// under /api/snapshots or /p/:id may ever emit a Set-Cookie header, so team
// sessions can never leak into the anonymous surface.

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.77.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "portal-test-"));
  delete process.env.PUBLIC_BASE_URL;
});

function validPayload(): PublishRequest {
  return {
    snapshot: {
      formatVersion: 1,
      title: "anonymous-surface",
      description: "",
      content: "No cookies on the anonymous surface.",
      tags: [],
      history: [],
      publishedAt: "2026-09-21T12:00:00.000Z",
      appVersion: "0.1.0",
    } satisfies SnapshotPayload,
  };
}

describe("anonymous snapshot surface", () => {
  it("never sets a cookie on publish", async () => {
    const response = await POST(
      new NextRequest("http://localhost:3000/api/snapshots", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
        body: JSON.stringify(validPayload()),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("ignores a presented team cookie instead of adopting it", async () => {
    const response = await POST(
      new NextRequest("http://localhost:3000/api/snapshots", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": nextIp(),
          cookie: "__Host-pb-team=someone-elses-session",
        },
        body: JSON.stringify(validPayload()),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
