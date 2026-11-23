import { z } from "zod";

export const ServerConfig = z.object({
  origin: z.string().url(),
  passphraseHash: z.string().min(1),
  sessionKey: z.string().min(32),
  encryptionKey: z.string().min(1),
}).refine((value) => {
  const url = new URL(value.origin);
  return url.origin === value.origin && (url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost");
}, { message: "APP_ORIGIN must be an exact HTTPS origin or loopback for local QA" });

export type ServerConfig = z.infer<typeof ServerConfig>;

export function loadServerConfig(): ServerConfig {
  return ServerConfig.parse({
    origin: process.env["APP_ORIGIN"],
    passphraseHash: process.env["PASSPHRASE_HASH"],
    sessionKey: process.env["SESSION_KEY"],
    encryptionKey: process.env["ENCRYPTION_KEY"],
  });
}
