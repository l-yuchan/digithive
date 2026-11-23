import type { Database } from "bun:sqlite";
import ICAL from "ical.js";
import { z } from "zod";
import { CalendarEvent } from "../integrations/calendar";

export type Occurrence = {
  readonly id: string;
  readonly sourceItemId: string;
  readonly seriesId: string;
  readonly summary: string;
  readonly location: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly localDate: string | null;
  readonly timezone: string | null;
  readonly cancelled: boolean;
  readonly overridden: boolean;
};

export type Window = { readonly from: number; readonly to: number };

export const DEFAULT_WINDOW_DAYS = { before: 7, after: 120 } as const;

const StoredVersion = z.object({
  id: z.string(),
  source_item_id: z.string(),
  content_json: z.string(),
});

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function floating(part: ICAL.Time): string {
  return `${part.year}-${pad(part.month)}-${pad(part.day)}T${pad(part.hour)}:${pad(part.minute)}:${pad(part.second)}`;
}

/** ICAL wire format: no separators, no zone suffix (floating local time). */
function icalTime(part: ICAL.Time): string {
  return `${part.year}${pad(part.month)}${pad(part.day)}T${pad(part.hour)}${pad(part.minute)}${pad(part.second)}`;
}

/** Reads the wall-clock fields straight out of an ISO string that carries its
 * own offset, so a 09:00 Seoul meeting stays 09:00 regardless of the host zone. */
function wallClock(dateTime: string): ICAL.Time {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(dateTime);
  if (!match) return ICAL.Time.fromJSDate(new Date(dateTime), true);
  return new ICAL.Time({
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]),
    isDate: false,
  }, ICAL.Timezone.localTimezone);
}

/** Google attaches TZID to EXDATE/RDATE; the series is expanded as floating
 * time, so the parameter is removed while the value is kept as-is. */
function normaliseRule(rule: string): string {
  return rule.replace(/^(EXDATE|RDATE);[^:]*:/, "$1:");
}

function offsetOf(event: CalendarEvent): string {
  const dateTime = event.start.dateTime;
  if (!dateTime) return "+00:00";
  const match = /([+-]\d{2}:\d{2})$/.exec(dateTime);
  return match?.[1] ?? "+00:00";
}

function toIso(local: string, offset: string): string {
  return `${local}${offset}`;
}

function icsFor(event: CalendarEvent, overrides: readonly CalendarEvent[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//digithive//calendar//EN", "BEGIN:VEVENT"];
  lines.push(`UID:${event.id}`);
  if (event.start.date) {
    lines.push(`DTSTART;VALUE=DATE:${event.start.date.replace(/-/g, "")}`);
    lines.push(`DTEND;VALUE=DATE:${(event.end.date ?? event.start.date).replace(/-/g, "")}`);
  } else {
    lines.push(`DTSTART:${icalTime(wallClock(event.start.dateTime ?? ""))}`);
    lines.push(`DTEND:${icalTime(wallClock(event.end.dateTime ?? event.start.dateTime ?? ""))}`);
  }
  lines.push(`SUMMARY:${(event.summary ?? "").replace(/[\r\n]/g, " ")}`);
  for (const rule of event.recurrence ?? []) lines.push(normaliseRule(rule));
  lines.push("END:VEVENT");
  for (const exception of overrides) {
    const original = exception.originalStartTime;
    if (!original) continue;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${exception.id}`);
    const recurrenceId = original.date
      ? `RECURRENCE-ID;VALUE=DATE:${original.date.replace(/-/g, "")}`
      : `RECURRENCE-ID:${icalTime(wallClock(original.dateTime ?? ""))}`;
    lines.push(recurrenceId);
    if (exception.start.date) {
      lines.push(`DTSTART;VALUE=DATE:${exception.start.date.replace(/-/g, "")}`);
      lines.push(`DTEND;VALUE=DATE:${(exception.end.date ?? exception.start.date).replace(/-/g, "")}`);
    } else {
      lines.push(`DTSTART:${icalTime(wallClock(exception.start.dateTime ?? ""))}`);
      lines.push(`DTEND:${icalTime(wallClock(exception.end.dateTime ?? exception.start.dateTime ?? ""))}`);
    }
    lines.push(`SUMMARY:${(exception.summary ?? event.summary ?? "").replace(/[\r\n]/g, " ")}`);
    if (exception.status === "cancelled") lines.push("STATUS:CANCELLED");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

/** Expands one series (master plus its overridden instances) into occurrences
 * inside the window. Expansion happens in floating wall-clock time so a weekly
 * 09:00 meeting stays at 09:00 local; the stored ISO value carries the master's
 * UTC offset. */
export function expandSeries(
  master: CalendarEvent, overrides: readonly CalendarEvent[], window: Window,
): readonly Occurrence[] {
  const parsed = ICAL.parse(icsFor(master, overrides));
  const calendar = new ICAL.Component(parsed);
  const vevents = calendar.getAllSubcomponents("vevent");
  const masterComponent = vevents[0];
  if (!masterComponent) return [];
  const event = new ICAL.Event(masterComponent);
  for (const child of vevents.slice(1)) {
    try {
      event.relateException(new ICAL.Event(child));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
  const offset = offsetOf(master);
  const timezone = master.start.timeZone ?? null;
  const results: Occurrence[] = [];
  const seen = new Set<string>();

  type Details = ReturnType<ICAL.Event["getOccurrenceDetails"]>;
  const push = (start: ICAL.Time, end: ICAL.Time, details: Details | undefined, allDay: boolean): void => {
    const local = allDay ? `${start.year}-${pad(start.month)}-${pad(start.day)}` : floating(start);
    if (seen.has(local)) return;
    const startMs = allDay
      ? Date.parse(`${local}T00:00:00${offset}`)
      : Date.parse(toIso(local, offset));
    if (!Number.isFinite(startMs) || startMs < window.from || startMs > window.to) return;
    seen.add(local);
    const endLocal = allDay ? `${end.year}-${pad(end.month)}-${pad(end.day)}` : floating(end);
    const exceptionUid = details?.item ? String(details.item.component.getFirstPropertyValue("uid")) : undefined;
    const overridden = exceptionUid !== undefined && exceptionUid !== master.id;
    results.push({
      id: `${master.id}:${local}`,
      sourceItemId: overridden && exceptionUid ? exceptionUid : master.id,
      seriesId: master.recurringEventId ?? master.id,
      summary: details?.item?.summary ?? master.summary ?? "(제목 없음)",
      location: master.location ?? null,
      startsAt: allDay ? `${local}T00:00:00${offset}` : toIso(local, offset),
      endsAt: allDay ? `${endLocal}T00:00:00${offset}` : toIso(endLocal, offset),
      allDay,
      localDate: allDay ? local : null,
      timezone,
      cancelled: String(details?.item?.component.getFirstPropertyValue("status") ?? "") === "CANCELLED",
      overridden,
    });
  };

  const iterator = event.iterator();
  for (let guard = 0; guard < 2_000; guard++) {
    const next = iterator.next();
    if (!next) break;
    const details = event.getOccurrenceDetails(next);
    const allDay = next.isDate;
    const startMs = allDay ? Date.parse(`${next.year}-${pad(next.month)}-${pad(next.day)}T00:00:00Z`) : next.toJSDate().getTime();
    if (Number.isFinite(startMs) && startMs > window.to) break;
    push(details.startDate, details.endDate, details, allDay);
  }
  return results.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}

export function materializeOccurrences(
  db: Database, connectionId: string, window: Window, now = () => Date.now(),
): readonly Occurrence[] {
  const rows = z.array(StoredVersion).parse(db.query(`SELECT v.id, v.source_item_id, v.content_json
    FROM source_items i JOIN source_versions v ON v.id = i.current_version_id
    WHERE i.connection_id = ? AND v.tombstone = 0`).all(connectionId));
  const events = rows.map((row) => ({
    itemId: row.source_item_id,
    event: CalendarEvent.parse(JSON.parse(row.content_json)),
  }));
  const exceptions = new Map<string, CalendarEvent[]>();
  const masters: CalendarEvent[] = [];
  for (const { event } of events) {
    if (event.recurringEventId) {
      const list = exceptions.get(event.recurringEventId) ?? [];
      list.push(event);
      exceptions.set(event.recurringEventId, list);
    } else if ((event.recurrence ?? []).length > 0) {
      masters.push(event);
    }
  }
  const all: Occurrence[] = [];
  const internalByExternal = new Map(events.map((entry) => [entry.event.id, entry.itemId]));
  for (const master of masters) {
    const masterInternalId = internalByExternal.get(master.id) ?? master.id;
    for (const occurrence of expandSeries(master, exceptions.get(master.id) ?? [], window)) {
      all.push({ ...occurrence, sourceItemId: internalByExternal.get(occurrence.sourceItemId) ?? masterInternalId });
    }
  }
  for (const { itemId, event } of events) {
    if ((event.recurrence ?? []).length > 0 || event.recurringEventId) continue;
    if (event.status === "cancelled") continue;
    const allDay = Boolean(event.start.date);
    const local = allDay ? event.start.date ?? "" : floating(wallClock(event.start.dateTime ?? ""));
    const startMs = allDay ? Date.parse(`${local}T00:00:00Z`) : Date.parse(event.start.dateTime ?? "");
    if (!Number.isFinite(startMs) || startMs < window.from || startMs > window.to) continue;
    all.push({
      id: `${itemId}:${local}`,
      sourceItemId: itemId,
      seriesId: event.id,
      summary: event.summary ?? "(제목 없음)",
      location: event.location ?? null,
      startsAt: event.start.dateTime ?? `${local}T00:00:00${offsetOf(event)}`,
      endsAt: event.end.dateTime ?? `${event.end.date ?? local}T00:00:00${offsetOf(event)}`,
      allDay,
      localDate: allDay ? local : null,
      timezone: event.start.timeZone ?? null,
      cancelled: false,
      overridden: false,
    });
  }
  const ordered = all.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  db.transaction(() => {
    db.query("DELETE FROM calendar_occurrences WHERE source_item_id IN (SELECT id FROM source_items WHERE connection_id = ?)")
      .run(connectionId);
    for (const occurrence of ordered) {
      db.query(`INSERT INTO calendar_occurrences
        (id,source_item_id,series_id,summary,location,starts_at,ends_at,all_day,local_date,timezone,cancelled,overridden,refreshed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(occurrence.id, occurrence.sourceItemId, occurrence.seriesId, occurrence.summary, occurrence.location,
          occurrence.startsAt, occurrence.endsAt, occurrence.allDay ? 1 : 0, occurrence.localDate, occurrence.timezone,
          occurrence.cancelled ? 1 : 0, occurrence.overridden ? 1 : 0, new Date(now()).toISOString());
    }
  }).immediate();
  return ordered;
}

export function listOccurrences(db: Database, fromIso: string, toIso: string): readonly Occurrence[] {
  return db.query(`SELECT id,source_item_id,series_id,summary,location,starts_at,ends_at,all_day,local_date,
      timezone,cancelled,overridden FROM calendar_occurrences
    WHERE ends_at >= ? AND starts_at <= ? ORDER BY starts_at`).all(fromIso, toIso)
    .map((row) => {
      const parsed = z.object({
        id: z.string(), source_item_id: z.string(), series_id: z.string(), summary: z.string(),
        location: z.string().nullable(), starts_at: z.string(), ends_at: z.string(), all_day: z.number(),
        local_date: z.string().nullable(), timezone: z.string().nullable(), cancelled: z.number(), overridden: z.number(),
      }).parse(row);
      return {
        id: parsed.id, sourceItemId: parsed.source_item_id, seriesId: parsed.series_id,
        summary: parsed.summary, location: parsed.location, startsAt: parsed.starts_at, endsAt: parsed.ends_at,
        allDay: parsed.all_day === 1, localDate: parsed.local_date, timezone: parsed.timezone,
        cancelled: parsed.cancelled === 1, overridden: parsed.overridden === 1,
      };
    });
}
