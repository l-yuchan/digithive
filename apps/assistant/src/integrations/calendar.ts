import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { GoogleConfig } from "./google-auth";
import { ensureAccessToken, GoogleAuthError } from "./google-auth";
import type { SecretVault } from "../server/secrets";

export const CalendarEvent = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  etag: z.string().optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: z.object({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() }).optional(),
  start: z.object({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() }),
  end: z.object({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() }),
  recurrence: z.array(z.string()).optional(),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

const Page = z.object({
  items: z.array(CalendarEvent).optional(),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
});

export class CalendarSyncError extends Error {
  constructor(readonly kind: "expired_sync_token" | "page_failed" | "unauthorized") {
    super(kind);
    this.name = "CalendarSyncError";
  }
}

export type CalendarSource = {
  readonly connectionId: string;
  readonly calendarId: string;
  readonly timeZone: string;
};

const MAX_PAGES = 40;

export function queryFingerprint(source: CalendarSource): string {
  return createHash("sha256")
    .update(JSON.stringify({ calendarId: source.calendarId, singleEvents: false, showDeleted: true }))
    .digest("hex");
}

export function syncCursor(db: Database, source: CalendarSource): string | undefined {
  const row = db.query("SELECT sync_cursor FROM connections WHERE id = ?").get(source.connectionId);
  const parsed = z.object({ sync_cursor: z.string().nullable() }).safeParse(row);
  if (!parsed.success) return undefined;
  return parsed.data.sync_cursor?.startsWith(queryFingerprint(source))
    ? parsed.data.sync_cursor.slice(queryFingerprint(source).length + 1)
    : undefined;
}

async function fetchPage(
  config: GoogleConfig, accessToken: string, source: CalendarSource, syncToken: string | undefined,
  pageToken: string | undefined, fetchFn: typeof fetch,
): Promise<z.infer<typeof Page>> {
  const base = process.env["GOOGLE_CALENDAR_BASE"] ?? "https://www.googleapis.com";
  const url = new URL(`${base}/calendar/v3/calendars/${encodeURIComponent(source.calendarId)}/events`);
  url.searchParams.set("singleEvents", "false");
  url.searchParams.set("showDeleted", "true");
  url.searchParams.set("maxResults", "250");
  // A sync token may never be combined with timeMin/timeMax/q/orderBy.
  if (syncToken) url.searchParams.set("syncToken", syncToken);
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const response = await fetchFn(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (response.status === 410) throw new CalendarSyncError("expired_sync_token");
  if (response.status === 401 || response.status === 403) throw new CalendarSyncError("unauthorized");
  if (!response.ok) throw new CalendarSyncError("page_failed");
  const parsed = Page.safeParse(await response.json());
  if (!parsed.success) throw new CalendarSyncError("page_failed");
  return parsed.data;
}

/**
 * Reads every page into memory first and only then commits the versions and the
 * sync token in one transaction: a failed page leaves the previous snapshot and
 * cursor untouched, and a 410 triggers a full resync of this connection only.
 */
export async function syncCalendar(
  db: Database, vault: SecretVault, config: GoogleConfig, source: CalendarSource,
  fetchFn: typeof fetch = fetch, now = () => Date.now(),
): Promise<{ inserted: number; changed: number; deleted: number; full: boolean }> {
  const ensured = await ensureAccessToken(db, vault, config, source.connectionId, now(), fetchFn);
  let syncToken = syncCursor(db, source);
  let full = syncToken === undefined;
  if (syncToken) {
    try {
      const pages = await collect(config, ensured.token, source, syncToken, fetchFn);
      return commit(db, source, pages, syncToken, false, now);
    } catch (error) {
      if (error instanceof CalendarSyncError && error.kind === "expired_sync_token") {
        full = true;
        syncToken = undefined;
      } else {
        throw error;
      }
    }
  }
  void full;
  const pages = await collect(config, ensured.token, source, undefined, fetchFn);
  return commit(db, source, pages, undefined, true, now);
}

async function collect(
  config: GoogleConfig, accessToken: string, source: CalendarSource,
  syncToken: string | undefined, fetchFn: typeof fetch,
): Promise<{ events: CalendarEvent[]; nextSyncToken: string | undefined }> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await fetchPage(config, accessToken, source, syncToken, pageToken, fetchFn);
    events.push(...(body.items ?? []));
    nextSyncToken = body.nextSyncToken ?? nextSyncToken;
    pageToken = body.nextPageToken;
    if (!pageToken) return { events, nextSyncToken };
  }
  throw new CalendarSyncError("page_failed");
}

function hashEvent(event: CalendarEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function commit(
  db: Database, source: CalendarSource, pages: { events: CalendarEvent[]; nextSyncToken: string | undefined },
  previousToken: string | undefined, full: boolean, now: () => number,
): { inserted: number; changed: number; deleted: number; full: boolean } {
  const fingerprint = queryFingerprint(source);
  return db.transaction(() => {
    let inserted = 0;
    let changed = 0;
    let deleted = 0;
    for (const event of pages.events) {
      const contentHash = hashEvent(event);
      const existing = db.query(
        "SELECT id, current_version_id FROM source_items WHERE connection_id = ? AND remote_id = ?",
      ).get(source.connectionId, event.id);
      const parsed = z.object({ id: z.string(), current_version_id: z.string().nullable() }).safeParse(existing);
      const itemId = parsed.success ? parsed.data.id : crypto.randomUUID();
      if (!parsed.success) {
        db.query("INSERT INTO source_items (id,connection_id,remote_id,observed_at) VALUES (?,?,?,?)")
          .run(itemId, source.connectionId, event.id, new Date(now()).toISOString());
        inserted += 1;
      }
      const version = db.query(
        "SELECT id FROM source_versions WHERE source_item_id = ? AND content_hash = ?",
      ).get(itemId, contentHash);
      const existingVersion = z.object({ id: z.string() }).safeParse(version);
      // A cancelled standalone event is a tombstone; a cancelled instance of a
      // recurring series stays readable so the series can mark that occurrence.
      const tombstone = event.status === "cancelled" && !event.recurringEventId ? 1 : 0;
      const versionId = existingVersion.success ? existingVersion.data.id : crypto.randomUUID();
      if (!existingVersion.success) {
        db.query(`INSERT INTO source_versions (id,source_item_id,content_hash,content_json,tombstone,observed_at)
          VALUES (?,?,?,?,?,?)`)
          .run(versionId, itemId, contentHash, JSON.stringify(event), tombstone, new Date(now()).toISOString());
        if (parsed.success && parsed.data.current_version_id !== versionId) changed += 1;
      }
      db.query("UPDATE source_items SET current_version_id = ?, observed_at = ? WHERE id = ?")
        .run(versionId, new Date(now()).toISOString(), itemId);
      if (tombstone === 1) deleted += 1;
    }
    if (full && pages.nextSyncToken === undefined) {
      throw new CalendarSyncError("page_failed");
    }
    const cursor = pages.nextSyncToken ? `${fingerprint}:${pages.nextSyncToken}` : (previousToken ? `${fingerprint}:${previousToken}` : null);
    db.query("UPDATE connections SET sync_cursor = ?, sync_status = 'synced', last_success_at = ? WHERE id = ?")
      .run(cursor, new Date(now()).toISOString(), source.connectionId);
    return { inserted, changed, deleted, full };
  }).immediate();
}

export function markStale(db: Database, connectionId: string): void {
  db.query("UPDATE connections SET sync_status = 'stale' WHERE id = ?").run(connectionId);
}

export { GoogleAuthError };
