import type { Database, SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";

export type NormalizedItem = {
  readonly id: string;
  readonly source: "gmail" | "calendar" | "canvas";
  readonly title: string;
  readonly at: string | null;
  readonly detail: string;
  readonly url: string | null;
};

const GmailPartSchema = z.object({
  headers: z
    .array(z.object({ name: z.string().optional(), value: z.string().optional() }))
    .optional(),
  body: z.object({ data: z.string().optional() }).optional(),
  get parts() {
    return z.array(GmailPartSchema).optional();
  },
});
export type GmailPart = z.infer<typeof GmailPartSchema>;
export const GmailPayloadSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  internalDate: z.union([z.string(), z.number()]).optional(),
  snippet: z.string().optional(),
  payload: GmailPartSchema.optional(),
});

function header(headers: GmailPart["headers"], name: string): string {
  return (
    headers?.find((entry) => (entry.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? ""
  );
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

export function normalizeGmail(raw: unknown): NormalizedItem {
  const message = GmailPayloadSchema.parse(raw);
  const headers = message.payload?.headers;
  const internal = Number(message.internalDate ?? 0);
  return {
    id: String(message.id ?? ""),
    source: "gmail",
    title: header(headers, "Subject") || "(제목 없음)",
    at: internal > 0 ? new Date(internal).toISOString() : null,
    detail: findBody(message.payload) || (message.snippet ?? ""),
    url: null,
  };
}

export const CalendarEventPayloadSchema = z.object({
  id: z.string().optional(),
  summary: z.string().nullish(),
  description: z.string().nullish(),
  htmlLink: z.string().nullish(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
  end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
  recurringEventId: z.string().optional(),
  status: z.string().optional(),
});

export function normalizeCalendarEvent(raw: unknown): NormalizedItem {
  const event = CalendarEventPayloadSchema.parse(raw);
  const start = event.start?.dateTime ?? event.start?.date ?? null;
  return {
    id: event.id ?? "",
    source: "calendar",
    title: event.summary ?? "(제목 없음)",
    at: start,
    detail: (event.description ?? "") + (event.recurringEventId ? " (반복 일정)" : ""),
    url: event.htmlLink ? event.htmlLink : null,
  };
}

const CanvasAssignmentPayloadSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string().nullish(),
  due_at: z.string().nullish(),
  html_url: z.string().nullish(),
  course_id: z.union([z.string(), z.number()]).optional(),
  description: z.string().nullish(),
});

export function normalizeCanvasAssignment(raw: unknown): NormalizedItem {
  const assignment = CanvasAssignmentPayloadSchema.parse(raw);
  return {
    id: String(assignment.id ?? ""),
    source: "canvas",
    title: assignment.name ?? "(제목 없음)",
    at: assignment.due_at ? assignment.due_at : null,
    detail: `과목 ${String(assignment.course_id ?? "-")} · ${(assignment.description ?? "").slice(0, 200)}`,
    url: assignment.html_url ? assignment.html_url : null,
  };
}

export type SyncOutcome = {
  readonly source: NormalizedItem["source"];
  readonly accountId: string;
  readonly ok: boolean;
  readonly count: number;
  readonly cursor: string | null;
  readonly error: string | null;
  /** True when a disabled source or a credential-less account was not attempted. */
  readonly skipped?: boolean;
};

export type SyncState = {
  readonly accountId: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly ok: boolean;
  readonly lastSyncAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly error: string | null;
};

/** Aggregate connection view: one row per account and source, never one per source. */
export function syncStates(db: Database): SyncState[] {
  return db
    .query<
      {
        account_id: string;
        source: string;
        enabled: number;
        ok: number;
        last_sync_at: string | null;
        last_attempt_at: string | null;
        error: string | null;
      },
      SQLQueryBindings[]
    >(
      "SELECT account_id,source,enabled,ok,last_sync_at,last_attempt_at,error FROM account_sources ORDER BY account_id, source",
    )
    .all()
    .map((row) => ({
      accountId: row["account_id"],
      source: row["source"],
      enabled: row["enabled"] === 1,
      ok: row["ok"] === 1,
      lastSyncAt: row["last_sync_at"] === null ? null : row["last_sync_at"],
      lastAttemptAt: row["last_attempt_at"] === null ? null : row["last_attempt_at"],
      error: row["error"] === null ? null : row["error"],
    }));
}
