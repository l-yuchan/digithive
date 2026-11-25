import type { Database, SQLQueryBindings } from "bun:sqlite";

export function cursorOf(db: Database, accountId: string, source: string): string | null {
  const row = db
    .query<{ cursor: string | null }, SQLQueryBindings[]>(
      "SELECT cursor FROM account_sources WHERE account_id = ? AND source = ?",
    )
    .get(accountId, source);
  return row?.cursor ?? null;
}

export type Progress = { items: number };

export function failureDetail(progress: Progress): Record<string, unknown> {
  return { partial: progress.items > 0, collected: progress.items };
}
