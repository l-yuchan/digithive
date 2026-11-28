import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";
import type { NormalizedItem, SyncOutcome } from "./normalize";

/** Items are keyed by account and source, so identical provider ids coexist. */
export function saveItems(
  db: Database,
  accountId: string,
  source: string,
  items: readonly NormalizedItem[],
  now: number,
): void {
  const iso = new Date(now).toISOString();
  db.query("INSERT OR IGNORE INTO account_sources(account_id,source) VALUES (?,?)").run(
    accountId,
    source,
  );
  const statement = db.query(
    "INSERT INTO sync_items (account_id, source, item_id, title, at, detail, url, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_id, source, item_id) DO UPDATE SET title=excluded.title, at=excluded.at, detail=excluded.detail, url=excluded.url, updated_at=excluded.updated_at",
  );
  for (const item of items) {
    statement.run(
      accountId,
      source,
      item.id,
      item.title,
      item.at,
      item.detail.slice(0, 2_000),
      item.url,
      iso,
    );
  }
}

export type OutcomeInput = {
  readonly db: Database;
  readonly events: EventLog;
  readonly now?: () => number;
};

export type OutcomeResult = {
  readonly accountId: string;
  readonly source: SyncOutcome["source"];
  readonly ok: boolean;
  readonly count: number;
  readonly cursor: string | null;
  readonly error: string | null;
  /** Extra visible context for a partial collection, e.g. pages read. */
  readonly detail?: Record<string, unknown>;
};

/**
 * Records the attempt for exactly one account and source. A failure keeps the
 * last successful sync time and cursor, and updates the attempt time, so a
 * broken account is visible without erasing usable data.
 */
export function recordOutcome(input: OutcomeInput, result: OutcomeResult): SyncOutcome {
  const now = (input.now ?? Date.now)();
  const iso = new Date(now).toISOString();
  const detail = JSON.stringify({ count: result.count, ...result.detail });
  input.db
    .query("INSERT OR IGNORE INTO account_sources(account_id,source) VALUES (?,?)")
    .run(result.accountId, result.source);
  input.db
    .query(
      "INSERT INTO account_sources (account_id, source, cursor, last_sync_at, last_attempt_at, ok, error, detail_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_id,source) DO UPDATE SET cursor=COALESCE(excluded.cursor, account_sources.cursor), last_sync_at=COALESCE(excluded.last_sync_at, account_sources.last_sync_at), last_attempt_at=excluded.last_attempt_at, ok=excluded.ok, error=excluded.error, detail_json=excluded.detail_json",
    )
    .run(
      result.accountId,
      result.source,
      result.cursor,
      result.ok ? iso : null,
      iso,
      result.ok ? 1 : 0,
      result.error,
      detail,
    );
  input.events.append({
    kind: "integration.sync_state",
    payload: {
      accountId: result.accountId,
      source: result.source,
      ok: result.ok,
      count: result.count,
      error: result.error,
      ...result.detail,
    },
    now,
  });
  const skippedItems = result.detail?.["skipped"];
  return {
    accountId: result.accountId,
    source: result.source,
    ok: result.ok,
    count: result.count,
    cursor: result.cursor,
    error: result.error,
    ...(typeof skippedItems === "number" && skippedItems > 0 ? { skippedItems } : {}),
  };
}

/** A disabled source is skipped before any token or network work happens. */
export function skippedOutcome(accountId: string, source: SyncOutcome["source"]): SyncOutcome {
  return {
    accountId,
    source,
    ok: false,
    skipped: true,
    count: 0,
    cursor: null,
    error: "source_disabled",
  };
}
