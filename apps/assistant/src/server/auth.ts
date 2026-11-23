import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { ServerConfig } from "../contracts/config";

const Login = z.object({ passphrase: z.string().min(1).max(1024) }).strict();
const COOKIE = "assistant_session";
const SESSION_SECONDS = 30 * 24 * 3600;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

export class AuthenticationError extends Error {
  constructor(readonly kind: "invalid_hash") {
    super(kind);
    this.name = "AuthenticationError";
  }
}

export function hashPassphrase(value: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(value, salt, 64);
  return `scrypt:${salt.toString("base64url")}:${digest.toString("base64url")}`;
}

function verifyPassphrase(value: string, encoded: string): boolean {
  const [algorithm, rawSalt, rawDigest] = encoded.split(":");
  if (algorithm !== "scrypt" || !rawSalt || !rawDigest) {
    throw new AuthenticationError("invalid_hash");
  }
  const salt = Buffer.from(rawSalt, "base64url");
  const expected = Buffer.from(rawDigest, "base64url");
  if (salt.length !== 16 || expected.length !== 64) {
    throw new AuthenticationError("invalid_hash");
  }
  return timingSafeEqual(scryptSync(value, salt, expected.length), expected);
}

function cookie(request: Request): string | undefined {
  return request.headers.get("cookie")?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
}

function cookieHeader(token: string, secure: boolean, age: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`;
}

export class AuthGate {
  private failures = 0;
  private lockedUntil = 0;
  readonly origin: URL;

  constructor(private readonly db: Database, private readonly config: ServerConfig) {
    this.origin = new URL(config.origin);
    verifyPassphrase("", config.passphraseHash);
  }

  private tokenHash(token: string): string {
    return createHmac("sha256", this.config.sessionKey).update(token).digest("hex");
  }

  sameOrigin(request: Request, mutation: boolean): boolean {
    const host = request.headers.get("host");
    if (host !== this.origin.host) return false;
    if (!mutation) return true;
    return request.headers.get("origin") === this.origin.origin;
  }

  authenticated(request: Request, now = Date.now()): boolean {
    const token = cookie(request);
    if (!token) return false;
    const tokenHash = this.tokenHash(token);
    const row = this.db.query("SELECT expires_at FROM sessions WHERE token_hash = ?").get(tokenHash);
    if (!row || typeof row !== "object" || !("expires_at" in row)) return false;
    return typeof row.expires_at === "string" && Date.parse(row.expires_at) > now;
  }

  async login(request: Request, now = Date.now()): Promise<Response> {
    if (this.lockedUntil > now) return Response.json({ error: "login_limited" }, { status: 429 });
    let body: unknown;
    try {
      if (request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
        const form = await request.formData();
        body = { passphrase: form.get("passphrase") };
      } else {
        body = await request.json();
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
      return Response.json({ error: "invalid_input" }, { status: 422 });
    }
    const parsed = Login.safeParse(body);
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 422 });
    if (!verifyPassphrase(parsed.data.passphrase, this.config.passphraseHash)) {
      this.failures++;
      if (this.failures >= MAX_FAILURES) this.lockedUntil = now + LOCK_MS;
      return Response.json({ error: "invalid_credentials" }, { status: 401 });
    }
    this.failures = 0;
    this.lockedUntil = 0;
    const token = randomBytes(32).toString("base64url");
    this.db.query("INSERT INTO sessions (token_hash,expires_at,created_at) VALUES (?,?,?)")
      .run(this.tokenHash(token), new Date(now + SESSION_SECONDS * 1000).toISOString(), new Date(now).toISOString());
    const headers = { "set-cookie": cookieHeader(token, this.origin.protocol === "https:", SESSION_SECONDS) };
    return request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")
      ? new Response(null, { status: 303, headers: { ...headers, location: "/" } })
      : Response.json({ authenticated: true }, { headers });
  }

  logout(request: Request): Response {
    const token = cookie(request);
    if (token) {
      this.db.query("DELETE FROM sessions WHERE token_hash = ?")
        .run(this.tokenHash(token));
    }
    return Response.json({ authenticated: false }, {
      headers: { "set-cookie": cookieHeader("", this.origin.protocol === "https:", 0) },
    });
  }
}
