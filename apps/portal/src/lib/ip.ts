import { createHash } from "node:crypto";

/**
 * Last non-empty x-forwarded-for hop. Trust model: correct only when a proxy
 * that appends (or overwrites) XFF sits in front — Caddy appends the real
 * client IP as the final entry, and while an attacker can prepend fake hops
 * they cannot forge what the proxy appends. With no such proxy (portal
 * directly exposed) the whole header is client-supplied and rate limiting is
 * best-effort.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return "unknown";
}

/**
 * sha256 of IP + daily salt: enough to correlate abuse within a day for
 * investigation, useless for tracking anyone across days. The raw IP is
 * never stored.
 */
export function hashIp(ip: string, date: Date = new Date()): string {
  return createHash("sha256").update(`${date.toISOString().slice(0, 10)}:${ip}`, "utf8").digest("hex");
}
