import { describe, expect, it } from "vitest";
import { getEnv } from "@/lib/env";

describe("getEnv", () => {
  it("applies defaults for an empty environment", () => {
    expect(getEnv({})).toEqual({
      PUBLIC_BASE_URL: "http://localhost:3000",
      PORT: 3000,
      DATA_DIR: "./data",
    });
  });

  it("parses provided values, coercing PORT", () => {
    const env = getEnv({
      PUBLIC_BASE_URL: "http://203.0.113.10:3000",
      PORT: "8080",
      DATA_DIR: "/data",
    });
    expect(env.PUBLIC_BASE_URL).toBe("http://203.0.113.10:3000");
    expect(env.PORT).toBe(8080);
    expect(env.DATA_DIR).toBe("/data");
  });

  it("accepts a bare IP:port base URL (no domain required)", () => {
    expect(getEnv({ PUBLIC_BASE_URL: "http://192.168.1.20:3000" }).PUBLIC_BASE_URL).toBe(
      "http://192.168.1.20:3000",
    );
  });

  it("rejects an invalid base URL and a non-numeric port", () => {
    expect(() => getEnv({ PUBLIC_BASE_URL: "not a url" })).toThrow();
    expect(() => getEnv({ PORT: "lots" })).toThrow();
  });
});
