import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";

export type NormalizedItem = {
  readonly id: string;
  readonly source: "gmail" | "calendar" | "canvas";
  readonly title: string;
  readonly at: string | null;
  readonly detail: string;
  readonly url: string | null;
};

export type GmailPart = {
  headers?: { name?: string; value?: string }[];
  body?: { data?: string };
  parts?: GmailPart[];
};

export type GmailPayload = {
  id?: unknown;
  internalDate?: unknown;
  snippet?: unknown;
  payload?: GmailPart;
};

function header(headers: { name?: string; value?: string }[] | undefined, name: string): string {
  return headers?.find((entry) => (entry.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function findBody(part: GmailPart | undefined): string {
  if (!part) return "";
  const mine = part.body?.data ? decodeBase64Url(part.body.data) : "";
  if (mine) return mine;
  for (const child of part.parts ?? []) {
    const text = findBody(child);
    if (text) return text;
  }
  return "";
}

export function normalizeGmail(message: GmailPayload): NormalizedItem {
  const headers = message.payload?.headers;
  const internal = Number(message.internalDate ?? 0);
  return {
    id: String(message.id ?? ""),
    source: "gmail",
    title: header(headers, "Subject") || "(제목 없음)",
    at: internal > 0 ? new Date(internal).toISOString() : null,
    detail: findBody(message.payload) || String(message.snippet ?? ""),
    url: null,
  };
}

export type CalendarEventPayload = {
  id?: unknown;
  summary?: unknown;
  description?: unknown;
  htmlLink?: unknown;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  recurringEventId?: unknown;
};

export function normalizeCalendarEvent(event: CalendarEventPayload): NormalizedItem {
  const start = event.start?.dateTime ?? event.start?.date ?? null;
  return {
    id: String(event.id ?? ""),
    source: "calendar",
    title: String(event.summary ?? "(제목 없음)"),
    at: start,
    detail: String(event.description ?? "") + (event.recurringEventId ? " (반복 일정)" : ""),
    url: event.htmlLink ? String(event.htmlLink) : null,
  };
}

export type CanvasAssignmentPayload = {
  id?: unknown;
  name?: unknown;
  due_at?: unknown;
  html_url?: unknown;
  course_id?: unknown;
  description?: unknown;
};

export function normalizeCanvasAssignment(assignment: CanvasAssignmentPayload): NormalizedItem {
  return {
    id: String(assignment.id ?? ""),
    source: "canvas",
    title: String(assignment.name ?? "(제목 없음)"),
    at: assignment.due_at ? String(assignment.due_at) : null,
    detail: `과목 ${String(assignment.course_id ?? "-")} · ${String(assignment.description ?? "").slice(0, 200)}`,
    url: assignment.html_url ? String(assignment.html_url) : null,
  };
}

export type SyncOutcome = {
  readonly source: NormalizedItem["source"];
  readonly ok: boolean;
  readonly count: number;
  readonly cursor: string | null;
  readonly error: string | null;
};

/**
 * Runs one source's collection and records the outcome. A partial failure is
 * written as `ok:false` with the failing source named — never as "synced".
 */
export async function syncSource(input: {
  readonly db: Database;
  readonly events: EventLog;
  readonly source: NormalizedItem["source"];
  readonly cursor: string | null;
  readonly collect: (cursor: string | null) => Promise<{ items: NormalizedItem[]; cursor: string | null }>;
  readonly now?: number;
}): Promise<SyncOutcome> {
  const now = input.now ?? Date.now();
  const iso = new Date(now).toISOString();
  try {
    const result = await input.collect(input.cursor);
    input.db
      .query(
        "INSERT INTO integration_state (source, cursor, last_sync_at, ok, error, detail_json) VALUES (?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor, last_sync_at=excluded.last_sync_at, ok=excluded.ok, error=NULL, detail_json=excluded.detail_json",
      )
      .run(input.source, result.cursor, iso, 1, null, JSON.stringify({ count: result.items.length }));
    input.events.append({ kind: "integration.sync_state", payload: { source: input.source, ok: true, count: result.items.length }, now });
    return { source: input.source, ok: true, count: result.items.length, cursor: result.cursor, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    input.db
      .query(
        "INSERT INTO integration_state (source, cursor, last_sync_at, ok, error, detail_json) VALUES (?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET last_sync_at=excluded.last_sync_at, ok=0, error=excluded.error",
      )
      .run(input.source, input.cursor, iso, 0, message, JSON.stringify({}));
    input.events.append({ kind: "integration.sync_state", payload: { source: input.source, ok: false, error: message }, now });
    return { source: input.source, ok: false, count: 0, cursor: input.cursor, error: message };
  }
}

export function syncStates(db: Database): { source: string; ok: boolean; lastSyncAt: string | null; error: string | null }[] {
  return (db.query("SELECT source, ok, last_sync_at, error FROM integration_state ORDER BY source").all() as Record<string, unknown>[]).map((row) => ({
    source: String(row["source"]),
    ok: Number(row["ok"]) === 1,
    lastSyncAt: row["last_sync_at"] === null ? null : String(row["last_sync_at"]),
    error: row["error"] === null ? null : String(row["error"]),
  }));
}
