import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { seal, open } from "../core/vault";
import {
  CalendarEventPayloadSchema,
  normalizeCalendarEvent,
  normalizeGmail,
  type NormalizedItem,
  type SyncOutcome,
} from "./normalize";
import { recordOutcome, saveItems } from "./sync-store";
import { z } from "zod";

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

export function saveTokens(db: Database, secret: string, tokens: GoogleTokens): void {
  db.query(
    "INSERT INTO oauth_tokens (provider, payload, scope, expires_at, updated_at) VALUES ('google', ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET payload=excluded.payload, scope=excluded.scope, expires_at=excluded.expires_at, updated_at=excluded.updated_at",
  ).run(
    seal(secret, JSON.stringify(tokens)),
    tokens.scope,
    new Date(tokens.expiresAt).toISOString(),
    new Date().toISOString(),
  );
}

export function loadTokens(db: Database, secret: string): GoogleTokens | null {
  const row = db
    .query<{ payload: string }, SQLQueryBindings[]>(
      "SELECT payload FROM oauth_tokens WHERE provider = 'google'",
    )
    .get();
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

/** Returns a live access token, refreshing and re-saving it when it is expired. */
async function accessToken(deps: GoogleDeps): Promise<string> {
  const tokens = loadTokens(deps.db, deps.vaultSecret);
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
  saveTokens(deps.db, deps.vaultSecret, refreshed);
  return refreshed.accessToken;
}

function cursorOf(db: Database, source: string): string | null {
  const row = db
    .query<{ cursor: string | null }, SQLQueryBindings[]>(
      "SELECT cursor FROM integration_state WHERE source = ?",
    )
    .get(source);
  return row?.cursor ?? null;
}

export async function syncGoogleCalendar(deps: GoogleDeps): Promise<SyncOutcome> {
  const now = (deps.now ?? Date.now)();
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const token = await accessToken(deps);
    const syncToken = cursorOf(deps.db, "calendar");

    // Incremental and full sync take different parameters: Google rejects
    // syncToken together with timeMin/singleEvents, so the incremental request
    // carries the token alone and the full request carries the time window.
    const buildUrl = (incremental: string | null): string => {
      const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
      url.searchParams.set("maxResults", "250");
      if (incremental) {
        url.searchParams.set("syncToken", incremental);
      } else {
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("timeMin", new Date(now - 24 * 60 * 60 * 1_000).toISOString());
      }
      return url.toString();
    };

    let response = await fetchImpl(buildUrl(syncToken), {
      headers: { authorization: `Bearer ${token}` },
    });
    let note: string | null = null;
    let full = syncToken === null;
    if ((response.status === 410 || response.status === 400) && syncToken) {
      // An expired or unusable token means starting over, never failing forever.
      const failureStatus = response.status;
      response = await fetchImpl(buildUrl(null), { headers: { authorization: `Bearer ${token}` } });
      note = `full_resync_after_${failureStatus}`;
      full = true;
    }
    const items: NormalizedItem[] = [];
    const deleted: string[] = [];
    let cursor = syncToken;
    while (true) {
      if (!response.ok) throw new Error(`calendar_http_${response.status}`);
      const body = z
        .object({
          items: z.array(CalendarEventPayloadSchema).optional(),
          nextSyncToken: z.string().optional(),
          nextPageToken: z.string().optional(),
        })
        .parse(await response.json());
      for (const raw of body.items ?? []) {
        if (raw.status === "cancelled" && raw.id) deleted.push(raw.id);
        else items.push(normalizeCalendarEvent(raw));
      }
      if (body.nextSyncToken) cursor = body.nextSyncToken;
      if (!body.nextPageToken) break;
      const url = new URL(buildUrl(full ? null : syncToken));
      url.searchParams.set("pageToken", body.nextPageToken);
      response = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${token}` } });
    }
    return deps.db.transaction(() => {
      if (full) deps.db.query("DELETE FROM sync_items WHERE source='calendar'").run();
      saveItems(deps.db, "calendar", items, now);
      for (const id of deleted)
        deps.db.query("DELETE FROM sync_items WHERE source='calendar' AND item_id=?").run(id);
      return recordOutcome(deps, "calendar", true, items.length, cursor, note);
    })();
  } catch (error) {
    return recordOutcome(
      deps,
      "calendar",
      false,
      0,
      null,
      error instanceof Error ? error.message : "unknown",
    );
  }
}

async function syncGmailFull(deps: GoogleDeps, token: string, now: number): Promise<SyncOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Capture the baseline before listing, so mail arriving during collection
  // is replayed by the next incremental sync rather than skipped.
  const profile = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!profile.ok) throw new Error(`gmail_profile_http_${profile.status}`);
  const historyId = z
    .object({ historyId: z.string().optional() })
    .parse(await profile.json()).historyId;
  if (!historyId) throw new Error("gmail_missing_history_id");
  const ids = new Set<string>();
  let page: string | undefined;
  do {
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=newer_than:7d",
    );
    if (page) url.searchParams.set("pageToken", page);
    const list = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${token}` } });
    if (!list.ok) throw new Error(`gmail_list_http_${list.status}`);
    const body = z
      .object({
        messages: z.array(z.object({ id: z.string().optional() })).optional(),
        nextPageToken: z.string().optional(),
      })
      .parse(await list.json());
    for (const message of body.messages ?? []) if (message.id) ids.add(message.id);
    page = body.nextPageToken;
  } while (page);
  const items = await gmailDetails(deps, token, ids);
  return deps.db.transaction(() => {
    deps.db.query("DELETE FROM sync_items WHERE source='gmail'").run();
    saveItems(deps.db, "gmail", items, now);
    return recordOutcome(deps, "gmail", true, items.length, historyId, "full_resync");
  })();
}

async function gmailDetails(
  deps: GoogleDeps,
  token: string,
  ids: Iterable<string>,
): Promise<NormalizedItem[]> {
  const items: NormalizedItem[] = [];
  for (const id of ids) {
    const detail = await (deps.fetchImpl ?? fetch)(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (!detail.ok) throw new Error(`gmail_detail_http_${detail.status}`);
    items.push(normalizeGmail(await detail.json()));
  }
  return items;
}

export async function syncGoogleGmail(deps: GoogleDeps): Promise<SyncOutcome> {
  const now = (deps.now ?? Date.now)();
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const token = await accessToken(deps);
    const historyId = cursorOf(deps.db, "gmail");
    if (!historyId) return await syncGmailFull(deps, token, now);

    const ids = new Set<string>();
    const deleted = new Set<string>();
    let page: string | undefined;
    let cursor = historyId;
    do {
      const url = new URL(
        `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(historyId)}&maxResults=100`,
      );
      if (page) url.searchParams.set("pageToken", page);
      const response = await fetchImpl(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 404) return await syncGmailFull(deps, token, now);
      if (!response.ok) throw new Error(`gmail_history_http_${response.status}`);
      const messageChange = z.array(
        z.object({ message: z.object({ id: z.string().optional() }).optional() }),
      );
      const body = z
        .object({
          history: z
            .array(
              z.object({
                messagesAdded: messageChange.optional(),
                messagesDeleted: messageChange.optional(),
              }),
            )
            .optional(),
          historyId: z.string().optional(),
          nextPageToken: z.string().optional(),
        })
        .parse(await response.json());
      for (const entry of body.history ?? []) {
        for (const added of entry.messagesAdded ?? [])
          if (added.message?.id) {
            ids.add(added.message.id);
            deleted.delete(added.message.id);
          }
        for (const removed of entry.messagesDeleted ?? [])
          if (removed.message?.id) {
            deleted.add(removed.message.id);
            ids.delete(removed.message.id);
          }
      }
      cursor = body.historyId ?? cursor;
      page = body.nextPageToken;
    } while (page);
    const items = await gmailDetails(deps, token, ids);
    return deps.db.transaction(() => {
      saveItems(deps.db, "gmail", items, now);
      for (const id of deleted)
        deps.db.query("DELETE FROM sync_items WHERE source='gmail' AND item_id=?").run(id);
      return recordOutcome(deps, "gmail", true, items.length, cursor, null);
    })();
  } catch (error) {
    return recordOutcome(
      deps,
      "gmail",
      false,
      0,
      null,
      error instanceof Error ? error.message : "unknown",
    );
  }
}
