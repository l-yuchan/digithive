import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ensureAccessToken, type GoogleConfig } from "./google-auth";
import type { SecretVault } from "../server/secrets";
import { extractMail, GmailMessage } from "../knowledge/mail-body";

export type GmailSource = {
  readonly connectionId: string;
  readonly query: string;
  readonly labelIds: readonly string[];
};

export class GmailSyncError extends Error {
  constructor(readonly kind: "expired_history" | "page_failed" | "unauthorized") {
    super(kind);
    this.name = "GmailSyncError";
  }
}

const MAX_PAGES = 40;
const MAX_MESSAGES = 400;

export function gmailFingerprint(source: GmailSource): string {
  return createHash("sha256")
    .update(JSON.stringify({ query: source.query, labelIds: [...source.labelIds].sort() }))
    .digest("hex");
}

export function gmailCursor(db: Database, source: GmailSource): string | undefined {
  const row = db.query("SELECT sync_cursor FROM connections WHERE id = ?").get(source.connectionId);
  const parsed = z.object({ sync_cursor: z.string().nullable() }).safeParse(row);
  if (!parsed.success) return undefined;
  const value = parsed.data.sync_cursor;
  if (!value) return undefined;
  const prefix = `${gmailFingerprint(source)}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function base(): string {
  return process.env["GMAIL_BASE"] ?? "https://gmail.googleapis.com";
}

async function getJson(
  path: string, token: string, fetchFn: typeof fetch,
): Promise<{ status: number; body: unknown }> {
  const response = await fetchFn(`${base()}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401 || response.status === 403) throw new GmailSyncError("unauthorized");
  if (!response.ok) return { status: response.status, body: undefined };
  return { status: response.status, body: await response.json() };
}

const ListResponse = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string().optional() })).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});

const HistoryResponse = z.object({
  historyId: z.string().optional(),
  nextPageToken: z.string().optional(),
  history: z.array(z.object({
    id: z.string(),
    messagesAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).optional(),
    messagesDeleted: z.array(z.object({ message: z.object({ id: z.string() }) })).optional(),
    labelsAdded: z.array(z.object({ message: z.object({ id: z.string() }), labelIds: z.array(z.string()).optional() })).optional(),
    labelsRemoved: z.array(z.object({ message: z.object({ id: z.string() }), labelIds: z.array(z.string()).optional() })).optional(),
  })).optional(),
});

type Collected = {
  readonly messages: GmailMessage[];
  readonly touched: readonly string[];
  readonly historyId: string;
  readonly full: boolean;
};

async function collectFull(
  source: GmailSource, token: string, fetchFn: typeof fetch, profileHistoryId: string,
): Promise<Collected> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES && ids.length < MAX_MESSAGES; page++) {
    const params = new URLSearchParams({ maxResults: "100", q: source.query });
    for (const label of source.labelIds) params.append("labelIds", label);
    if (pageToken) params.set("pageToken", pageToken);
    const list = await getJson(`/gmail/v1/users/me/messages?${params.toString()}`, token, fetchFn);
    if (list.status !== 200) throw new GmailSyncError("page_failed");
    const parsed = ListResponse.safeParse(list.body);
    if (!parsed.success) throw new GmailSyncError("page_failed");
    ids.push(...(parsed.data.messages ?? []).map((entry) => entry.id));
    pageToken = parsed.data.nextPageToken;
    if (!pageToken) break;
  }
  const messages: GmailMessage[] = [];
  for (const id of ids) {
    const detail = await getJson(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, token, fetchFn);
    if (detail.status !== 200) throw new GmailSyncError("page_failed");
    const parsed = GmailMessage.safeParse(detail.body);
    if (!parsed.success) throw new GmailSyncError("page_failed");
    messages.push(parsed.data);
  }
  // Catch up on mail that arrived while the first pages were being read.
  const catchUp = await collectHistory(source, token, fetchFn, profileHistoryId);
  const known = new Set(messages.map((message) => message.id));
  for (const id of catchUp.touched) {
    if (known.has(id)) continue;
    const detail = await getJson(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, token, fetchFn);
    if (detail.status !== 200) continue;
    const parsed = GmailMessage.safeParse(detail.body);
    if (parsed.success) messages.push(parsed.data);
  }
  return { messages, touched: catchUp.touched, historyId: catchUp.historyId, full: true };
}

async function collectHistory(
  source: GmailSource, token: string, fetchFn: typeof fetch, startHistoryId: string,
): Promise<{ touched: readonly string[]; historyId: string }> {
  const touched: string[] = [];
  let pageToken: string | undefined;
  let latest = startHistoryId;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ startHistoryId, maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const history = await getJson(`/gmail/v1/users/me/history?${params.toString()}`, token, fetchFn);
    if (history.status === 404) throw new GmailSyncError("expired_history");
    if (history.status !== 200) throw new GmailSyncError("page_failed");
    const parsed = HistoryResponse.safeParse(history.body);
    if (!parsed.success) throw new GmailSyncError("page_failed");
    for (const record of parsed.data.history ?? []) {
      for (const added of record.messagesAdded ?? []) touched.push(added.message.id);
      for (const deleted of record.messagesDeleted ?? []) touched.push(deleted.message.id);
      for (const label of [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])]) touched.push(label.message.id);
    }
    if (parsed.data.historyId) latest = parsed.data.historyId;
    pageToken = parsed.data.nextPageToken;
    if (!pageToken) break;
  }
  return { touched, historyId: latest };
}

function hashMessage(message: GmailMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

/**
 * First collection uses a bounded query, then catches up from the history
 * watermark so mail that arrives during the collection is not lost. Later
 * collections are history-only; an expired history id (404) falls back to a
 * full resync of the same bounded range. Versions and the cursor commit only
 * after every page was fetched.
 */
export async function syncGmail(
  db: Database, vault: SecretVault, config: GoogleConfig, source: GmailSource,
  fetchFn: typeof fetch = fetch, now = () => Date.now(),
): Promise<{ stored: number; touched: number; full: boolean }> {
  const ensured = await ensureAccessToken(db, vault, config, source.connectionId, now(), fetchFn);
  const cursor = gmailCursor(db, source);
  let collected: Collected;
  if (cursor) {
    try {
      const history = await collectHistory(source, ensured.token, fetchFn, cursor);
      const messages: GmailMessage[] = [];
      for (const id of new Set(history.touched)) {
        const detail = await getJson(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, ensured.token, fetchFn);
        if (detail.status === 404) continue;
        if (detail.status !== 200) throw new GmailSyncError("page_failed");
        const parsed = GmailMessage.safeParse(detail.body);
        if (parsed.success) messages.push(parsed.data);
      }
      collected = { messages, touched: history.touched, historyId: history.historyId, full: false };
    } catch (error) {
      if (error instanceof GmailSyncError && error.kind === "expired_history") {
        const profile = await getJson("/gmail/v1/users/me/profile", ensured.token, fetchFn);
        const historyId = z.object({ historyId: z.string() }).safeParse(profile.body);
        if (profile.status !== 200 || !historyId.success) throw new GmailSyncError("page_failed");
        collected = await collectFull(source, ensured.token, fetchFn, historyId.data.historyId);
      } else {
        throw error;
      }
    }
  } else {
    const profile = await getJson("/gmail/v1/users/me/profile", ensured.token, fetchFn);
    const historyId = z.object({ historyId: z.string() }).safeParse(profile.body);
    if (profile.status !== 200 || !historyId.success) throw new GmailSyncError("page_failed");
    collected = await collectFull(source, ensured.token, fetchFn, historyId.data.historyId);
  }

  return db.transaction(() => {
    let stored = 0;
    for (const message of collected.messages) {
      const mail = extractMail(message);
      const contentHash = hashMessage(message);
      const existing = db.query(
        "SELECT id,current_version_id FROM source_items WHERE connection_id = ? AND remote_id = ?",
      ).get(source.connectionId, message.id);
      const parsed = z.object({ id: z.string(), current_version_id: z.string().nullable() }).safeParse(existing);
      const itemId = parsed.success ? parsed.data.id : crypto.randomUUID();
      if (!parsed.success) {
        db.query("INSERT INTO source_items (id,connection_id,remote_id,observed_at) VALUES (?,?,?,?)")
          .run(itemId, source.connectionId, message.id, new Date(now()).toISOString());
      }
      const version = db.query("SELECT id FROM source_versions WHERE source_item_id = ? AND content_hash = ?")
        .get(itemId, contentHash);
      if (!z.object({ id: z.string() }).safeParse(version).success) {
        const versionId = crypto.randomUUID();
        db.query(`INSERT INTO source_versions (id,source_item_id,content_hash,content_json,tombstone,observed_at)
          VALUES (?,?,?,?,?,?)`)
          .run(versionId, itemId, contentHash,
            JSON.stringify({ message, mail }), 0, new Date(now()).toISOString());
        db.query("UPDATE source_items SET current_version_id = ? WHERE id = ?").run(versionId, itemId);
        stored += 1;
      }
    }
    const prefix = `${gmailFingerprint(source)}:`;
    db.query("UPDATE connections SET sync_cursor = ?, sync_status = 'synced', last_success_at = ? WHERE id = ?")
      .run(`${prefix}${collected.historyId}`, new Date(now()).toISOString(), source.connectionId);
    return { stored, touched: collected.touched.length, full: collected.full };
  }).immediate();
}
