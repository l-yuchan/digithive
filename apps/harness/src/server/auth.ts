import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";

export type AuthConfig = {
  /** Empty disables authentication (local development only). */
  readonly passphrase: string;
  readonly secret: string;
  readonly ttlMs?: number;
};

export const COOKIE_NAME = "dh_session";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function checkPassphrase(config: AuthConfig, candidate: string): boolean {
  if (config.passphrase.length === 0) return true;
  return timingSafeEqual(digest(candidate), digest(config.passphrase));
}

function sign(config: AuthConfig, payload: string): string {
  return createHmac("sha256", config.secret).update(payload).digest("base64url");
}

export function issueCookie(config: AuthConfig, now = Date.now()): string {
  const expires = now + (config.ttlMs ?? 30 * 24 * 60 * 60 * 1000);
  const payload = Buffer.from(JSON.stringify({ exp: expires }), "utf8").toString("base64url");
  return `${payload}.${sign(config, payload)}`;
}

export function verifyCookie(config: AuthConfig, cookie: string | null, now = Date.now()): boolean {
  if (config.passphrase.length === 0) return true;
  if (!cookie) return false;
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) return false;
  const expected = sign(config, payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const parsed = z
      .object({ exp: z.unknown().optional() })
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return typeof parsed.exp === "number" && parsed.exp > now;
  } catch {
    return false;
  }
}

export function readCookie(header: string | null, name = COOKIE_NAME): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

/** The tab routes the shell answers, mirrored from app.ts to keep the gate list honest. */
export const TAB_ROUTE =
  /^\/(chat(?:\/[^/]+)?|work|workflows|connections|knowledge|whiteboard)\/?$/;

/** Routes that must work before login so the client can render its gate. */
export function isPublicRoute(path: string, method: string): boolean {
  if (path === "/" || path === "/index.html" || path === "/main.js" || path === "/styles.css")
    return true;
  // The tab routes (see app.ts TAB_ROUTE) are the client's own: the shell behind them
  // carries the login gate, exactly like "/". Nothing else becomes public for this.
  if (TAB_ROUTE.test(path)) return true;
  if (path === "/api/session") return true;
  if (path === "/api/login" && method === "POST") return true;
  if (path === "/api/logout" && method === "POST") return true;
  if (path === "/api/health") return true;
  if (path === "/api/oauth/google/callback" && method === "GET") return true;
  return false;
}
