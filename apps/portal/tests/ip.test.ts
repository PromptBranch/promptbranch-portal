import { describe, expect, it } from "vitest";
import { clientIp, hashIp } from "@/lib/ip";

describe("clientIp", () => {
  it("takes the last x-forwarded-for entry (the hop the trusted proxy appended)", () => {
    const request = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(clientIp(request)).toBe("10.0.0.1");
  });

  it("takes a single-entry header as-is", () => {
    const request = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(clientIp(request)).toBe("203.0.113.5");
  });

  it("skips empty entries when picking the last hop", () => {
    const request = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1, , " },
    });
    expect(clientIp(request)).toBe("10.0.0.1");
  });

  it("falls back to 'unknown' without the header", () => {
    expect(clientIp(new Request("http://localhost/"))).toBe("unknown");
  });

  it("falls back to 'unknown' when every entry is empty", () => {
    const request = new Request("http://localhost/", {
      headers: { "x-forwarded-for": " , , " },
    });
    expect(clientIp(request)).toBe("unknown");
  });
});

describe("hashIp", () => {
  it("is stable within a day and rotates across days", () => {
    const day = new Date("2026-08-25T10:00:00.000Z");
    const sameDay = new Date("2026-08-25T23:59:59.000Z");
    const nextDay = new Date("2026-08-26T00:00:01.000Z");
    expect(hashIp("1.2.3.4", day)).toBe(hashIp("1.2.3.4", sameDay));
    expect(hashIp("1.2.3.4", day)).not.toBe(hashIp("1.2.3.4", nextDay));
    expect(hashIp("1.2.3.4", day)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never contains the raw ip", () => {
    expect(hashIp("1.2.3.4")).not.toContain("1.2.3.4");
  });
});
