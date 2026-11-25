import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import type { AccountRecord } from "../integrations/accounts";
import { createWorkflow, deleteWorkflow } from "../workflows/workflow-store";
import { createBinding } from "./schedule-store";

/** One collection workflow per account, bound to a 15-minute schedule. */
export const COLLECTION_INTERVAL_SECONDS = 900;

function accountCollectionWorkflow(db: Database, accountId: string): string | null {
  const row = db
    .query<{ id: string }, SQLQueryBindings[]>(
      `SELECT id FROM workflows
        WHERE json_extract(executor_json,'$.name') = 'sync_sources'
          AND json_extract(executor_json,'$.accountId') = ?`,
    )
    .get(accountId);
  return row?.id ?? null;
}

/**
 * Gives a newly connected account the collection workflow it needs. An existing
 * one is never touched: a switch the owner turned off stays off, and a definition
 * the owner edited keeps its text and trigger.
 */
export function ensureCollectionWorkflow(
  db: Database,
  account: AccountRecord,
  events?: EventLog,
  now = Date.now(),
): string | null {
  if (accountCollectionWorkflow(db, account.id)) return null;
  const workflow = createWorkflow(
    db,
    {
      title: `연결 자료 수집 · ${account.label}`,
      instruction: "이 계정의 사용 중인 정보를 증분 수집합니다.",
      executor: { kind: "builtin", name: "sync_sources", accountId: account.id },
      params: [],
      timeoutSeconds: 1_800,
    },
    now,
    events,
  );
  try {
    createBinding(
      db,
      {
        workflowId: workflow.id,
        trigger: {
          kind: "interval",
          everySeconds: COLLECTION_INTERVAL_SECONDS,
          anchorAt: new Date(now).toISOString(),
        },
        enabled: true,
        args: {},
      },
      now,
      events,
    );
  } catch (error) {
    // A definition without its schedule would collect nothing; drop it loudly.
    deleteWorkflow(db, workflow.id, { cascade: true, now, ...(events ? { events } : {}) });
    throw error;
  }
  return workflow.id;
}

/**
 * Deleting an account removes the workflows that name it; one left behind would
 * fail on every run against an account that no longer exists.
 */
export function removeAccountWorkflows(db: Database, accountId: string, events?: EventLog): number {
  const rows = db
    .query<{ id: string }, SQLQueryBindings[]>(
      "SELECT id FROM workflows WHERE json_extract(executor_json,'$.accountId') = ?",
    )
    .all(accountId);
  let removed = 0;
  for (const row of rows) {
    try {
      deleteWorkflow(db, row.id, { cascade: true, ...(events ? { events } : {}) });
      removed += 1;
    } catch {
      // A definition with history still deletes; the run rows keep their snapshot.
    }
  }
  return removed;
}
