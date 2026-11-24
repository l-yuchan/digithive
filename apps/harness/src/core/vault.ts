import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Provider tokens are encrypted at rest with a key derived from the deployment
 * secret. The key never leaves the process; the stored value is AES-256-GCM
 * with a random IV and the auth tag appended.
 */
function keyFrom(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function seal(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${body.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function open(secret: string, sealed: string): string | null {
  const [ivPart, bodyPart, tagPart] = sealed.split(".");
  if (!ivPart || !bodyPart || !tagPart) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyFrom(secret),
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(bodyPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
