export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * In-memory per-IP token bucket. The portal deploys as a single instance
 * (spec: ops), so process-local state is sufficient and keeps the abuse
 * surface dependency-free.
 */
export function createRateLimiter(options: {
  capacity: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const { capacity, windowMs } = options;
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();
  return {
    check(key) {
      const at = now();
      // Unbounded distinct IPs would grow the map forever; sweep stale
      // buckets once the table is under pressure. A flood of fresh keys
      // defeats the stale sweep, so fall back to evicting the
      // least-recently-updated buckets to keep the table bounded.
      if (buckets.size > 10_000) {
        for (const [k, bucket] of buckets) {
          if (at - bucket.updatedAt > windowMs) buckets.delete(k);
        }
        if (buckets.size > 10_000) {
          const byAge = [...buckets.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
          for (const [k] of byAge.slice(0, buckets.size - 10_000)) buckets.delete(k);
        }
      }
      const existing = buckets.get(key);
      const tokens = existing
        ? Math.min(capacity, existing.tokens + ((at - existing.updatedAt) / windowMs) * capacity)
        : capacity;
      if (tokens >= 1) {
        buckets.set(key, { tokens: tokens - 1, updatedAt: at });
        return { ok: true, retryAfterSeconds: 0 };
      }
      buckets.set(key, { tokens, updatedAt: at });
      const msUntilToken = ((1 - tokens) * windowMs) / capacity;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(msUntilToken / 1000)) };
    },
  };
}

export const publishLimiter = createRateLimiter({ capacity: 10, windowMs: 3_600_000 });
export const reportLimiter = createRateLimiter({ capacity: 5, windowMs: 3_600_000 });
export const readLimiter = createRateLimiter({ capacity: 300, windowMs: 60_000 });
