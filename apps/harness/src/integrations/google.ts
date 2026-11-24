import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { seal, open } from "../core/vault";
import { normalizeCalendarEvent, normalizeGmail, type NormalizedItem, type SyncOutcome } from "./normalize";
import { recordOutcome, saveItems } from "./sync-store";

export type GoogleConfig = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
};

export const GOOGLE_SCOPES = [
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

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
};

function parseTokens(body: TokenResponse, previousRefresh: string | null, now: number): GoogleTokens {
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

async function tokenRequest(params: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!response.ok) throw new Error(`oauth_http_${response.status}`);
  return (await response.json()) as TokenResponse;
}

export async function exchangeCode(config: GoogleConfig, code: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<GoogleTokens> {
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

export async function refreshTokens(config: GoogleConfig, refreshToken: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<GoogleTokens> {
  const body = await tokenRequest(
    { refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token" },
    fetchImpl,
  );
  return parseTokens(body, refreshToken, now);
}

export function saveTokens(db: Database, secret: string, tokens: GoogleTokens): void {
  db.query(
    "INSERT INTO oauth_tokens (provider, payload, scope, expires_at, updated_at) VALUES ('google', ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET payload=excluded.payload, scope=excluded.scope, expires_at=excluded.expires_at, updated_at=excluded.updated_at",
  ).run(seal(secret, JSON.stringify(tokens)), tokens.scope, new Date(tokens.expiresAt).toISOString(), new Date().toISOString());
}

export function loadTokens(db: Database, secret: string): GoogleTokens | null {
  const row = db.query("SELECT payload FROM oauth_tokens WHERE provider = 'google'").get() as { payload: string } | null;
  if (!row) return null;
  const raw = open(secret, row.payload);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GoogleTokens;
    return typeof parsed.accessToken === "string" ? parsed : null;
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

/** Returns a live access token, refreshing and re-saving it when it is expired. */
async function accessToken(deps: GoogleDeps): Promise<string> {
  const tokens = loadTokens(deps.db, deps.vaultSecret);
  if (!tokens) throw new Error("google_not_connected");
  const now = (deps.now ?? Date.now)();
  if (tokens.expiresAt > now + 60_000) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error("google_refresh_missing");
  const refreshed = await refreshTokens(deps.config, tokens.refreshToken, deps.fetchImpl ?? fetch, now);
  saveTokens(deps.db, deps.vaultSecret, refreshed);
  return refreshed.accessToken;
}

function cursorOf(db: Database, source: string): string | null {
  const row = db.query("SELECT cursor FROM integration_state WHERE source = ?").get(source) as { cursor: string | null } | null;
  return row?.cursor ?? null;
}

export async function syncGoogleCalendar(deps: GoogleDeps): Promise<SyncOutcome> {
  const now = (deps.now ?? Date.now)();
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const token = await accessToken(deps);
    const syncToken = cursorOf(deps.db, "calendar");
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("timeMin", new Date(now - 24 * 60 * 60 * 1_000).toISOString());
    if (syncToken) url.searchParams.set("syncToken", syncToken);

    const fetchPage = async (): Promise<Response> => fetchImpl(url.toString(), { headers: { authorization: `Bearer ${token}` } });
    let response = await fetchPage();
    let note: string | null = null;
    if (response.status === 410 && syncToken) {
      deps.db.query("UPDATE integration_state SET cursor = NULL WHERE source = 'calendar'").run();
      url.searchParams.delete("syncToken");
      response = await fetchPage();
      note = "full_resync_after_410";
    }
    if (!response.ok) throw new Error(`calendar_http_${response.status}`);
    const body = (await response.json()) as { items?: unknown[]; nextSyncToken?: string };
    const items = (body.items ?? []).map((raw) => normalizeCalendarEvent(raw as Record<string, never>));
    saveItems(deps.db, "calendar", items, now);
    return await recordOutcome(deps, "calendar", true, items.length, body.nextSyncToken ?? syncToken, note);
  } catch (error) {
    return await recordOutcome(deps, "calendar", false, 0, null, error instanceof Error ? error.message : "unknown");
  }
}

async function syncGmailFull(deps: GoogleDeps, token: string, now: number): Promise<SyncOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const list = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=newer_than:7d", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!list.ok) return await recordOutcome(deps, "gmail", false, 0, null, `gmail_list_http_${list.status}`);
  const body = (await list.json()) as { messages?: { id?: string }[] };
  const ids = (body.messages ?? []).map((message) => message.id ?? "").filter((id) => id.length > 0);
  const items: NormalizedItem[] = [];
  for (const id of ids) {
    const detail = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!detail.ok) continue;
    items.push(normalizeGmail((await detail.json()) as Record<string, never>));
  }
  saveItems(deps.db, "gmail", items, now);
  const profile = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${token}` } });
  const historyId = profile.ok ? ((await profile.json()) as { historyId?: string }).historyId ?? null : null;
  return await recordOutcome(deps, "gmail", true, items.length, historyId, "full_resync");
}

export async function syncGoogleGmail(deps: GoogleDeps): Promise<SyncOutcome> {
  const now = (deps.now ?? Date.now)();
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const token = await accessToken(deps);
    const historyId = cursorOf(deps.db, "gmail");
    if (!historyId) return await syncGmailFull(deps, token, now);

    const response = await fetchImpl(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(historyId)}&historyTypes=messageAdded&maxResults=100`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (response.status === 404) {
      deps.db.query("UPDATE integration_state SET cursor = NULL WHERE source = 'gmail'").run();
      return await syncGmailFull(deps, token, now);
    }
    if (!response.ok) throw new Error(`gmail_history_http_${response.status}`);
    const body = (await response.json()) as { history?: { messagesAdded?: { message?: { id?: string } }[] }[]; historyId?: string };
    const ids = (body.history ?? [])
      .flatMap((entry) => (entry.messagesAdded ?? []).map((added) => added.message?.id ?? ""))
      .filter((id) => id.length > 0);
    const items: NormalizedItem[] = [];
    for (const id of ids.slice(0, 25)) {
      const detail = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!detail.ok) continue;
      items.push(normalizeGmail((await detail.json()) as Record<string, never>));
    }
    saveItems(deps.db, "gmail", items, now);
    return await recordOutcome(deps, "gmail", true, items.length, body.historyId ?? historyId, null);
  } catch (error) {
    return await recordOutcome(deps, "gmail", false, 0, null, error instanceof Error ? error.message : "unknown");
  }
}
