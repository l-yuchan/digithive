import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class SecretKeyError extends Error {
  constructor() {
    super("ENCRYPTION_KEY must be 32 base64-encoded bytes");
    this.name = "SecretKeyError";
  }
}

export class SecretVault {
  private readonly key: Buffer;

  constructor(encodedKey: string) {
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== 32 || key.toString("base64") !== encodedKey) {
      throw new SecretKeyError();
    }
    this.key = key;
  }

  encrypt(value: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  }

  decrypt(value: Uint8Array): string {
    if (value.length < 28) throw new SecretKeyError();
    const nonce = value.subarray(0, 12);
    const tag = value.subarray(12, 28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
  }
}
