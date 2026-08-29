import { describe, expect, it } from "vitest";
import { createRateLimiter, publishLimiter, readLimiter, reportLimiter } from "@/lib/rate-limit";

describe("createRateLimiter", () => {
  it("allows up to capacity requests, then rejects with a retry delay", () => {
    const limiter = createRateLimiter({ capacity: 2, windowMs: 60_000, now: () => 0 });
    expect(limiter.check("ip")).toEqual({ ok: true, retryAfterSeconds: 0 });
    expect(limiter.check("ip")).toEqual({ ok: true, retryAfterSeconds: 0 });
    const third = limiter.check("ip");
    expect(third.ok).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter({ capacity: 1, windowMs: 60_000, now: () => 0 });
    expect(limiter.check("a").ok).toBe(true);
    expect(limiter.check("b").ok).toBe(true);
    expect(limiter.check("a").ok).toBe(false);
  });

  it("evicts the oldest buckets when a flood of fresh keys keeps the map full", () => {
    let now = 0;
    const limiter = createRateLimiter({ capacity: 1, windowMs: 60_000, now: () => now });
    // >10k distinct keys inside a single window: the stale sweep frees
    // nothing, so eviction is observed behaviorally — an evicted key gets a
    // fresh full bucket back, a surviving key keeps its spent token.
    for (let i = 0; i <= 10_000; i++) {
      now = i;
      limiter.check(`ip-${i}`);
    }
    expect(limiter.check("ip-0").ok).toBe(true);
    now = 10_001;
    expect(limiter.check("ip-10000").ok).toBe(false);
  });

  it("refills tokens as time passes", () => {
    let now = 0;
    const limiter = createRateLimiter({ capacity: 2, windowMs: 60_000, now: () => now });
    limiter.check("ip");
    limiter.check("ip");
    expect(limiter.check("ip").ok).toBe(false);
    now = 30_000; // half a window: one token back
    expect(limiter.check("ip").ok).toBe(true);
  });
});

describe("spec rate limits", () => {
  it("publish allows 10/hour, reports 5/hour, reads 300/minute", () => {
    const ip = `test-${Math.random()}`;
    for (let i = 0; i < 10; i++) expect(publishLimiter.check(`${ip}-pub`).ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(reportLimiter.check(`${ip}-rep`).ok).toBe(true);
    for (let i = 0; i < 300; i++) expect(readLimiter.check(`${ip}-read`).ok).toBe(true);
    expect(publishLimiter.check(`${ip}-pub2`).ok).toBe(true); // different key unaffected
  });
});
