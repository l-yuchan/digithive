import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { seal, open } from "../core/vault";
import { applyAccountEmail, getAccount } from "./account-store";
import { z } from "zod";

export type GoogleConfig = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
};

/** openid/email make a verified account identity available on every connection. */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

export type GoogleTokens = {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number;
  readonly scope: string | null;
};

export function authUrl(config: GoogleConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GOOGLE_SCOPES.join(" "),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

const TokenResponseSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
});
type TokenResponse = z.infer<typeof TokenResponseSchema>;
const SavedTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  expiresAt: z.number(),
  scope: z.string().nullable(),
});

function parseTokens(
  body: TokenResponse,
  previousRefresh: string | null,
  now: number,
): GoogleTokens {
  if (typeof body.error === "string") throw new Error(`oauth_error:${body.error}`);
  if (typeof body.access_token !== "string") throw new Error("oauth_missing_access_token");
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3_600;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : previousRefresh,
    expiresAt: now + expiresIn * 1_000,
    scope: typeof body.scope === "string" ? body.scope : null,
  };
}

async function tokenRequest(
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!response.ok) throw new Error(`oauth_http_${response.status}`);
  return TokenResponseSchema.parse(await response.json());
}

export async function exchangeCode(
  config: GoogleConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<GoogleTokens> {
  const body = await tokenRequest(
    {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    },
    fetchImpl,
  );
  return parseTokens(body, null, now);
}

export async function refreshTokens(
  config: GoogleConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<GoogleTokens> {
  const body = await tokenRequest(
    {
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    },
    fetchImpl,
  );
  return parseTokens(body, refreshToken, now);
}

/**
 * Stores credentials under one account. When the provider omits a replacement
 * refresh token (a reconnect or a refresh response) the prior one is kept, so
 * an account never needs a second consent just to survive a token response.
 */
export function saveTokens(
  db: Database,
  secret: string,
  accountId: string,
  tokens: GoogleTokens,
): void {
  if (!getAccount(db, accountId)) throw new Error(`account_not_found:${accountId}`);
  const previous = loadTokens(db, secret, accountId);
  const merged: GoogleTokens = {
    ...tokens,
    refreshToken: tokens.refreshToken ?? previous?.refreshToken ?? null,
  };
  db.query(
    "INSERT INTO oauth_tokens (account_id, payload, scope, expires_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload, scope=excluded.scope, expires_at=excluded.expires_at, updated_at=excluded.updated_at",
  ).run(
    accountId,
    seal(secret, JSON.stringify(merged)),
    merged.scope,
    new Date(merged.expiresAt).toISOString(),
    new Date().toISOString(),
  );
}

export function loadTokens(db: Database, secret: string, accountId: string): GoogleTokens | null {
  const row = db
    .query<{ payload: string }, SQLQueryBindings[]>(
      "SELECT payload FROM oauth_tokens WHERE account_id = ?",
    )
    .get(accountId);
  if (!row) return null;
  const raw = open(secret, row.payload);
  if (!raw) return null;
  try {
    const parsed = SavedTokensSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type GoogleDeps = {
  readonly db: Database;
  readonly events: EventLog;
  readonly config: GoogleConfig;
  readonly vaultSecret: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
};

/**
 * The account a call acts for. There is no default account: picking one by
 * convention is how a multi-account server writes to the wrong mailbox.
 */
export function resolveAccountId(accountId: string | undefined): string {
  if (accountId === undefined || accountId.length === 0)
    throw new Error("account_required: this call has no Google account");
  return accountId;
}

/** Returns a live access token for one account, refreshing only that account. */
export async function accessToken(deps: GoogleDeps, accountId?: string): Promise<string> {
  const target = resolveAccountId(accountId);
  const tokens = loadTokens(deps.db, deps.vaultSecret, target);
  if (!tokens) throw new Error("google_not_connected");
  const now = (deps.now ?? Date.now)();
  if (tokens.expiresAt > now + 60_000) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error("google_refresh_missing");
  const refreshed = await refreshTokens(
    deps.config,
    tokens.refreshToken,
    deps.fetchImpl ?? fetch,
    now,
  );
  saveTokens(deps.db, deps.vaultSecret, target, refreshed);
  return refreshed.accessToken;
}

const UserInfoSchema = z.object({
  sub: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.string()]).optional(),
});

export type VerifiedGoogleIdentity = {
  readonly subject: string;
  readonly email: string | null;
};

/**
 * Reads the identity Google signs for this access token. The token comes from
 * the token endpoint over TLS and userinfo is Google's own answer, so the sub
 * and a verified email are trustworthy without decoding an unverified JWT.
 */
export async function fetchGoogleIdentity(
  fetchImpl: typeof fetch,
  accessTokenValue: string,
): Promise<VerifiedGoogleIdentity> {
  const response = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessTokenValue}` },
  });
  if (!response.ok) throw new Error(`google_userinfo_http_${response.status}`);
  const body = UserInfoSchema.parse(await response.json());
  if (!body.sub) throw new Error("google_identity_missing_sub");
  const verified = body.email_verified === true || body.email_verified === "true";
  return { subject: body.sub, email: verified && body.email ? body.email : null };
}

/**
 * Best-effort legacy email hydration for one bound account, from its Gmail profile.
 * Called only when a target account is known; there is no implicit account here.
 */
export async function hydrateGoogleEmail(
  deps: GoogleDeps,
  accountId: string,
): Promise<string | null> {
  const target = resolveAccountId(accountId);
  const account = getAccount(deps.db, target);
  if (!account || account.email) return account?.email ?? null;
  const tokens = loadTokens(deps.db, deps.vaultSecret, target);
  if (!tokens) return null;
  try {
    const response = await (deps.fetchImpl ?? fetch)(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { authorization: `Bearer ${await accessToken(deps, target)}` } },
    );
    if (!response.ok) return null;
    const body = z.object({ emailAddress: z.string().optional() }).parse(await response.json());
    if (!body.emailAddress) return null;
    applyAccountEmail(deps.db, target, body.emailAddress);
    return body.emailAddress;
  } catch {
    return null;
  }
}
