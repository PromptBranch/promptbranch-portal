import { describe, expect, it } from "vitest";
import { isLoopbackHostname, normalizeTeamOrigin, TeamOriginError } from "../src/origin.js";

describe("normalizeTeamOrigin", () => {
  it("canonicalizes https origins and drops the default port", () => {
    expect(normalizeTeamOrigin("https://team.example.com")).toBe("https://team.example.com");
    expect(normalizeTeamOrigin("https://team.example.com/")).toBe("https://team.example.com");
    expect(normalizeTeamOrigin("https://team.example.com:443")).toBe("https://team.example.com");
    expect(normalizeTeamOrigin("HTTPS://Team.Example.COM:8443")).toBe("https://team.example.com:8443");
  });

  it("allows http only on explicit loopback development origins (C2)", () => {
    expect(normalizeTeamOrigin("http://127.0.0.1:4318")).toBe("http://127.0.0.1:4318");
    expect(normalizeTeamOrigin("http://127.0.0.1")).toBe("http://127.0.0.1");
    expect(normalizeTeamOrigin("http://[::1]:4318")).toBe("http://[::1]:4318");
    expect(normalizeTeamOrigin("http://localhost:4318")).toBe("http://localhost:4318");
  });

  it("rejects http on non-loopback hosts", () => {
    expect(() => normalizeTeamOrigin("http://team.example.com")).toThrow(TeamOriginError);
    expect(() => normalizeTeamOrigin("http://192.168.1.10:4318")).toThrow(TeamOriginError);
    expect(() => normalizeTeamOrigin("http://10.0.0.4")).toThrow(TeamOriginError);
  });

  it("rejects credentials embedded in the URL (C2)", () => {
    expect(() => normalizeTeamOrigin("https://user:pass@team.example.com")).toThrow(TeamOriginError);
    expect(() => normalizeTeamOrigin("https://token@team.example.com")).toThrow(TeamOriginError);
  });

  it("rejects non-http(s) schemes and unparseable input", () => {
    expect(() => normalizeTeamOrigin("ftp://team.example.com")).toThrow(TeamOriginError);
    expect(() => normalizeTeamOrigin("file:///etc/passwd")).toThrow(TeamOriginError);
    expect(() => normalizeTeamOrigin("team.example.com")).toThrow(TeamOriginError);
    expect(() => normalizeTeamOrigin("")).toThrow(TeamOriginError);
  });

  it("rejects path prefixes, query strings and fragments instead of silently trimming", () => {
    expect(() => normalizeTeamOrigin("https://team.example.com/api")).toThrow(TeamOriginError);
    expect(() => normalizeTeamOrigin("https://team.example.com/?x=1")).toThrow(TeamOriginError);
    expect(() => normalizeTeamOrigin("https://team.example.com/#frag")).toThrow(TeamOriginError);
  });

  it("never throws an error containing the rejected URL", () => {
    const secretish = "https://user:hunter2@team.example.com/api";
    try {
      normalizeTeamOrigin(secretish);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("hunter2");
    }
  });
});

describe("isLoopbackHostname", () => {
  it("recognizes the loopback forms the client accepts", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.5.6.7")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("rejects lookalikes", () => {
    expect(isLoopbackHostname("127.0.0.1.evil.test")).toBe(false);
    expect(isLoopbackHostname("localhost.evil.test")).toBe(false);
    expect(isLoopbackHostname("127.999.1.1")).toBe(false);
    expect(isLoopbackHostname("::1")).toBe(false);
    expect(isLoopbackHostname("2130706433")).toBe(false);
  });
});
