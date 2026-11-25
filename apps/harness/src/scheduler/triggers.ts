import { z } from "zod";

function parseable(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/** IANA zone names are validated by ICU, not by a hand-written allowlist. */
export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const IsoInstant = z.string().refine(parseable, "invalid_instant");

export const ScheduleTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: IsoInstant }),
  z.object({
    kind: z.literal("interval"),
    everySeconds: z.number().int().min(1),
    anchorAt: IsoInstant,
  }),
  z.object({
    kind: z.literal("daily"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "invalid_time"),
    timeZone: z.string().min(1).refine(validTimeZone, "invalid_time_zone"),
  }),
]);

export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;

export type DueSlot = {
  /** UTC instant of the slot. */
  readonly instant: number;
  /** Stable identity of the slot; daily slots use the local wall clock. */
  readonly scheduledFor: string;
};

type LocalParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(instant: number, timeZone: string): LocalParts {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  const values = new Map(
    formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  const hour = Number(values.get("hour"));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: hour === 24 ? 0 : hour,
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

function offsetMs(instant: number, timeZone: string): number {
  const parts = localParts(instant, timeZone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    Math.floor(instant / 1_000) * 1_000
  );
}

/**
 * Resolves a wall-clock time in `timeZone` to a UTC instant. For an ambiguous
 * fall-back time the earliest occurrence wins, so a tick inside the repeated
 * hour still sees the slot as due. Returns null for a skipped spring-forward
 * time instead of silently shifting it.
 */
export function wallToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const candidates = new Set<number>();
  for (const probe of [wall - 12 * 3_600_000, wall, wall + 12 * 3_600_000]) {
    const instant = wall - offsetMs(probe, timeZone);
    const check = localParts(instant, timeZone);
    if (
      check.year === year &&
      check.month === month &&
      check.day === day &&
      check.hour === hour &&
      check.minute === minute
    )
      candidates.add(instant);
  }
  if (candidates.size === 0) return null;
  return Math.min(...candidates);
}

function shiftDate(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function dateKey(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(
    parts.day,
  ).padStart(2, "0")}`;
}

function dailySlotFor(trigger: Extract<ScheduleTrigger, { kind: "daily" }>, date: {
  year: number;
  month: number;
  day: number;
}): DueSlot | null {
  const [hour, minute] = trigger.time.split(":").map(Number);
  if (hour === undefined || minute === undefined) return null;
  const instant = wallToInstant(
    date.year,
    date.month,
    date.day,
    hour,
    minute,
    trigger.timeZone,
  );
  if (instant === null) return null;
  return { instant, scheduledFor: `${dateKey(date)}T${trigger.time}:00` };
}

function nextDailySlot(
  trigger: Extract<ScheduleTrigger, { kind: "daily" }>,
  now: number,
): DueSlot | null {
  const local = localParts(now, trigger.timeZone);
  for (let offset = 0; offset <= 4; offset += 1) {
    const date = shiftDate(local.year, local.month, local.day, offset);
    const slot = dailySlotFor(trigger, date);
    if (slot && slot.instant > now) return slot;
  }
  return null;
}

function latestDailySlot(
  trigger: Extract<ScheduleTrigger, { kind: "daily" }>,
  now: number,
): DueSlot | null {
  const local = localParts(now, trigger.timeZone);
  for (let offset = 0; offset >= -4; offset -= 1) {
    const date = shiftDate(local.year, local.month, local.day, offset);
    const slot = dailySlotFor(trigger, date);
    if (slot && slot.instant <= now) return slot;
  }
  return null;
}

/** The next instant strictly after `now`, or null when a one-shot is spent. */
export function nextDueAfter(trigger: ScheduleTrigger, now: number): number | null {
  if (trigger.kind === "once") {
    const at = Date.parse(trigger.at);
    return at > now ? at : null;
  }
  if (trigger.kind === "interval") {
    const anchor = Date.parse(trigger.anchorAt);
    const every = trigger.everySeconds * 1_000;
    if (now < anchor) return anchor;
    return anchor + (Math.floor((now - anchor) / every) + 1) * every;
  }
  return nextDailySlot(trigger, now)?.instant ?? null;
}

/**
 * The latest slot that has come due, coalescing every missed slot into one.
 * Daily identity uses the local date so a DST fall-back hour cannot fire twice.
 */
export function latestDueAtOrBefore(trigger: ScheduleTrigger, now: number): DueSlot | null {
  if (trigger.kind === "once") {
    const at = Date.parse(trigger.at);
    if (at > now) return null;
    return { instant: at, scheduledFor: new Date(at).toISOString() };
  }
  if (trigger.kind === "interval") {
    const anchor = Date.parse(trigger.anchorAt);
    if (now < anchor) return null;
    const every = trigger.everySeconds * 1_000;
    const instant = anchor + Math.floor((now - anchor) / every) * every;
    return { instant, scheduledFor: new Date(instant).toISOString() };
  }
  return latestDailySlot(trigger, now);
}

/** True when the trigger has a future occurrence at all. */
export function triggerHasFuture(trigger: ScheduleTrigger, now: number): boolean {
  return nextDueAfter(trigger, now) !== null;
}
