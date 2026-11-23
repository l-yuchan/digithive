import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { SecretVault } from "../server/secrets";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

export type GoogleConfig = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly authUrl: string;
  readonly tokenUrl: string;
};

export class GoogleAuthError extends Error {
  constructor(readonly kind: "state_mismatch" | "invalid_grant" | "token_unavailable" | "no_refresh_token") {
    super(kind);
    this.name = "GoogleAuthError";
  }
}

const Tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export type StoredCredential = {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number;
  readonly scope: string;
};

export type TokenExchange = { readonly tokens: z.infer<typeof Tokens> };

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function beginAuthorization(db: Database, provider: string, redirectUri: string, now = Date.now()): {
  readonly state: string;
  readonly challenge: string;
} {
  const state = randomBytes(24).toString("base64url");
  const { verifier, challenge } = pkce();
  db.query("INSERT INTO oauth_pending (state,provider,code_verifier,redirect_uri,created_at) VALUES (?,?,?,?,?)")
    .run(state, provider, verifier, redirectUri, new Date(now).toISOString());
  return { state, challenge };
}

export function authorizationUrl(config: GoogleConfig, state: string, challenge: string): string {
  const url = new URL(config.authUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCode(
  config: GoogleConfig,
  code: string,
  verifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<z.infer<typeof Tokens>> {
  const response = await fetchFn(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new GoogleAuthError("invalid_grant");
  const parsed = Tokens.safeParse(await response.json());
  if (!parsed.success) throw new GoogleAuthError("invalid_grant");
  return parsed.data;
}

async function refresh(
  config: GoogleConfig, refreshToken: string, fetchFn: typeof fetch,
): Promise<z.infer<typeof Tokens>> {
  const response = await fetchFn(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 400 || response.status === 401) throw new GoogleAuthError("invalid_grant");
  if (!response.ok) throw new GoogleAuthError("token_unavailable");
  const parsed = Tokens.safeParse(await response.json());
  if (!parsed.success) throw new GoogleAuthError("token_unavailable");
  return parsed.data;
}

function loadCredential(db: Database, vault: SecretVault, connectionId: string): StoredCredential {
  const row = db.query("SELECT credential_ciphertext, scopes_json FROM connections WHERE id = ?").get(connectionId);
  const parsed = z.object({ credential_ciphertext: z.instanceof(Uint8Array), scopes_json: z.string() })
    .safeParse(row);
  if (!parsed.success) throw new GoogleAuthError("token_unavailable");
  return z.object({
    accessToken: z.string(), refreshToken: z.string().nullable(), expiresAt: z.number(), scope: z.string(),
  }).parse(JSON.parse(vault.decrypt(parsed.data.credential_ciphertext)));
}

function saveCredential(
  db: Database, vault: SecretVault, connectionId: string, credential: StoredCredential, now: number,
): void {
  db.query("UPDATE connections SET credential_ciphertext = ?, sync_status = 'connected' WHERE id = ?")
    .run(vault.encrypt(JSON.stringify(credential)), connectionId);
  void now;
}

export function storeConnection(
  db: Database, vault: SecretVault, provider: string, tokens: z.infer<typeof Tokens>, now = Date.now(),
): string {
  const credential: StoredCredential = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: now + tokens.expires_in * 1_000,
    scope: tokens.scope ?? GOOGLE_SCOPES.join(" "),
  };
  const existing = db.query("SELECT id, credential_ciphertext FROM connections WHERE provider = ?").get(provider);
  const parsed = z.object({ id: z.string(), credential_ciphertext: z.instanceof(Uint8Array).nullable() }).safeParse(existing);
  if (parsed.success) {
    // A reconnect that omits the refresh token keeps the previous one: Google
    // only returns it on the first consent.
    let keepRefresh: string | null = credential.refreshToken;
    if (!keepRefresh && parsed.data.credential_ciphertext) {
      try {
        keepRefresh = loadCredential(db, vault, parsed.data.id).refreshToken;
      } catch (error) {
        if (!(error instanceof GoogleAuthError)) throw error;
      }
    }
    saveCredential(db, vault, parsed.data.id, { ...credential, refreshToken: keepRefresh }, now);
    return parsed.data.id;
  }
  const id = crypto.randomUUID();
  db.query(`INSERT INTO connections (id,provider,scopes_json,credential_ciphertext,sync_status)
    VALUES (?,?,?,?, 'connected')`)
    .run(id, provider, JSON.stringify(credential.scope.split(" ")), vault.encrypt(JSON.stringify(credential)));
  return id;
}

const inflight = new Map<string, Promise<string>>();

/** Returns a usable access token, refreshing once across concurrent callers.
 * A refresh that Google rejects marks the connection as needing re-auth instead
 * of silently returning a stale token. */
export async function ensureAccessToken(
  db: Database, vault: SecretVault, config: GoogleConfig, connectionId: string,
  now = Date.now(), fetchFn: typeof fetch = fetch,
): Promise<{ token: string; state: "valid" | "refreshed" }> {
  const credential = loadCredential(db, vault, connectionId);
  if (credential.expiresAt > now + 60_000) return { token: credential.accessToken, state: "valid" };
  const pending = inflight.get(connectionId);
  if (pending) return { token: await pending, state: "refreshed" };
  const work = (async (): Promise<string> => {
    if (!credential.refreshToken) throw new GoogleAuthError("no_refresh_token");
    try {
      const tokens = await refresh(config, credential.refreshToken, fetchFn);
      const next: StoredCredential = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? credential.refreshToken,
        expiresAt: now + tokens.expires_in * 1_000,
        scope: tokens.scope ?? credential.scope,
      };
      saveCredential(db, vault, connectionId, next, now);
      return next.accessToken;
    } catch (error) {
      if (error instanceof GoogleAuthError) {
        db.query("UPDATE connections SET sync_status = 'needs_reauth' WHERE id = ?").run(connectionId);
      }
      throw error;
    } finally {
      inflight.delete(connectionId);
    }
  })();
  inflight.set(connectionId, work);
  return { token: await work, state: "refreshed" };
}

export function consumeState(db: Database, state: string, provider: string): { verifier: string; redirectUri: string } {
  const row = db.query("SELECT provider, code_verifier, redirect_uri, created_at FROM oauth_pending WHERE state = ?")
    .get(state);
  const parsed = z.object({
    provider: z.string(), code_verifier: z.string(), redirect_uri: z.string(), created_at: z.string(),
  }).safeParse(row);
  if (!parsed.success || parsed.data.provider !== provider) throw new GoogleAuthError("state_mismatch");
  db.query("DELETE FROM oauth_pending WHERE state = ?").run(state);
  const age = Date.now() - Date.parse(parsed.data.created_at);
  if (!Number.isFinite(age) || age > 10 * 60 * 1_000) throw new GoogleAuthError("state_mismatch");
  return { verifier: parsed.data.code_verifier, redirectUri: parsed.data.redirect_uri };
}

export function disconnect(db: Database, connectionId: string): boolean {
  const result = db.query("UPDATE connections SET credential_ciphertext = NULL, sync_status = 'disconnected' WHERE id = ?")
    .run(connectionId);
  return result.changes === 1;
}

export function googleConfig(): GoogleConfig {
  const file = process.env["GOOGLE_CLIENT_SECRET_FILE"];
  if (file) {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const block = z.object({
      client_id: z.string().min(1), client_secret: z.string().min(1),
      auth_uri: z.string().url().optional(), token_uri: z.string().url().optional(),
    });
    const wrapper = z.object({ installed: block.optional(), web: block.optional() }).safeParse(raw);
    const credentials = wrapper.success ? wrapper.data.installed ?? wrapper.data.web : undefined;
    if (!credentials) throw new GoogleAuthError("token_unavailable");
    const origin = process.env["APP_ORIGIN"];
    const redirectUri = process.env["GOOGLE_REDIRECT_URI"] ?? (origin ? `${origin}/api/oauth/google/callback` : undefined);
    if (!redirectUri) throw new GoogleAuthError("token_unavailable");
    return {
      clientId: credentials.client_id,
      clientSecret: credentials.client_secret,
      redirectUri,
      authUrl: credentials.auth_uri ?? "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: credentials.token_uri ?? "https://oauth2.googleapis.com/token",
    };
  }
  const read = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new GoogleAuthError("token_unavailable");
    return value;
  };
  return {
    clientId: read("GOOGLE_CLIENT_ID"),
    clientSecret: read("GOOGLE_CLIENT_SECRET"),
    redirectUri: read("GOOGLE_REDIRECT_URI"),
    authUrl: process.env["GOOGLE_AUTH_URL"] ?? "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: process.env["GOOGLE_TOKEN_URL"] ?? "https://oauth2.googleapis.com/token",
  };
}
