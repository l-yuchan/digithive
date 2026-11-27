import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { z } from "zod";

const BriefingItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  at: z.string().nullable(),
  detail: z.string(),
  accountId: z.string().optional(),
  accountLabel: z.string().optional(),
});

export const BriefingContentSchema = z.object({
  runId: z.string().optional(),
  slot: z.string(),
  generatedAt: z.string(),
  events: z.array(BriefingItemSchema).readonly().default([]),
  assignments: z.array(BriefingItemSchema).readonly().default([]),
  mail: z.array(BriefingItemSchema).readonly().default([]),
  text: z.string(),
  references: z.array(z.string()).readonly().default([]),
});

export type BriefingContent = Readonly<z.infer<typeof BriefingContentSchema>>;
export class BriefingStoreError extends Error {
  readonly name = "BriefingStoreError";

  constructor(readonly code: "briefing_requires_sources") {
    super(code);
  }
}

export type BriefingPublication = {
  readonly id: string;
  readonly duplicate: boolean;
  readonly prompt: { readonly title: string; readonly body: string } | null;
  readonly content: BriefingContent;
};

function currentSlot(now: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

/** Stores exactly the text the agent wrote; deterministic item composition is not involved. */
export function storeAgentBriefing(input: {
  readonly db: Database;
  readonly events: EventLog;
  readonly runId: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly slot?: string;
  readonly now: number;
}): BriefingPublication {
  const text = z.string().trim().min(1).max(60_000).parse(input.text);
  const sourceIds = [...new Set(z.array(z.string().min(1)).max(100).parse(input.sourceIds))];
  if (sourceIds.length === 0) throw new BriefingStoreError("briefing_requires_sources");
  const id = crypto.randomUUID();
  const content = {
    runId: input.runId,
    slot: input.slot ?? currentSlot(input.now),
    generatedAt: new Date(input.now).toISOString(),
    events: [],
    assignments: [],
    mail: [],
    text,
    references: sourceIds,
  } as const satisfies BriefingContent;
  const inserted = input.db
    .query(
      "INSERT OR IGNORE INTO briefings (id,slot,content_json,created_at,run_id) VALUES (?,?,?,?,?)",
    )
    .run(id, content.slot, JSON.stringify(content), content.generatedAt, input.runId);
  const duplicate = inserted.changes === 0;
  if (!duplicate) {
    input.events.append({
      kind: "briefing.stored",
      runId: input.runId,
      payload: {
        slot: content.slot,
        briefingId: id,
        sourceIds,
        pushed: false,
        error: null,
      },
      now: input.now,
    });
  }
  return {
    id,
    duplicate,
    prompt: duplicate
      ? null
      : { title: `digithive 브리핑 ${content.slot}`, body: text.slice(0, 1_000) },
    content,
  };
}

export function latestAgentBriefing(db: Database): {
  readonly slot: string;
  readonly content: BriefingContent;
  readonly createdAt: string;
} | null {
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
