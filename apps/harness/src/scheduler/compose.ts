import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { BRIEFING_SLOTS, TIMEZONE } from "./briefing";
import { z } from "zod";

const BriefingItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  at: z.string().nullable(),
  detail: z.string(),
  accountId: z.string().optional(),
  accountLabel: z.string().optional(),
});
const BriefingContentSchema = z.object({
  runId: z.string().optional(),
  slot: z.string(),
  generatedAt: z.string(),
  events: z.array(BriefingItemSchema).readonly(),
  assignments: z.array(BriefingItemSchema).readonly(),
  mail: z.array(BriefingItemSchema).readonly(),
  text: z.string(),
});
type BriefingItem = Readonly<z.infer<typeof BriefingItemSchema>>;
export type BriefingContent = Readonly<z.infer<typeof BriefingContentSchema>>;

function kstDay(now: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

function kstParts(now: number): { day: string; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(now)).map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    hour: Number(parts["hour"]),
    minute: Number(parts["minute"]),
  };
}

/**
 * The slot that has just come due, if any: a slot fires when its minute has
 * passed and we are still inside the short catch-up window.
 */
export function dueSlot(now: number, windowMinutes = 10): { slot: string; day: string } | null {
  const local = kstParts(now);
  const minutesNow = local.hour * 60 + local.minute;
  for (const slot of BRIEFING_SLOTS) {
    const slotMinutes = slot.hour * 60 + slot.minute;
    if (minutesNow >= slotMinutes && minutesNow < slotMinutes + windowMinutes) {
      return {
        slot: `${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}`,
        day: local.day,
      };
    }
  }
  return null;
}

function rows(
  db: Database,
  source: string,
  from: number,
  until: number,
  limit: number,
  accountId?: string,
): BriefingItem[] {
  return db
    .query<
      {
        account_id: string;
        label: string;
        item_id: string;
        title: string;
        at: string | null;
        detail: string | null;
      },
      SQLQueryBindings[]
    >(
      "SELECT i.account_id,a.label,i.item_id,i.title,i.at,i.detail FROM sync_items i JOIN account_sources s ON s.account_id=i.account_id AND s.source=i.source JOIN integration_accounts a ON a.id=i.account_id WHERE i.source=? AND s.enabled=1 AND (? IS NULL OR i.account_id=?) AND (i.at IS NULL OR (i.at>=? AND i.at<=?)) ORDER BY i.at LIMIT ?",
    )
    .all(
      source,
      accountId ?? null,
      accountId ?? null,
      new Date(from).toISOString(),
      new Date(until).toISOString(),
      limit,
    )
    .map((row) => ({
      id: row["item_id"],
      title: row["title"],
      at: row["at"] === null ? null : row["at"],
      detail: row["detail"] ?? "",
      accountId: row.account_id,
      accountLabel: row.label,
    }));
}

function line(prefix: string, item: BriefingItem): string {
  const when = item.at
    ? new Date(item.at).toLocaleString("ko-KR", {
        timeZone: TIMEZONE,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "시간 미정";
  const reference = item.accountId ? `${item.accountId}:${item.id}` : item.id;
  return `- [${prefix}:${reference}] ${when} · ${item.title}${item.accountLabel ? ` (${item.accountLabel})` : ""}`;
}

export function composeBriefing(
  db: Database,
  now: number,
  options: {
    readonly horizonHours?: number;
    readonly slot?: string;
    readonly accountId?: string;
  } = {},
): BriefingContent {
  const { horizonHours = 36, slot = "manual", accountId } = options;
  const until = now + horizonHours * 60 * 60 * 1_000;
  const events = rows(db, "calendar", now - 12 * 60 * 60 * 1_000, until, 20, accountId);
  const assignments = rows(db, "canvas", now - 60 * 60 * 1_000, until, 20, accountId);
  const mail = rows(db, "gmail", now - 24 * 60 * 60 * 1_000, until, 12, accountId);
  const parts: string[] = [];
  parts.push(
    events.length > 0
      ? `일정\n${events.map((item) => line("calendar", item)).join("\n")}`
      : "일정\n- 예정된 일정이 없습니다.",
  );
  parts.push(
    assignments.length > 0
      ? `과제\n${assignments.map((item) => line("lms", item)).join("\n")}`
      : "과제\n- 마감이 임박한 과제가 없습니다.",
  );
  parts.push(
    mail.length > 0
      ? `메일\n${mail.map((item) => line("mail", item)).join("\n")}`
      : "메일\n- 새 메일이 없습니다.",
  );
  return {
    slot,
    generatedAt: new Date(now).toISOString(),
    events,
    assignments,
    mail,
    text: parts.join("\n\n"),
  };
}

export function storeBriefing(
  db: Database,
  content: BriefingContent,
  now: number,
): { id: string; duplicate: boolean } {
  const id = crypto.randomUUID();
  const result = db
    .query(
      "INSERT OR IGNORE INTO briefings (id, slot, content_json, created_at,run_id) VALUES (?,?,?,?,?)",
    )
    .run(
      id,
      content.slot,
      JSON.stringify(content),
      new Date(now).toISOString(),
      content.runId ?? null,
    );
  return { id, duplicate: result.changes === 0 };
}

export function latestBriefing(
  db: Database,
): { slot: string; content: BriefingContent; createdAt: string } | null {
  const row = db
    .query<{ slot: string; content_json: string; created_at: string }, SQLQueryBindings[]>(
      "SELECT slot, content_json, created_at FROM briefings ORDER BY created_at DESC LIMIT 1",
    )
    .get();
  if (!row) return null;
  try {
    return {
      slot: row.slot,
      content: BriefingContentSchema.parse(JSON.parse(row.content_json)),
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

export type BriefingDeps = {
  readonly runId?: string;
  readonly accountId?: string;
  readonly db: Database;
  readonly events: EventLog;
  readonly push?: (payload: {
    title: string;
    body: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  readonly now?: () => number;
};

/** Composes, stores (once per slot per day) and pushes one briefing. */
export async function runBriefing(
  deps: BriefingDeps,
  force = false,
): Promise<{ slot: string; stored: boolean; pushed: boolean; error: string | null }> {
  const now = (deps.now ?? Date.now)();
  const local = kstParts(now);
  const due = force
    ? {
        slot: deps.runId
          ? `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`
          : "manual",
        day: kstDay(now),
      }
    : dueSlot(now);
  if (!due) return { slot: "none", stored: false, pushed: false, error: null };

  const content = {
    ...composeBriefing(deps.db, now, {
      slot: due.slot,
      ...(deps.accountId ? { accountId: deps.accountId } : {}),
    }),
    ...(deps.runId ? { runId: deps.runId } : {}),
  };
  const stored = storeBriefing(deps.db, content, now);
  if (stored.duplicate) return { slot: due.slot, stored: false, pushed: false, error: null };

  let pushed = false;
  let error: string | null = null;
  if (deps.push) {
    const result = await deps.push({
      title: `digithive 브리핑 ${due.slot}`,
      body: content.text.slice(0, 180),
    });
    pushed = result.ok;
    error = result.ok ? null : (result.error ?? "push_failed");
  }
  deps.events.append({
    kind: "briefing.stored",
    payload: { slot: due.slot, briefingId: stored.id, pushed, error },
    now,
  });
  return { slot: due.slot, stored: true, pushed, error };
}
