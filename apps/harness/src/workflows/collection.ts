import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import type { AccountRecord } from "../integrations/account-store";
import { COLLECTION_SCRIPT, createWorkflow, deleteWorkflow } from "../workflows/workflow-store";
import { createBinding } from "../scheduler/schedule-store";
import { shippedExecutor } from "../store/migrations";

/** One collection workflow per account, bound to a 15-minute schedule. */
export const COLLECTION_INTERVAL_SECONDS = 900;

/**
 * Collection is the app's own script job, so a collection workflow is an ordinary
 * script workflow whose path is `@builtin/collection.ts`. What it reads is not
 * written down here: the script asks the account list for the sources that are on,
 * so turning a feature off stops collection without an edit.
 */
export function collectionExecutor(accountId: string) {
  return shippedExecutor("collection", accountId);
}

/** True for a workflow that collects one account, however it was created. */
export function collectsAccount(executorJson: string, accountId: string): boolean {
  const parsed: unknown = JSON.parse(executorJson || "{}");
  if (typeof parsed !== "object" || parsed === null) return false;
  const executor = parsed as { kind?: unknown; path?: unknown; args?: unknown };
  return (
    executor.kind === "script" &&
    executor.path === COLLECTION_SCRIPT &&
    Array.isArray(executor.args) &&
    executor.args[0] === accountId
  );
}

function accountCollectionWorkflow(db: Database, accountId: string): string | null {
  const rows = db
    .query<{ id: string; executor_json: string }, SQLQueryBindings[]>(
      "SELECT id, executor_json FROM workflows",
    )
    .all();
  return rows.find((row) => collectsAccount(row.executor_json, accountId))?.id ?? null;
}

/**
 * Gives a connected account the collection workflow it needs. An existing one is
 * never touched: a schedule the owner turned off stays off, and a definition the
 * owner edited keeps its text and trigger.
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
      executor: collectionExecutor(account.id),
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
 * Every account gets its collection workflow at startup, not only at the moment it
 * is connected: a database converted from an older version, or an account that was
 * connected while the app was down, would otherwise never be collected.
 */
export function ensureCollectionWorkflows(
  db: Database,
  events?: EventLog,
  now = Date.now(),
): number {
  const accounts = db
    .query<
      {
        id: string;
        provider: string;
        subject: string | null;
        email: string | null;
        label: string;
        created_at: string;
        updated_at: string;
      },
      []
    >("SELECT id,provider,subject,email,label,created_at,updated_at FROM integration_accounts")
    .all();
  let created = 0;
  for (const row of accounts) {
    const account: AccountRecord = {
      id: row.id,
      provider: row.provider === "canvas" ? "canvas" : "google",
      subject: row.subject,
      email: row.email,
      label: row.label,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    try {
      if (ensureCollectionWorkflow(db, account, events, now)) created += 1;
    } catch (error) {
      // One account with a broken schedule must not stop the other accounts.
      events?.append({
        kind: "collection.schedule_failed",
        payload: {
          accountId: account.id,
          error: error instanceof Error ? error.message : String(error),
        },
        now,
      });
    }
  }
  return created;
}

/**
 * Deleting an account removes the workflows that name it; one left behind would
 * fail on every run against an account that no longer exists.
 */
export function removeAccountWorkflows(db: Database, accountId: string, events?: EventLog): number {
  const rows = db
    .query<{ id: string; executor_json: string }, SQLQueryBindings[]>(
      "SELECT id, executor_json FROM workflows",
    )
    .all()
    .filter((row) => collectsAccount(row.executor_json, accountId));
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
