export const TIMEZONE = "Asia/Seoul";

/** Briefing slots in local hours; 07:30 and 21:00 by default. */
export const BRIEFING_SLOTS: readonly { hour: number; minute: number }[] = [
  { hour: 7, minute: 30 },
  { hour: 21, minute: 0 },
];

function kstParts(now: number): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts["year"]),
    month: Number(parts["month"]),
    day: Number(parts["day"]),
    hour: Number(parts["hour"]),
    minute: Number(parts["minute"]),
  };
}

/** Seoul is UTC+9 with no DST, so the offset is a constant. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function nextBriefingAt(now: number, slots: readonly { hour: number; minute: number }[] = BRIEFING_SLOTS): number {
  const local = kstParts(now);
  for (const slot of slots) {
    const candidateLocalMs = Date.UTC(local.year, local.month - 1, local.day, slot.hour, slot.minute) - KST_OFFSET_MS;
    if (candidateLocalMs > now) return candidateLocalMs;
  }
  const first = slots[0] ?? { hour: 7, minute: 30 };
  const tomorrowLocalMs = Date.UTC(local.year, local.month - 1, local.day + 1, first.hour, first.minute) - KST_OFFSET_MS;
  return tomorrowLocalMs;
}

export function briefingRunRequest(now: number): { slot: string; dueAt: string; goal: string } {
  const due = nextBriefingAt(now);
  const parts = kstParts(due);
  return {
    slot: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
    dueAt: new Date(due).toISOString(),
    goal: `정해진 시각(${TIMEZONE})의 브리핑을 작성하고 알림을 보낸다`,
  };
}

export type PushPayload = { readonly title: string; readonly body: string; readonly url?: string };
export type PushTransport = (payload: PushPayload) => Promise<{ ok: boolean; error?: string }>;

export type PushResult = { readonly ok: boolean; readonly error: string | null; readonly at: string };

/**
 * Push delivery is injectable so the failure path is provable without a real
 * device. A failed send returns a visible error, never a silent success.
 */
export async function sendBriefingPush(transport: PushTransport, payload: PushPayload, now = Date.now()): Promise<PushResult> {
  try {
    const result = await transport(payload);
    if (!result.ok) return { ok: false, error: result.error ?? "push_failed", at: new Date(now).toISOString() };
    return { ok: true, error: null, at: new Date(now).toISOString() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "push_threw", at: new Date(now).toISOString() };
  }
}
