import type { Database, SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { RunExecutorSchema, type RunExecutor } from "../core/executor";
import { ScheduleTriggerSchema, nextDueAfter, type ScheduleTrigger } from "./triggers";

const ScheduleInput = z.object({
  title: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(4_096),
  enabled: z.boolean().default(true),
  trigger: ScheduleTriggerSchema,
  executor: RunExecutorSchema,
  timeoutSeconds: z.number().int().min(1).max(86_400).default(1_800),
});

export const CreateScheduleSchema = ScheduleInput;
/** A patch has no defaults: absent keys must never reset enabled/timeout fields. */
export const UpdateScheduleSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  instruction: z.string().trim().min(1).max(4_096).optional(),
  enabled: z.boolean().optional(),
  trigger: ScheduleTriggerSchema.optional(),
  executor: RunExecutorSchema.optional(),
  timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
});

export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleSchema>;

export type Schedule = {
  readonly id: string;
  readonly title: string;
  readonly instruction: string;
  readonly enabled: boolean;
  readonly trigger: ScheduleTrigger;
  readonly executor: RunExecutor;
  readonly timeoutSeconds: number;
  readonly nextRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type LastRun = {
  readonly id: string;
  readonly status: string;
  readonly resultJson: string | null;
  readonly settledAt: string | null;
};

export type ScheduleView = Schedule & { readonly lastRun: LastRun | null };

export type ScheduleRow = {
  id: string;
  title: string;
  instruction: string;
  enabled: number;
  trigger_json: string;
  executor_json: string;
  timeout_seconds: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export const SCHEDULE_SELECT =
  "SELECT id,title,instruction,enabled,trigger_json,executor_json,timeout_seconds,next_run_at,created_at,updated_at FROM schedules";

export function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    title: row.title,
    instruction: row.instruction,
    enabled: row.enabled === 1,
    trigger: ScheduleTriggerSchema.parse(JSON.parse(row.trigger_json)),
    executor: RunExecutorSchema.parse(JSON.parse(row.executor_json)),
    timeoutSeconds: row.timeout_seconds,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readSchedule(db: Database, id: string): ScheduleRow | null {
  return (
    db.query<ScheduleRow, SQLQueryBindings[]>(`${SCHEDULE_SELECT} WHERE id = ?`).get(id) ?? null
  );
}

export function nextFor(trigger: ScheduleTrigger, enabled: boolean, now: number): string | null {
  if (!enabled) return null;
  const at = nextDueAfter(trigger, now);
  return at === null ? null : new Date(at).toISOString();
}
