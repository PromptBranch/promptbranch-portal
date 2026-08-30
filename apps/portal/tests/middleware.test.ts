import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import robots from "@/app/robots";

describe("middleware security headers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sets the full header set on every response", () => {
    const response = middleware(new NextRequest("http://localhost/p/V1StGXR8_Z5jdHi6B-myT"));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("emits a nonce-based strict CSP with no third-party origins", () => {
    const csp = middleware(new NextRequest("http://localhost/")).headers.get("content-security-policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("https://");
    // vitest runs with NODE_ENV=test, so this is the production branch.
    expect(csp).not.toContain("unsafe-eval");
  });

  it("adds 'unsafe-eval' to script-src in development only", () => {
    // react-refresh evaluates module code with eval; HMR dies without this.
    vi.stubEnv("NODE_ENV", "development");
    const csp = middleware(new NextRequest("http://localhost/")).headers.get("content-security-policy");
    expect(csp).toContain("unsafe-eval");
  });

  it("generates a fresh nonce per request", () => {
    const first = middleware(new NextRequest("http://localhost/")).headers.get("content-security-policy");
    const second = middleware(new NextRequest("http://localhost/")).headers.get("content-security-policy");
    expect(first).not.toBe(second);
  });
});

describe("robots.txt", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps snapshots and the API unlisted while the site stays indexable", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://portal.example");
    const result = robots();
    expect(result.rules).toEqual({ userAgent: "*", disallow: ["/p/", "/api/"] });
    expect(result.sitemap).toBe("https://portal.example/sitemap.xml");
  });
});
