import type { FocusWindow, Settings, TimeOfDay } from "../shared";

// Local-time arithmetic with an explicit IANA timezone, computed through
// Intl.DateTimeFormat so behavior is deterministic and dependency-free.
// Storage is always UTC ISO strings; delivery behavior uses settings.timezone.

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
  localDate: string; // YYYY-MM-DD
  time: string; // HH:MM
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const map: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour) % 24;
  const minute = Number(map.minute);
  const weekday = Math.max(0, WEEKDAYS.indexOf((map.weekday ?? "Sun") as (typeof WEEKDAYS)[number]));
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday,
    localDate: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(hour)}:${pad(minute)}`,
  };
}

export function localDateOf(date: Date, timeZone: string): string {
  return localParts(date, timeZone).localDate;
}

/** Wall-clock time in `timeZone` -> the UTC instant it denotes. */
export function zonedTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let ts = target;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(ts), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const next = ts - (asUtc - target);
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

function minutesOf(t: TimeOfDay): number {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m);
}

function hhmm(minutes: number): [number, number] {
  return [Math.floor(minutes / 60), minutes % 60];
}

/** Next upcoming digest boundary (local wall clock) strictly after `now`. */
export function nextDigestBoundary(now: Date, settings: Settings): Date {
  const p = localParts(now, settings.timezone);
  const [h, m] = hhmm(minutesOf(settings.digest_time));
  const today = zonedTimeToUtc(settings.timezone, p.year, p.month, p.day, h, m);
  if (today.getTime() > now.getTime()) return today;
  return zonedTimeToUtc(settings.timezone, p.year, p.month, p.day + 1, h, m);
}

export function inFocusWindow(now: Date, timeZone: string, w: FocusWindow): boolean {
  const p = localParts(now, timeZone);
  const t = p.hour * 60 + p.minute;
  const start = minutesOf(w.start);
  const end = minutesOf(w.end);
  if (start === end) return false; // zero-length window is never active
  if (start < end) return w.days.includes(p.weekday) && t >= start && t < end;
  // Overnight window (e.g. 22:00-06:00): evening part on `days`, morning part
  // on the following day.
  return (
    (w.days.includes(p.weekday) && t >= start) ||
    (w.days.includes((p.weekday + 6) % 7) && t < end)
  );
}

/** UTC instant when the currently-active focus-window occurrence ends. */
export function focusWindowEnd(now: Date, timeZone: string, w: FocusWindow): Date {
  const p = localParts(now, timeZone);
  const t = p.hour * 60 + p.minute;
  const start = minutesOf(w.start);
  const end = minutesOf(w.end);
  const [eh, em] = hhmm(end);
  if (start < end || t < end) {
    return zonedTimeToUtc(timeZone, p.year, p.month, p.day, eh, em);
  }
  return zonedTimeToUtc(timeZone, p.year, p.month, p.day + 1, eh, em);
}

export function activeFocusWindow(now: Date, settings: Settings): FocusWindow | null {
  for (const w of settings.focus_windows) {
    if (inFocusWindow(now, settings.timezone, w)) return w;
  }
  return null;
}

/** Manual quiet mode holds everything; a timed quiet expires at quiet_until. */
export function quietActive(settings: Settings, now: Date): boolean {
  if (!settings.quiet_mode) return false;
  if (settings.quiet_until === null) return true;
  return now.getTime() < Date.parse(settings.quiet_until);
}
