import type { Database } from "bun:sqlite";
import { z } from "zod";

export type ContextSource = {
  readonly kind: "memory" | "file" | "source_item";
  readonly id: string;
  readonly text: string;
};

export type ContextOptions = {
  readonly systemPrompt: string;
  readonly sources: readonly ContextSource[];
  readonly maxChars?: number;
};

const MAX_CHARS = 8_000;

/**
 * Assembles the model context. Every included source is labelled with its id
 * so the executor can cite only what it was actually given, and total size is
 * bounded so a long history cannot silently inflate a paid request.
 */
export function buildContext(options: ContextOptions): { readonly system: string; readonly usedSources: readonly ContextSource[] } {
  const budget = options.maxChars ?? MAX_CHARS;
  const used: ContextSource[] = [];
  const blocks: string[] = [];
  let remaining = budget;
  for (const source of options.sources) {
    const header = `[${source.kind}:${source.id}]\n`;
    if (header.length + source.text.length + 2 > remaining) break;
    blocks.push(`${header}${source.text}`);
    used.push(source);
    remaining -= header.length + source.text.length + 2;
  }
  return {
    system: blocks.length === 0
      ? options.systemPrompt
      : `${options.systemPrompt}\n\nSources (cite by id, never invent one):\n${blocks.join("\n\n")}`,
    usedSources: used,
  };
}

export const Citation = z.object({
  sourceId: z.string(),
  quote: z.string().min(1),
});
export type Citation = z.infer<typeof Citation>;

/** Citations are accepted only for sources the model was actually given. */
export function validCitations(citations: readonly Citation[], used: readonly ContextSource[]): readonly Citation[] {
  const allowed = new Set(used.map((source) => source.id));
  return citations.filter((citation) => allowed.has(citation.sourceId) && citation.quote.length > 0);
}

export function conversationMessages(rows: readonly { readonly role: string; readonly content: string }[]): readonly { readonly role: "user" | "assistant"; readonly content: string }[] {
  return rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({ role: row.role === "user" ? "user" as const : "assistant" as const, content: row.content }));
}

export function dbConversation(db: Database, conversationId: string): readonly { readonly role: string; readonly content: string }[] {
  return db.query("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at")
    .all(conversationId)
    .map((row) => z.object({ role: z.string(), content: z.string() }).parse(row));
}
