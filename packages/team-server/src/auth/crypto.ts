import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** SHA-256 of a secret/token, as raw bytes for bytea columns. */
export function sha256Bytes(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

/** SHA-256 hex digest (content hashes, comparisons). */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** URL-safe random token (default 256-bit). */
export function randomTokenUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export interface SealedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  keyId: string;
}

/**
 * AES-256-GCM sealing for provider refresh tokens and correlation-state
 * blobs. The key is operator-managed and lives outside the database
 * (contract C5); the key id is stored alongside each secret so rotation can
 * distinguish old-key rows (which then simply require re-login).
 */
export class SecretBox {
  readonly keyId: string;
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error("SecretBox requires a 256-bit key (32 bytes)");
    }
    this.key = key;
    this.keyId = sha256Hex(key).slice(0, 12);
  }

  static fromBase64(encoded: string): SecretBox {
    return new SecretBox(Buffer.from(encoded, "base64"));
  }

  seal(plaintext: string | Buffer): SealedSecret {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { ciphertext, nonce, keyId: this.keyId };
  }

  open(sealed: Pick<SealedSecret, "ciphertext" | "nonce" | "keyId">): Buffer {
    if (sealed.keyId !== this.keyId) {
      throw new Error("sealed secret was written under a different encryption key");
    }
    const ciphertext = sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16);
    const authTag = sealed.ciphertext.subarray(sealed.ciphertext.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", this.key, sealed.nonce);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  sealToString(plaintext: string): string {
    const sealed = this.seal(plaintext);
    return Buffer.concat([Buffer.from(sealed.keyId, "ascii"), sealed.nonce, sealed.ciphertext]).toString("base64url");
  }

  openFromString(encoded: string): string {
    const raw = Buffer.from(encoded, "base64url");
    const keyId = raw.subarray(0, 12).toString("ascii");
    const nonce = raw.subarray(12, 24);
    const ciphertext = raw.subarray(24);
    return this.open({ ciphertext, nonce, keyId }).toString("utf8");
  }
}

/** Constant-time comparison of two secrets given as strings or buffers. */
export function secretsMatch(a: string | Buffer, b: string | Buffer): boolean {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a, "utf8");
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
