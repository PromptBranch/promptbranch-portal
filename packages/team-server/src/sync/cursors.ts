import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Opaque signed tokens for bootstrap paging and future cursor needs
 * (contract §C7): bound to snapshot + offset, tamper-evident under an
 * operator-managed key. The key is TEAM_CURSOR_SIGNING_KEY when provided;
 * otherwise it is domain-separated from the session encryption key so a
 * single-operator deployment still gets unforgeable tokens.
 */

export class CursorSigner {
  private readonly key: Buffer;

  constructor(keyMaterial: Buffer, private readonly domain = "pb-team-cursor-v1") {
    this.key = createHmac("sha256", keyMaterial).update(domain).digest();
  }

  static fromEnv(options: { cursorKeyBase64?: string; sessionKeyBase64?: string }): CursorSigner {
    const source = options.cursorKeyBase64
      ? Buffer.from(options.cursorKeyBase64, "base64")
      : options.sessionKeyBase64
        ? Buffer.from(options.sessionKeyBase64, "base64")
        : null;
    if (!source || source.length === 0) {
      throw new Error("CursorSigner requires TEAM_CURSOR_SIGNING_KEY or TEAM_SESSION_ENCRYPTION_KEY");
    }
    return new CursorSigner(source, options.cursorKeyBase64 ? "pb-team-cursor-v1" : "pb-team-cursor-derived-v1");
  }

  sign(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const signature = createHmac("sha256", this.key).update(body).digest("base64url");
    return `${body.toString("base64url")}.${signature}`;
  }

  /** Verifies and decodes; returns null for any tampered or malformed token. */
  verify<T extends Record<string, unknown>>(token: string): T | null {
    const [body, signature] = token.split(".", 2);
    if (!body || !signature) return null;
    let expected: string;
    let decoded: Buffer;
    try {
      decoded = Buffer.from(body, "base64url");
      expected = createHmac("sha256", this.key).update(decoded).digest("base64url");
    } catch {
      return null;
    }
    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      return JSON.parse(decoded.toString("utf8")) as T;
    } catch {
      return null;
    }
  }
}
