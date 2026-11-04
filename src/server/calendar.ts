import ICAL from "ical.js";
import type { CalendarOccurrence, CalendarSyncResult } from "../shared";
import { badRequest } from "./api_util";
import type { CalendarEventRow, CalendarRow, Store } from "./store";
import { calendarEventView, eq } from "./store";
import { isValidTimeZone, zonedTimeToUtc } from "./time";

// Subscribed iCal feeds. A feed is fetched, expanded into single occurrences
// inside a rolling window, and stored as reference data. Nothing here decides
// anything on the user's behalf: an occurrence never becomes an entry unless
// the person writes one.
//
// Occurrences are compared by (uid, occurrence start) so a repeated sync is
// idempotent, a rescheduled feed moves the row it already had, and a deleted
// event disappears from the agenda.

const PAST_DAYS = 7;
const FUTURE_DAYS = 120;
const MAX_OCCURRENCES_PER_FEED = 4000;
const MAX_DOCUMENT_BYTES = 4_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const FALLBACK_SUMMARY = "제목 없음";

export interface CalendarDocument {
  text: string;
  contentType: string | null;
}
export type CalendarFetcher = (url: string) => Promise<CalendarDocument>;

export interface ParsedOccurrence {
  uid: string;
  summary: string;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  status: "confirmed" | "tentative";
}

export interface ParseWindow {
  timeZone: string;
  from: Date;
  to: Date;
}

export function syncWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - PAST_DAYS * 86_400_000),
    to: new Date(now.getTime() + FUTURE_DAYS * 86_400_000),
  };
}

// ---------------------------------------------------------------- fetching

const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "metadata",
]);

function isLinkLocalHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  if (/^169\.254\./.test(bare)) return true;
  if (/^fe80:/i.test(bare)) return true;
  // Cloud metadata aliases resolve to link-local addresses.
  return BLOCKED_HOSTS.has(bare.toLowerCase());
}

/** Rejects URLs the server must not fetch on the person's behalf. */
export function parseCalendarUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest([{ path: "url", message: "구독 주소를 URL 형식으로 입력해 주세요." }]);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw badRequest([{ path: "url", message: "http 또는 https 주소만 구독할 수 있습니다." }]);
  }
  if (isLinkLocalHost(url.hostname)) {
    throw badRequest([{ path: "url", message: "링크 로컬(메타데이터) 주소는 구독할 수 없습니다." }]);
  }
  if (url.username || url.password) {
    if (url.protocol !== "https:") {
      throw badRequest([{ path: "url", message: "로그인 정보가 담긴 주소는 https여야 합니다." }]);
    }
  }
  return url;
}

/** Default transport: one bounded GET with a calendar-oriented Accept header. */
export const fetchCalendarDocument: CalendarFetcher = async (url) => {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "text/calendar, text/plain;q=0.8, */*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error("구독 주소에 연결하지 못했습니다: " + reason);
  }
  if (!response.ok) {
    throw new Error("구독 주소가 HTTP " + response.status + "로 응답했습니다.");
  }
  const text = await response.text();
  if (text.length > MAX_DOCUMENT_BYTES) {
    throw new Error("일정 파일이 너무 큽니다 (4MB 초과).");
  }
  if (!text.includes("BEGIN:VCALENDAR")) {
    throw new Error("iCal 형식이 아닙니다(BEGIN:VCALENDAR 없음). 비공개 iCal 주소인지 확인해 주세요.");
  }
  return { text, contentType: response.headers.get("content-type") };
};

// ---------------------------------------------------------------- parsing

type Component = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;

function textProperty(component: Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function durationMsOf(component: Component, start: Time): number {
  const end = component.getFirstPropertyValue("dtend") as Time | null;
  if (end) return Math.max(0, (end.toUnixTime() - start.toUnixTime()) * 1000);
  const duration = component.getFirstPropertyValue("duration") as { toSeconds?: () => number } | null;
  const seconds = duration?.toSeconds?.() ?? 0;
  return Math.max(0, seconds * 1000);
}

function daySpanOf(component: Component, start: Time): number {
  const end = component.getFirstPropertyValue("dtend") as Time | null;
  if (!end) return 1;
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  const endDay = Date.UTC(end.year, end.month - 1, end.day);
  return Math.max(1, Math.round((endDay - startDay) / 86_400_000));
}

/** UTC instant of an iCal time, honoring VTIMEZONE, then IANA, then the app zone. */
function instantOf(time: Time, registered: ReadonlySet<string>, fallbackZone: string): Date {
  const tzid = time.zone?.tzid;
  if (tzid && tzid !== "floating" && registered.has(tzid)) {
    return new Date(time.toUnixTime() * 1000);
  }
  if (tzid === "UTC" || tzid === "Z") return new Date(time.toUnixTime() * 1000);
  const zone = tzid && tzid !== "floating" && isValidTimeZone(tzid) ? tzid : fallbackZone;
  return zonedTimeToUtc(zone, time.year, time.month, time.day, time.hour, time.minute);
}

function localMidnight(timeZone: string, year: number, month: number, day: number): Date {
  return zonedTimeToUtc(timeZone, year, month, day, 0, 0);
}

interface EventShape {
  uid: string;
  summary: string;
  location: string | null;
  allDay: boolean;
  status: "confirmed" | "tentative";
  component: Component;
  start: Time;
  durationMs: number;
  daySpan: number;
}

function shapeOf(component: Component, index: number): EventShape | null {
  const start = component.getFirstPropertyValue("dtstart") as Time | null;
  if (!start) return null;
  const statusProperty = (textProperty(component, "status") ?? "CONFIRMED").toUpperCase();
  if (statusProperty === "CANCELLED") return null;
  return {
    uid: textProperty(component, "uid") ?? "no-uid-" + index,
    summary: textProperty(component, "summary") ?? FALLBACK_SUMMARY,
    location: textProperty(component, "location"),
    allDay: start.isDate,
    status: statusProperty === "TENTATIVE" ? "tentative" : "confirmed",
    component,
    start,
    durationMs: start.isDate ? 0 : durationMsOf(component, start),
    daySpan: start.isDate ? daySpanOf(component, start) : 0,
  };
}

/**
 * Expands every VEVENT in the document into occurrences inside the window.
 * Recurring masters are expanded with EXDATE/RDATE honored; a VEVENT that
 * carries RECURRENCE-ID replaces the master occurrence it points at.
 */
export function parseCalendar(text: string, window: ParseWindow): ParsedOccurrence[] {
  const root = new ICAL.Component(ICAL.parse(text));
  const registered = new Set<string>();
  for (const component of root.getAllSubcomponents("vtimezone")) {
    const tzid = String(component.getFirstPropertyValue("tzid") ?? "");
    if (!tzid) continue;
    ICAL.TimezoneService.register(new ICAL.Timezone({ component, tzid }), tzid);
    registered.add(tzid);
  }

  const masters: EventShape[] = [];
  const overrides = new Map<string, EventShape[]>();
  root.getAllSubcomponents("vevent").forEach((component, index) => {
    const shape = shapeOf(component, index);
    if (!shape) return;
    if (component.getFirstPropertyValue("recurrence-id")) {
      const bucket = overrides.get(shape.uid) ?? [];
      bucket.push(shape);
      overrides.set(shape.uid, bucket);
      return;
    }
    masters.push(shape);
  });

  const out: ParsedOccurrence[] = [];
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();

  const emit = (shape: EventShape, start: Time): void => {
    const startsAt = shape.allDay
      ? localMidnight(window.timeZone, start.year, start.month, start.day)
      : instantOf(start, registered, window.timeZone);
    const endsAt = shape.allDay
      ? localMidnight(window.timeZone, start.year, start.month, start.day + shape.daySpan)
      : shape.durationMs > 0
        ? new Date(startsAt.getTime() + shape.durationMs)
        : null;
    const endMs = endsAt ? endsAt.getTime() : startsAt.getTime();
    if (endMs < fromMs || startsAt.getTime() > toMs) return;
    out.push({
      uid: shape.uid,
      summary: shape.summary,
      location: shape.location,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt ? endsAt.toISOString() : null,
      all_day: shape.allDay,
      status: shape.status,
    });
  };

  for (const shape of masters) {
    const recurring =
      shape.component.hasProperty("rrule") || shape.component.hasProperty("rdate");
    if (!recurring) {
      emit(shape, shape.start);
      continue;
    }
    // Overridden occurrences must not also appear at their original slot.
    const clone = new ICAL.Component(ICAL.parse(shape.component.toString()));
    for (const override of overrides.get(shape.uid) ?? []) {
      const recurrenceId = override.component.getFirstPropertyValue("recurrence-id") as Time | null;
      if (!recurrenceId) continue;
      const property = new ICAL.Property("exdate");
      property.setValue(recurrenceId);
      clone.addProperty(property);
    }
    const expansion = new ICAL.RecurExpansion({
      component: clone,
      dtstart: clone.getFirstPropertyValue("dtstart") as Time,
    });
    for (let guard = 0; guard < MAX_OCCURRENCES_PER_FEED; guard++) {
      const next = expansion.next() as Time | null;
      if (!next) break;
      if (next.toUnixTime() * 1000 > toMs + 86_400_000) break;
      emit(shape, next);
    }
  }

  for (const shape of overrides.values()) {
    for (const override of shape) emit(override, override.start);
  }

  return out;
}

// ------------------------------------------------------------------- sync

export function occurrenceKey(row: { uid: string; starts_at: string }): string {
  return row.uid + "\u0000" + row.starts_at;
}

export interface SyncOptions {
  store: Store;
  calendar: CalendarRow;
  fetchDocument: CalendarFetcher;
  now: Date;
  timeZone: string;
}

export async function syncCalendar(options: SyncOptions): Promise<CalendarSyncResult> {
  const { store, calendar, fetchDocument, now, timeZone } = options;
  const sync = syncWindow(now);
  const document = await fetchDocument(calendar.url);
  const parsed = parseCalendar(document.text, { timeZone, from: sync.from, to: sync.to });

  const existing = store.list<CalendarEventRow>("calendar_events", [eq("calendar_id", calendar.id)]);
  const existingByKey = new Map(existing.map((row) => [occurrenceKey(row), row]));
  const nowIso = now.toISOString();
  let added = 0;
  let updated = 0;

  for (const occurrence of parsed) {
    const key = occurrenceKey(occurrence);
    const current = existingByKey.get(key);
    if (!current) {
      const row: CalendarEventRow = {
        id: crypto.randomUUID(),
        calendar_id: calendar.id,
        uid: occurrence.uid,
        summary: occurrence.summary,
        location: occurrence.location,
        starts_at: occurrence.starts_at,
        ends_at: occurrence.ends_at,
        all_day: occurrence.all_day ? 1 : 0,
        status: occurrence.status,
        created_at: nowIso,
        updated_at: nowIso,
      };
      store.insert("calendar_events", row);
      added += 1;
      continue;
    }
    existingByKey.delete(key);
    const changed =
      current.summary !== occurrence.summary ||
      current.location !== occurrence.location ||
      current.ends_at !== occurrence.ends_at ||
      current.all_day !== (occurrence.all_day ? 1 : 0) ||
      current.status !== occurrence.status;
    if (!changed) continue;
    store.update("calendar_events", current.id, {
      summary: occurrence.summary,
      location: occurrence.location,
      ends_at: occurrence.ends_at,
      all_day: occurrence.all_day ? 1 : 0,
      status: occurrence.status,
      updated_at: nowIso,
    });
    updated += 1;
  }

  // Anything the feed no longer contains (deleted or moved out of the window).
  let removed = 0;
  for (const stale of existingByKey.values()) {
    store.remove("calendar_events", stale.id);
    removed += 1;
  }

  const total = store.count("calendar_events", [eq("calendar_id", calendar.id)]);
  store.update("calendars", calendar.id, {
    last_synced_at: nowIso,
    last_error: null,
    updated_at: nowIso,
  });
  store.addHistory({
    entity_type: "calendar",
    entity_id: calendar.id,
    action: "synced",
    actor: "system_rules",
    summary:
      "일정 구독 동기화: " +
      added +
      "개 추가, " +
      updated +
      "개 변경, " +
      removed +
      "개 제거",
    details: { added, updated, removed, total, window: { from: sync.from.toISOString(), to: sync.to.toISOString() } },
    at: nowIso,
  });

  return {
    calendar_id: calendar.id,
    synced_at: nowIso,
    window: { from: sync.from.toISOString(), to: sync.to.toISOString() },
    added,
    updated,
    removed,
    total,
  };
}

export function recordSyncFailure(store: Store, calendar: CalendarRow, error: unknown, now: Date): string {
  const message = error instanceof Error ? error.message : String(error);
  const nowIso = now.toISOString();
  store.update("calendars", calendar.id, { last_error: message, updated_at: nowIso });
  store.addHistory({
    entity_type: "calendar",
    entity_id: calendar.id,
    action: "sync_failed",
    actor: "system_rules",
    summary: "일정 구독 동기화 실패: " + message,
    details: null,
    at: nowIso,
  });
  return message;
}

export function occurrencesBetween(
  store: Store,
  from: Date,
  to: Date,
  onlyEnabled = true,
): CalendarOccurrence[] {
  const enabled = new Set(
    store
      .list<CalendarRow>("calendars")
      .filter((row) => !onlyEnabled || row.enabled !== 0)
      .map((row) => row.id),
  );
  if (enabled.size === 0) return [];
  return store
    .list<CalendarEventRow>(
      "calendar_events",
      [
        { sql: "starts_at >= ?", params: [from.toISOString()] },
        { sql: "starts_at <= ?", params: [to.toISOString()] },
      ],
      { order: "starts_at, id" },
    )
    .filter((row) => enabled.has(row.calendar_id))
    .map(calendarEventView);
}
