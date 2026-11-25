import { z } from "zod";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { ScheduleTriggerSchema } from "./triggers";
import type { ScheduleBinding } from "../workflows/workflow-types";

/** A schedule is only the automatic trigger of one workflow. */
export type BindingRow = {
  id: string;
  workflow_id: string | null;
  trigger_json: string;
  enabled: number;
  args_json: string;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BindingViewRow = BindingRow & { workflow_title: string | null };

export const BINDING_SELECT =
  "SELECT id,workflow_id,trigger_json,enabled,args_json,next_run_at,created_at,updated_at FROM schedules";

export function parseArgs(raw: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    const parsed = z.record(z.string(), z.unknown()).safeParse(value);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function rowToBinding(row: BindingRow): ScheduleBinding {
  return {
    id: row.id,
    workflowId: row.workflow_id ?? "",
    trigger: ScheduleTriggerSchema.parse(JSON.parse(row.trigger_json)),
    enabled: row.enabled === 1,
    args: parseArgs(row.args_json),
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getBindingRow(db: Database, id: string): BindingRow | null {
  return db.query<BindingRow, SQLQueryBindings[]>(`${BINDING_SELECT} WHERE id = ?`).get(id) ?? null;
}

export function listBindings(db: Database, workflowId?: string): ScheduleBinding[] {
  const rows = workflowId
    ? db
        .query<BindingRow, SQLQueryBindings[]>(
          `${BINDING_SELECT} WHERE workflow_id = ? ORDER BY created_at`,
        )
        .all(workflowId)
    : db.query<BindingRow, SQLQueryBindings[]>(`${BINDING_SELECT} ORDER BY created_at`).all();
  return rows.map(rowToBinding);
}
