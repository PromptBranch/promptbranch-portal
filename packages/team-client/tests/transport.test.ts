import { describe, expect, it } from "vitest";
import { TEAM_LIMITS } from "@promptbranch/team-contract";
import { createTeamClient, type TeamClient } from "../src/client.js";
import { TeamApiError, TeamTransportError } from "../src/errors.js";
import type { FetchLike, TeamClock } from "../src/transport.js";

const ORIGIN = "http://127.0.0.1:4318";
const TOKEN = "pbtest_transport";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: string | undefined;
}

interface Stub {
  fetchImpl: FetchLike;
  calls: CapturedCall[];
  push(...responses: Response[]): void;
  fail(error: unknown): void;
}

/** A scripted fetch: each queued entry answers one request, in order. */
function stubFetch(): Stub {
  const queue: ({ kind: "response"; response: Response } | { kind: "error"; error: unknown })[] = [];
  const calls: CapturedCall[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      redirect: init?.redirect,
    });
    const next = queue.shift();
    if (!next) return Promise.reject(new Error("stub queue exhausted"));
    if (next.kind === "error") return Promise.reject(next.error);
    return Promise.resolve(next.response);
  };
  return {
    fetchImpl,
    calls,
    push: (...responses: Response[]) => {
      for (const response of responses) queue.push({ kind: "response", response });
    },
    fail: (error: unknown) => queue.push({ kind: "error", error }),
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorBody(code: string, status: number, retryable = false): Response {
  return json(status, {
    error: { code, message: `${code} occurred`, requestId: "req-stub-1", retryable },
  });
}

/** Instant, deterministic clock: records sleeps instead of waiting. */
function fakeClock(): TeamClock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  };
}

function clientWith(stub: Stub, extra: Record<string, unknown> = {}): TeamClient {
  return createTeamClient({
    origin: ORIGIN,
    tokenSource: () => TOKEN,
    fetchImpl: stub.fetchImpl,
    clock: fakeClock(),
    ...extra,
  });
}

const INFO_BODY = {
  protocol: 1,
  contractVersion: "1.0.0",
  serverId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  serverEpoch: "ee000000-0000-4000-8000-000000000001",
  features: ["catalog-v1", "review-v1", "changes-v1", "agent-token-v1"],
  issuer: "http://127.0.0.1:48080/realms/promptbranch-dev",
  nativeClientId: "promptbranch-desktop",
  cliClientId: "promptbranch-cli",
  audience: "promptbranch-team-api",
  limits: { ...TEAM_LIMITS },
};

describe("request headers and origin pinning", () => {
  it("sends the protocol header and bearer token only to the pinned origin", async () => {
    const stub = stubFetch();
    stub.push(json(200, { ready: true }), json(200, INFO_BODY));
    const client = clientWith(stub);

    await client.healthReady();
    await client.info();

    expect(stub.calls[0]!.url).toBe(`${ORIGIN}/api/team/v1/health/ready`);
    expect(stub.calls[0]!.headers["authorization"]).toBeUndefined();
    expect(stub.calls[0]!.headers["x-promptbranch-team-protocol"]).toBeUndefined();

    // Discovery is exempt from the protocol header (C2) and needs no token.
    expect(stub.calls[1]!.url).toBe(`${ORIGIN}/api/team/v1/info`);
    expect(stub.calls[1]!.headers["authorization"]).toBeUndefined();
    expect(stub.calls[1]!.headers["x-promptbranch-team-protocol"]).toBeUndefined();
  });

  it("sends the protocol header and Authorization on authenticated routes", async () => {
    const stub = stubFetch();
    stub.push(
      json(200, {
        workspace: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Alpha",
          role: "owner",
          membershipGeneration: "f1111111-1111-4111-8111-111111111111",
          serverEpoch: "ee000000-0000-4000-8000-000000000001",
          entityVersion: 1,
          updatedAt: "2026-09-21T12:00:00.000Z",
        },
      }),
    );
    const client = clientWith(stub);
    await client.getWorkspace("11111111-1111-4111-8111-111111111111");
    const call = stub.calls[0]!;
    expect(call.url).toBe(
      `${ORIGIN}/api/team/v1/workspaces/11111111-1111-4111-8111-111111111111`,
    );
    expect(call.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(call.headers["x-promptbranch-team-protocol"]).toBe("1");
    expect(call.redirect).toBe("manual");
  });

  it("rejects a tokenSource that returns no token before any network I/O", async () => {
    const stub = stubFetch();
    const client = clientWith(stub, { tokenSource: () => null });
    await expect(
      client.getWorkspace("11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({ name: "TeamTransportError", reason: "not-authenticated" });
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects tokens that could smuggle header bytes", async () => {
    const stub = stubFetch();
    const client = clientWith(stub, { tokenSource: () => "good\r\nX-Evil: 1" });
    await expect(
      client.getWorkspace("11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({ reason: "invalid-token" });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("redirects (C2: never follow with credentials)", () => {
  it("aborts on a cross-origin redirect and never sends the token onward", async () => {
    const stub = stubFetch();
    stub.push(
      new Response(null, { status: 302, headers: { location: "https://evil.example/capture" } }),
    );
    const client = clientWith(stub);
    await expect(
      client.getWorkspace("11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({ name: "TeamTransportError", reason: "redirect-refused" });
    expect(stub.calls).toHaveLength(1);
  });

  it("refuses even same-origin redirects so behavior is uniform", async () => {
    const stub = stubFetch();
    stub.push(new Response(null, { status: 307, headers: { location: `${ORIGIN}/moved` } }));
    const client = clientWith(stub);
    await expect(client.healthReady()).rejects.toMatchObject({ reason: "redirect-refused" });
    expect(stub.calls).toHaveLength(1);
  });

  it("does not leak the redirect target into the error", async () => {
    const stub = stubFetch();
    stub.push(
      new Response(null, { status: 302, headers: { location: "https://evil.example/hunter2" } }),
    );
    const client = clientWith(stub);
    const error = await client.healthReady().catch((caught: unknown) => caught);
    expect(String(error)).not.toContain("hunter2");
  });
});

describe("error mapping", () => {
  it("maps a conforming error body to a typed TeamApiError", async () => {
    const stub = stubFetch();
    stub.push(errorBody("NOT_FOUND", 404));
    const client = clientWith(stub);
    const error = await client
      .getWorkspace("11111111-1111-4111-8111-111111111111")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TeamApiError);
    expect(error).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      requestId: "req-stub-1",
      retryable: false,
    });
  });

  it("maps 426 PROTOCOL_UNSUPPORTED without retrying", async () => {
    const stub = stubFetch();
    stub.push(errorBody("PROTOCOL_UNSUPPORTED", 426));
    const client = clientWith(stub);
    await expect(
      client.getWorkspace("11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({ code: "PROTOCOL_UNSUPPORTED", status: 426 });
    expect(stub.calls).toHaveLength(1);
  });

  it("never retries 409 conflicts and surfaces the server code verbatim", async () => {
    const stub = stubFetch();
    stub.push(errorBody("STALE_BASE", 409));
    const client = clientWith(stub);
    await expect(
      client.command("11111111-1111-4111-8111-111111111111", "ee000000-0000-4000-8000-000000000001", {
        commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        membershipGeneration: "f1111111-1111-4111-8111-111111111111",
        operation: {
          type: "tag.create",
          name: "triage",
        },
      }),
    ).rejects.toMatchObject({ code: "STALE_BASE" });
    expect(stub.calls).toHaveLength(1);
  });

  it("rejects a non-conforming error body without leaking the raw payload", async () => {
    const stub = stubFetch();
    stub.push(
      new Response("<html>hunter2-marker not json</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    const client = clientWith(stub);
    const error = await client.healthReady().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TeamTransportError);
    expect(error).toMatchObject({ reason: "invalid-response", status: 502 });
    expect(String(error)).not.toContain("hunter2-marker");
  });

  it("rejects invalid JSON on a success status", async () => {
    const stub = stubFetch();
    stub.push(new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }));
    const client = clientWith(stub);
    await expect(client.healthReady()).rejects.toMatchObject({ reason: "invalid-json" });
    expect(stub.calls).toHaveLength(1);
  });

  it("rejects a schema-nonconforming success body", async () => {
    const stub = stubFetch();
    stub.push(json(200, { ready: "yes" }));
    const client = clientWith(stub);
    await expect(client.healthReady()).rejects.toMatchObject({ reason: "invalid-response" });
  });
});

describe("retry policy (bounded; C2)", () => {
  it("honors Retry-After on 429 RATE_LIMITED", async () => {
    const stub = stubFetch();
    const clock = fakeClock();
    stub.push(
      json(
        429,
        { error: { code: "RATE_LIMITED", message: "slow down", requestId: "r", retryable: true } },
        { "retry-after": "2" },
      ),
    );
    stub.push(json(200, { ready: true }));
    const client = clientWith(stub, { clock });
    await client.healthReady();
    expect(stub.calls).toHaveLength(2);
    expect(clock.sleeps).toEqual([2000]);
  });

  it("parses Retry-After HTTP dates", async () => {
    const stub = stubFetch();
    const clock = fakeClock();
    const when = new Date(Date.now() + 3000).toUTCString();
    stub.push(
      json(
        429,
        {
          error: { code: "RATE_LIMITED", message: "slow down", requestId: "r", retryable: true },
        },
        { "retry-after": when },
      ),
      json(200, { ready: true }),
    );
    const client = clientWith(stub, { clock });
    await client.healthReady();
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]!).toBeGreaterThan(1000);
    expect(clock.sleeps[0]!).toBeLessThanOrEqual(3000);
  });

  it("never retries 429 QUOTA_EXCEEDED despite the retryable-looking status", async () => {
    const stub = stubFetch();
    stub.push(errorBody("QUOTA_EXCEEDED", 429));
    const client = clientWith(stub);
    await expect(client.healthReady()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(stub.calls).toHaveLength(1);
  });

  it("retries 503 with bounded exponential backoff, then succeeds", async () => {
    const stub = stubFetch();
    const clock = fakeClock();
    stub.push(errorBody("UNAVAILABLE", 503, true), errorBody("UNAVAILABLE", 503, true));
    stub.push(json(200, { ready: true }));
    const client = clientWith(stub, { clock });
    await client.healthReady();
    expect(stub.calls).toHaveLength(3);
    expect(clock.sleeps).toHaveLength(2);
    for (const sleep of clock.sleeps) {
      expect(sleep).toBeGreaterThanOrEqual(0);
      expect(sleep).toBeLessThanOrEqual(60_000);
    }
    expect(clock.sleeps[1]!).toBeGreaterThan(clock.sleeps[0]!);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const stub = stubFetch();
    stub.push(
      errorBody("UNAVAILABLE", 503, true),
      errorBody("UNAVAILABLE", 503, true),
      errorBody("UNAVAILABLE", 503, true),
    );
    const client = clientWith(stub, { maxAttempts: 3 });
    await expect(client.healthReady()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(stub.calls).toHaveLength(3);
  });

  it("retries network failures with identical request bytes", async () => {
    const stub = stubFetch();
    stub.fail(new TypeError("fetch failed"));
    stub.push(
      json(200, {
        commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        committedAt: "2026-09-21T12:00:00.000Z",
        catalogSeq: "7",
        result: { kind: "tag", id: "51111111-1111-4111-8111-111111111111", entityVersion: 1 },
      }),
    );
    const client = clientWith(stub);
    const receipt = await client.command(
      "11111111-1111-4111-8111-111111111111",
      "ee000000-0000-4000-8000-000000000001",
      {
        commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        membershipGeneration: "f1111111-1111-4111-8111-111111111111",
        operation: { type: "tag.create", name: "triage" },
      },
    );
    expect(receipt.result.kind).toBe("tag");
    expect(stub.calls).toHaveLength(2);
    // Retry sends unchanged command bytes under the same command id (C6).
    expect(stub.calls[0]!.body).toBe(stub.calls[1]!.body);
    expect(stub.calls[0]!.body).toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(stub.calls[0]!.headers["x-promptbranch-team-epoch"]).toBe(
      "ee000000-0000-4000-8000-000000000001",
    );
  });

  it("throws a network error when the failure persists", async () => {
    const stub = stubFetch();
    stub.fail(new TypeError("fetch failed"));
    stub.fail(new TypeError("fetch failed"));
    const client = clientWith(stub, { maxAttempts: 2 });
    await expect(client.healthReady()).rejects.toMatchObject({
      name: "TeamTransportError",
      reason: "network",
    });
    expect(stub.calls).toHaveLength(2);
  });
});

describe("response size caps", () => {
  it("rejects an over-cap content-length before reading the body", async () => {
    const stub = stubFetch();
    stub.push(
      json(200, { ready: true }, { "content-length": String(TEAM_LIMITS.maxResponsePageBytes + 1) }),
    );
    const client = clientWith(stub);
    await expect(client.healthReady()).rejects.toMatchObject({ reason: "response-too-large" });
    expect(stub.calls).toHaveLength(1);
  });

  it("rejects a streamed body that grows past the cap mid-read", async () => {
    const stub = stubFetch();
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 9 * 64 KiB = 576 KiB > 512 KiB page cap.
        for (let i = 0; i < 9; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    stub.push(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    const client = clientWith(stub);
    await expect(client.healthReady()).rejects.toMatchObject({ reason: "response-too-large" });
  });

  it("accepts a body just under the cap", async () => {
    const stub = stubFetch();
    const payload = { ready: true, pad: "a".repeat(1024) };
    stub.push(json(200, payload));
    const client = clientWith(stub);
    const ready = await client.healthReady();
    expect(ready.ready).toBe(true);
  });
});

describe("cancellation and timeouts", () => {
  it("rejects without any network I/O when the signal is already aborted", async () => {
    const stub = stubFetch();
    const controller = new AbortController();
    controller.abort();
    const client = clientWith(stub);
    await expect(
      client.getWorkspace("11111111-1111-4111-8111-111111111111", { signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(stub.calls).toHaveLength(0);
  });

  it("cancels an in-flight request when the caller aborts", async () => {
    const controller = new AbortController();
    const stub = stubFetch();
    const hanging: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason ?? new Error("aborted"));
          return;
        }
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      });
    const client = clientWith(stub, { fetchImpl: hanging });
    const pending = client.healthReady({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "aborted" });
  });

  it("times out a stalled request and reports reason timeout", async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason ?? new Error("aborted"));
          return;
        }
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      });
    const client = createTeamClient({
      origin: ORIGIN,
      tokenSource: () => TOKEN,
      fetchImpl: hanging,
      clock: fakeClock(),
      timeoutMs: 20,
      maxAttempts: 2,
    });
    await expect(client.healthReady()).rejects.toMatchObject({ reason: "timeout" });
  });
});

describe("mid-body failures", () => {
  const WORKSPACE = "11111111-1111-4111-8111-111111111111";

  /** A 200 response whose stream dies after a partial first chunk. */
  function resetAfterFirstChunk(contentType = "application/json"): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"ready":'));
          controller.error(new TypeError("terminated"));
        },
      }),
      { status: 200, headers: { "content-type": contentType } },
    );
  }

  /** A 200 response that sends a partial chunk, then stalls until the request signal fires. */
  function stalledAfterFirstChunk(init: RequestInit | undefined, contentType: string): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"schemaVersion":1}\n'));
          if (init?.signal?.aborted) {
            controller.error(init.signal.reason ?? new Error("aborted"));
            return;
          }
          init?.signal?.addEventListener("abort", () =>
            controller.error(init.signal?.reason ?? new Error("aborted")),
          );
        },
      }),
      { status: 200, headers: { "content-type": contentType } },
    );
  }

  it("classifies a mid-body connection reset as a retried network error", async () => {
    const stub = stubFetch();
    stub.push(resetAfterFirstChunk(), resetAfterFirstChunk());
    const client = clientWith(stub, { maxAttempts: 2 });
    await expect(client.healthReady()).rejects.toMatchObject({
      name: "TeamTransportError",
      reason: "network",
    });
    expect(stub.calls).toHaveLength(2);
  });

  it("recovers when the retry delivers a complete body", async () => {
    const stub = stubFetch();
    stub.push(resetAfterFirstChunk(), json(200, { ready: true }));
    const client = clientWith(stub);
    await expect(client.healthReady()).resolves.toEqual({ ready: true });
    expect(stub.calls).toHaveLength(2);
  });

  it("classifies a mid-body timeout as timeout", async () => {
    const client = createTeamClient({
      origin: ORIGIN,
      tokenSource: () => TOKEN,
      fetchImpl: (_url, init) =>
        Promise.resolve(stalledAfterFirstChunk(init, "application/json")),
      clock: fakeClock(),
      timeoutMs: 20,
      maxAttempts: 1,
    });
    await expect(client.healthReady()).rejects.toMatchObject({
      name: "TeamTransportError",
      reason: "timeout",
    });
  });

  it("classifies a mid-body caller abort as aborted and never retries", async () => {
    const controller = new AbortController();
    let fetches = 0;
    const client = createTeamClient({
      origin: ORIGIN,
      tokenSource: () => TOKEN,
      fetchImpl: (_url, init) => {
        fetches += 1;
        return Promise.resolve(stalledAfterFirstChunk(init, "application/json"));
      },
      clock: fakeClock(),
    });
    const pending = client.healthReady({ signal: controller.signal });
    // Let the request reach the body-read phase before aborting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: "TeamTransportError",
      reason: "aborted",
    });
    expect(fetches).toBe(1);
  });

  it("types a mid-stream export failure as a network error", async () => {
    const client = createTeamClient({
      origin: ORIGIN,
      tokenSource: () => TOKEN,
      fetchImpl: () => Promise.resolve(resetAfterFirstChunk("application/x-ndjson")),
      clock: fakeClock(),
    });
    const exported = await client.exportWorkspace(WORKSPACE);
    const consume = async () => {
      for await (const line of exported.lines) void line;
    };
    await expect(consume()).rejects.toMatchObject({
      name: "TeamTransportError",
      reason: "network",
    });
  });

  it("types a caller abort during export as aborted", async () => {
    const controller = new AbortController();
    const client = createTeamClient({
      origin: ORIGIN,
      tokenSource: () => TOKEN,
      fetchImpl: (_url, init) =>
        Promise.resolve(stalledAfterFirstChunk(init, "application/x-ndjson")),
      clock: fakeClock(),
    });
    const exported = await client.exportWorkspace(WORKSPACE, { signal: controller.signal });
    const consume = async () => {
      for await (const line of exported.lines) void line;
    };
    const pending = consume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: "TeamTransportError",
      reason: "aborted",
    });
  });

  it("keeps raw read failures out of the error message", async () => {
    const stub = stubFetch();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ready":'));
        controller.error(new TypeError("hunter2 raw socket detail"));
      },
    });
    stub.push(
      new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = clientWith(stub, { maxAttempts: 1 });
    const error = await client.healthReady().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "network" });
    expect(String(error)).not.toContain("hunter2");
  });
});
