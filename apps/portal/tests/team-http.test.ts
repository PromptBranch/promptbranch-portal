import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sessions, SecretBox } from "@promptbranch/team-server";
import { setupTeamTest, nativeClaims, TEST_ISSUER, type TeamTestSetup } from "./team-test-setup";

// P8 real-HTTP gate: CSRF/Origin negatives, the strict CSP, private no-store
// caching, the protocol gate and the streaming body cap — exercised through
// an actual `next dev` server, not in-process handler calls. The server and
// this suite share the scratch PostgreSQL database and the session
// encryption key, so a web session forged here is valid there.

const PORT = 4617;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PROTOCOL = { "x-promptbranch-team-protocol": "1" };

const run = promisify(execFile);

let setup: TeamTestSetup;
let server: ReturnType<typeof spawn>;
let cookie: string;
let csrfToken: string;
let bearer: string;
let nextEnvSnapshot: string;

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const response = await fetch(`${ORIGIN}/api/team/v1/info`, { headers: PROTOCOL });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error("next dev did not become ready within 120s");
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

beforeAll(async () => {
  setup = await setupTeamTest();
  process.env.TEAM_PUBLIC_ORIGIN = ORIGIN;
  process.env.PUBLIC_BASE_URL = ORIGIN;

  // Forge a human web session straight into the shared database; the sealed
  // cookie validates in the server process because the key matches.
  const secretBox = SecretBox.fromBase64(process.env.TEAM_SESSION_ENCRYPTION_KEY!);
  const sessions = new Sessions(setup.pool, secretBox);
  const user = await sessions.mapUser({
    issuer: TEST_ISSUER,
    subject: "http-suite-sub",
    email: "http-suite@promptbranch.test",
    displayName: "HTTP Suite",
  });
  const app = await sessions.resolveAppSession(
    { issuer: TEST_ISSUER, subject: "http-suite-sub", providerSessionId: "http-suite-sid", clientId: "promptbranch-desktop" },
    user.userId,
  );
  const web = await sessions.createWebSession({ appSessionId: app.appSessionId, refreshToken: null });
  cookie = `__Host-pb-team=${web.token}`;
  csrfToken = web.csrfToken;
  bearer = await setup.signToken(nativeClaims({ sub: "http-bearer-sub", sid: "http-bearer-sid", email: "http-bearer@promptbranch.test" }));

  // `next dev` rewrites next-env.d.ts to dev type paths; restore afterwards.
  nextEnvSnapshot = await readFile(join(process.cwd(), "next-env.d.ts"), "utf8");

  server = spawn("pnpm", ["exec", "next", "dev", "--webpack", "--port", String(PORT)], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (/error|failed/i.test(text)) console.error("[next-dev]", text.trim());
  });
  await waitForServer();
}, 180_000);

afterAll(async () => {
  if (server) {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      server.once("exit", () => resolve());
      setTimeout(resolve, 10_000);
    });
  }
  await writeFile(join(process.cwd(), "next-env.d.ts"), nextEnvSnapshot).catch(() => undefined);
  await setup.cleanup();
}, 60_000);

function post(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${ORIGIN}${path}`, {
    ...init,
    method: "POST",
    headers: { ...PROTOCOL, ...(init.headers as Record<string, string> | undefined) },
  });
}

describe("real-HTTP protocol and cache hygiene", () => {
  it("serves /info with private no-store, Vary and nosniff", async () => {
    const response = await fetch(`${ORIGIN}/api/team/v1/info`, { headers: PROTOCOL });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    // Next appends its router Vary tokens in dev; ours must be present.
    expect(response.headers.get("vary")).toContain("Cookie");
    expect(response.headers.get("vary")).toContain("Authorization");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  }, 30_000);

  it("rejects a missing protocol header with 426", async () => {
    const response = await fetch(`${ORIGIN}/api/team/v1/me`, { headers: { authorization: `Bearer ${bearer}` } });
    expect(response.status).toBe(426);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }, 30_000);
});

describe("real-HTTP CSRF and Origin enforcement", () => {
  const create = (headers: Record<string, string>) =>
    post("/api/team/v1/workspaces", { headers, body: JSON.stringify({ commandId: randomUUID(), name: "HTTP CSRF WS" }) });

  it("rejects a cookie mutation without the CSRF header", async () => {
    const response = await create({ cookie });
    expect(response.status).toBe(401);
  }, 30_000);

  it("rejects a cookie mutation with a wrong CSRF token", async () => {
    const response = await create({ cookie, "x-pb-team-csrf": "not-the-token" });
    expect(response.status).toBe(401);
  }, 30_000);

  it("rejects a cross-origin mutation even with a valid CSRF token", async () => {
    const response = await create({ cookie, "x-pb-team-csrf": csrfToken, origin: "http://evil.example" });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("Cross-origin");
  }, 30_000);

  it("rejects a request that presents both a cookie and a bearer token", async () => {
    const response = await create({ cookie, authorization: `Bearer ${bearer}` });
    expect(response.status).toBe(401);
  }, 30_000);

  it("accepts the same-origin mutation with the valid double-submit pair", async () => {
    const response = await create({ cookie, "x-pb-team-csrf": csrfToken, origin: ORIGIN });
    expect(response.status).toBe(201);
  }, 30_000);
});

describe("real-HTTP page security headers", () => {
  // Next dev overrides HTML cache-control with its own no-cache
  // instrumentation; production ships the middleware's `private, no-store`
  // (asserted exactly in middleware.test.ts). The invariant either way:
  // never public, never fresh-serving.
  function expectNeverPublic(response: Response): void {
    const cc = response.headers.get("cache-control") ?? "";
    expect(cc, `cache-control=${cc}`).not.toContain("public");
    expect(cc).toMatch(/no-store|no-cache/);
    expect(cc).not.toMatch(/max-age=[1-9]/);
  }

  it("ships the strict nonce CSP on the landing page", async () => {
    const response = await fetch(`${ORIGIN}/`);
    const csp = response.headers.get("content-security-policy") ?? "";
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src")) ?? "";
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toContain("'nonce-");
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
  }, 60_000);

  it("marks unauthenticated /team navigation private with the CSP intact", async () => {
    const response = await fetch(`${ORIGIN}/team`, { redirect: "manual" });
    expect([302, 303, 307].map((s) => s)).toContain(response.status);
    expectNeverPublic(response);
    expect(response.headers.get("content-security-policy")).toContain("'strict-dynamic'");
  }, 60_000);

  it("renders the authenticated workspace picker privately", async () => {
    const response = await fetch(`${ORIGIN}/team`, { headers: { cookie }, redirect: "manual" });
    expect(response.status).toBe(200);
    expectNeverPublic(response);
    const html = await response.text();
    expect(html).toContain("PromptBranch");
    expect(response.headers.get("set-cookie")).toBeNull();
  }, 60_000);
});

describe("real-HTTP streaming body cap", () => {
  it("rejects an oversized chunked body (no content-length) with 413", async () => {
    const chunk = "x".repeat(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 6; i++) {
          controller.enqueue(new TextEncoder().encode(chunk));
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        controller.close();
      },
    });
    const response = await post("/api/team/v1/workspaces", {
      headers: { authorization: `Bearer ${bearer}` },
      body: stream,
      // @ts-expect-error -- undici duplex is required for stream bodies
      duplex: "half",
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
  }, 60_000);
});
