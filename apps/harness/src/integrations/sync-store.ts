import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";
import type { NormalizedItem, SyncOutcome } from "./normalize";

export function saveItems(db: Database, source: string, items: readonly NormalizedItem[], now: number): void {
  const iso = new Date(now).toISOString();
  const statement = db.query(
    "INSERT INTO sync_items (source, item_id, title, at, detail, url, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source, item_id) DO UPDATE SET title=excluded.title, at=excluded.at, detail=excluded.detail, url=excluded.url, updated_at=excluded.updated_at",
  );
  for (const item of items) {
    statement.run(source, item.id, item.title, item.at, item.detail.slice(0, 2_000), item.url, iso);
  }
}

export function recordOutcome(
  input: { readonly db: Database; readonly events: EventLog; readonly now?: () => number },
  source: SyncOutcome["source"],
  ok: boolean,
  count: number,
  cursor: string | null,
  error: string | null,
): SyncOutcome {
  const now = (input.now ?? Date.now)();
  const iso = new Date(now).toISOString();
  input.db
    .query(
      "INSERT INTO integration_state (source, cursor, last_sync_at, ok, error, detail_json) VALUES (?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=COALESCE(excluded.cursor, integration_state.cursor), last_sync_at=excluded.last_sync_at, ok=excluded.ok, error=excluded.error, detail_json=excluded.detail_json",
    )
    .run(source, cursor, iso, ok ? 1 : 0, error, JSON.stringify({ count }));
  input.events.append({ kind: "integration.sync_state", payload: { source, ok, count, error }, now });
  return { source, ok, count, cursor, error };
}
