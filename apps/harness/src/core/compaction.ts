import type { Database } from "bun:sqlite";
import { appendEntry } from "./sessions";
import { pathEntries } from "./tree";
import type { CompactionView } from "./context";

export type CompactionOptions = {
  readonly db: Database;
  readonly sessionId: string;
  readonly summarize: (transcript: string) => Promise<string>;
  readonly maxChars: number;
  readonly threshold?: number;
  readonly keepRecent?: number;
  readonly now?: number;
};

export type CompactionResult = {
  readonly compacted: boolean;
  readonly entryId?: string;
  readonly coveredMessages?: number;
};

export function latestCompaction(db: Database, sessionId: string): CompactionView | null {
  const path = new Set(pathEntries(db, sessionId).map((entry) => entry.id));
  const rows = db.query("SELECT payload_json FROM entries WHERE session_id = ? AND kind = 'compaction' ORDER BY seq DESC")
    .all(sessionId) as { payload_json: string }[];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as { summary?: unknown; coversSeq?: unknown; coversUpTo?: unknown };
      if (typeof payload.summary === "string" && typeof payload.coversSeq === "number" && typeof payload.coversUpTo === "string" && path.has(payload.coversUpTo)) {
        return { summary: payload.summary, coversSeq: payload.coversSeq };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return null;
}

/**
 * Compacts older messages into a summary entry once the active branch exceeds
 * the threshold. Originals stay in the tree; the summary only stands in for
 * them when the context is assembled.
 */
export async function maybeCompact(options: CompactionOptions): Promise<CompactionResult> {
  const threshold = options.threshold ?? 0.6;
  const keepRecent = options.keepRecent ?? 4;
  const now = options.now ?? Date.now();

  const latest = latestCompaction(options.db, options.sessionId);
  const messages = pathEntries(options.db, options.sessionId).filter(
    (entry) =>
      entry.kind === "message" &&
      (entry.role === "user" || entry.role === "assistant") &&
      (!latest || entry.seq > latest.coversSeq),
  );
  const totalChars = messages.reduce(
    (sum, entry) =>
      sum +
      entry.parts
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .reduce((inner, part) => inner + part.text.length, 0),
    0,
  );
  if (messages.length <= keepRecent || totalChars < options.maxChars * threshold) {
    return { compacted: false };
  }

  const splitAt = messages.length - keepRecent;
  const covered = messages.slice(0, splitAt);
  const lastCovered = covered.at(-1);
  if (!lastCovered) return { compacted: false };

  const transcript = covered
    .map((entry) => {
      const text = entry.parts
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join(" ");
      return `${entry.role === "user" ? "사용자" : "비서"}: ${text}`;
    })
    .join("\n");
  if (transcript.trim().length === 0) return { compacted: false };

  const summary = (await options.summarize(transcript)).trim();
  if (summary.length === 0) return { compacted: false };

  const entry = appendEntry(options.db, {
    sessionId: options.sessionId,
    kind: "compaction",
    parts: [{ type: "text", text: summary }],
    now,
  });
  options.db
    .query("UPDATE entries SET payload_json = ? WHERE id = ?")
    .run(JSON.stringify({ parts: [{ type: "text", text: summary }], summary, coversSeq: lastCovered.seq, coversUpTo: lastCovered.id }), entry.id);
  return { compacted: true, entryId: entry.id, coveredMessages: covered.length };
}
