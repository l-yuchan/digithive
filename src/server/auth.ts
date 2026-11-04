import { createHmac, timingSafeEqual } from "node:crypto";
import { jsonReply } from "./api_util";

// Minimal passphrase gate. Empty passphrase disables auth (local-first).
// When set, every /api route except the auth endpoints needs the session
// cookie issued by POST /api/auth/login. The cookie is an HMAC over an expiry
// timestamp keyed by a secret derived from the passphrase, so sessions survive
// restart and are all invalidated when the passphrase changes. Login failures
// are rate-limited per client IP (X-Forwarded-For when behind Caddy).

const COOKIE_NAME = "digithive_session";
const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 15 * 60;

export interface AuthOptions {
  passphrase: string;
  secureCookie: boolean;
  sessionTtlSeconds: number;
}

function sha256(value: string): Buffer {
  return createHmac("sha256", "digithive-auth-v1").update(value, "utf8").digest();
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function cookieHeader(value: string, secure: boolean, maxAge: number): string {
  const secureAttr = secure ? "; Secure" : "";
  return COOKIE_NAME + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge + secureAttr;
}

function clearCookieHeader(secure: boolean): string {
  const secureAttr = secure ? "; Secure" : "";
  return COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + secureAttr;
}

export class AuthGate {
  readonly enabled: boolean;
  private readonly secret: Buffer;
  private readonly secureCookie: boolean;
  private readonly sessionTtlSeconds: number;
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(options: AuthOptions) {
    this.enabled = options.passphrase.length > 0;
    this.secret = sha256(options.passphrase);
    this.secureCookie = options.secureCookie;
    this.sessionTtlSeconds = options.sessionTtlSeconds;
  }

  authenticated(req: Request): boolean {
    if (!this.enabled) return true;
    const token = readCookie(req.headers.get("cookie"), COOKIE_NAME);
    return token !== null && this.verifyToken(token);
  }

  status(req: Request): Response {
    return jsonReply(200, {
      enabled: this.enabled,
      authenticated: this.enabled ? this.authenticated(req) : true,
    });
  }

  async login(req: Request, clientIp: string): Promise<Response> {
    if (!this.enabled) return jsonReply(200, { authenticated: true });
    if (this.isLocked(clientIp)) {
      return jsonReply(429, {
        error: { code: "auth_invalid", message: "too many attempts; try again later" },
      });
    }
    const passphrase = await readPassphrase(req);
    if (passphrase === null || !this.matches(passphrase)) {
      this.recordFailure(clientIp);
      return jsonReply(401, {
        error: { code: "auth_invalid", message: "incorrect passphrase" },
      });
    }
    this.failures.delete(clientIp);
    const expiry = Math.floor(Date.now() / 1000) + this.sessionTtlSeconds;
    const token = expiry + "." + this.sign(String(expiry));
    return new Response(JSON.stringify({ authenticated: true }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": cookieHeader(token, this.secureCookie, this.sessionTtlSeconds),
      },
    });
  }

  logout(): Response {
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": clearCookieHeader(this.secureCookie),
      },
    });
  }

  private verifyToken(token: string): boolean {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return false;
    const expiry = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (!safeEqual(this.sign(expiry), signature)) return false;
    const expirySeconds = Number(expiry);
    return Number.isFinite(expirySeconds) && expirySeconds > Math.floor(Date.now() / 1000);
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload, "utf8").digest("base64url");
  }

  private matches(passphrase: string): boolean {
    return safeEqual(sha256(passphrase).toString("base64url"), this.secret.toString("base64url"));
  }

  private isLocked(clientIp: string): boolean {
    const entry = this.failures.get(clientIp);
    if (!entry) return false;
    if (entry.count < MAX_ATTEMPTS) return false;
    if (Date.now() >= entry.until) {
      this.failures.delete(clientIp);
      return false;
    }
    return true;
  }

  private recordFailure(clientIp: string): void {
    const entry = this.failures.get(clientIp) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= MAX_ATTEMPTS) entry.until = Date.now() + LOCK_SECONDS * 1000;
    this.failures.set(clientIp, entry);
  }
}

async function readPassphrase(req: Request): Promise<string | null> {
  try {
    const raw: unknown = await req.json();
    if (raw === null || typeof raw !== "object") return null;
    const value = (raw as Record<string, unknown>)["passphrase"];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
