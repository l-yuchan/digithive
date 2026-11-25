import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import type { AccountRecord } from "../integrations/accounts";
import { createSchedule, deleteSchedule } from "./schedule-store";

/** One collection schedule per account, named by the account it reads. */
export const COLLECTION_INTERVAL_SECONDS = 900;

function accountHasCollectionSchedule(db: Database, accountId: string): boolean {
  return (
    db
      .query<{ id: string }, SQLQueryBindings[]>(
        `SELECT id FROM schedules
          WHERE json_extract(executor_json,'$.name') = 'sync_sources'
            AND json_extract(executor_json,'$.accountId') = ?`,
      )
      .get(accountId) !== null
  );
}

/**
 * Gives a newly connected account the collection schedule it needs. An existing
 * schedule is never touched: a switch the owner turned off stays off, and a
 * definition the owner edited keeps its text and trigger.
 */
export function ensureCollectionSchedule(
  db: Database,
  account: AccountRecord,
  events?: EventLog,
  now = Date.now(),
): string | null {
  if (accountHasCollectionSchedule(db, account.id)) return null;
  const created = createSchedule(
    db,
    {
      title: `연결 자료 수집 · ${account.label}`,
      instruction: "이 계정의 사용 중인 정보를 증분 수집합니다.",
      enabled: true,
      trigger: {
        kind: "interval",
        everySeconds: COLLECTION_INTERVAL_SECONDS,
        anchorAt: new Date(now).toISOString(),
      },
      executor: { kind: "builtin", name: "sync_sources", accountId: account.id },
      timeoutSeconds: 1_800,
    },
    now,
    events,
  );
  return created.id;
}

/**
 * Deleting an account removes the schedules that name it; a schedule left behind
 * would fail on an account that no longer exists.
 */
export function removeAccountSchedules(db: Database, accountId: string, events?: EventLog): number {
  const rows = db
    .query<{ id: string }, SQLQueryBindings[]>(
      "SELECT id FROM schedules WHERE json_extract(executor_json,'$.accountId') = ?",
    )
    .all(accountId);
  let removed = 0;
  for (const row of rows) {
    if (deleteSchedule(db, row.id, events)) removed += 1;
  }
  return removed;
}
