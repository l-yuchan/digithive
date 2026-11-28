import type { Database, SQLQueryBindings } from "bun:sqlite";

export function cursorOf(db: Database, accountId: string, source: string): string | null {
  const row = db
    .query<{ cursor: string | null }, SQLQueryBindings[]>(
      "SELECT cursor FROM account_sources WHERE account_id = ? AND source = ?",
    )
    .get(accountId, source);
  return row?.cursor ?? null;
}

/** What one collection pass read so far; `skipped` counts items the provider no longer has. */
export type Progress = { items: number; skipped?: number };

export function failureDetail(progress: Progress): Record<string, unknown> {
  return {
    partial: progress.items > 0,
    collected: progress.items,
    ...(progress.skipped ? { skipped: progress.skipped } : {}),
  };
}
