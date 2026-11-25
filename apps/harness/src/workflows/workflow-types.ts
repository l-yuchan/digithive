import { z } from "zod";
import { RunExecutorSchema, type RunExecutor } from "../core/executor";
import { ScheduleTriggerSchema, type ScheduleTrigger } from "../scheduler/triggers";

/**
 * A definition that can be run on demand or bound to a schedule. Definitions own
 * no trigger and no `next_run_at`: those belong to the binding rows, so a
 * workflow that was never scheduled is a normal object, not a paused schedule.
 */

export const WORKFLOW_PARAM_TYPES = ["string", "number", "boolean", "json"] as const;
export type WorkflowParamType = (typeof WORKFLOW_PARAM_TYPES)[number];

export const MAX_WORKFLOW_PARAMS = 16;
export const MAX_PARAM_STRING = 4_000;
export const MAX_PARAM_JSON = 8_000;

/** Shared by the schema and by run-time resolution so both reject the same values. */
export function valueMatchesParamType(type: WorkflowParamType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string" && value.length <= MAX_PARAM_STRING;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "json":
      try {
        const text = JSON.stringify(value);
        return text !== undefined && text.length <= MAX_PARAM_JSON;
      } catch {
        return false;
      }
    default: {
      const unreachable: never = type;
      throw new Error(`unknown_param_type:${String(unreachable)}`);
    }
  }
}

export const WorkflowParamSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/, "invalid_param_name"),
    type: z.enum(WORKFLOW_PARAM_TYPES),
    required: z.boolean().default(false),
    default: z.unknown().optional(),
    description: z.string().trim().max(200).optional(),
  })
  .superRefine((param, ctx) => {
    if (param.default !== undefined && !valueMatchesParamType(param.type, param.default)) {
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message: `invalid_param_default:${param.name}`,
      });
    }
  });

export type WorkflowParam = z.infer<typeof WorkflowParamSchema>;
/** What a caller may supply: defaulted fields are optional at the edge. */
export type WorkflowParamInput = z.input<typeof WorkflowParamSchema>;

export const WorkflowParamsSchema = z
  .array(WorkflowParamSchema)
  .max(MAX_WORKFLOW_PARAMS, "too_many_params")
  .superRefine((params, ctx) => {
    const seen = new Set<string>();
    for (const [index, param] of params.entries()) {
      if (seen.has(param.name)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `duplicate_param:${param.name}`,
        });
      }
      seen.add(param.name);
    }
  });

export type Workflow = {
  readonly id: string;
  readonly title: string;
  readonly instruction: string;
  readonly executor: RunExecutor;
  readonly params: readonly WorkflowParam[];
  readonly timeoutSeconds: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type WorkflowRow = {
  id: string;
  title: string;
  instruction: string;
  executor_json: string;
  params_json: string;
  timeout_seconds: number;
  created_at: string;
  updated_at: string;
};

export const WORKFLOW_SELECT =
  "SELECT id,title,instruction,executor_json,params_json,timeout_seconds,created_at,updated_at FROM workflows";

export function rowToWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    title: row.title,
    instruction: row.instruction,
    executor: RunExecutorSchema.parse(JSON.parse(row.executor_json)),
    params: WorkflowParamsSchema.parse(JSON.parse(row.params_json || "[]")),
    timeoutSeconds: row.timeout_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const WorkflowInput = z.object({
  title: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(4_096),
  executor: RunExecutorSchema,
  params: WorkflowParamsSchema.default([]),
  timeoutSeconds: z.number().int().min(1).max(86_400).default(1_800),
});

export const CreateWorkflowSchema = WorkflowInput;
/** A patch has no defaults: absent keys must never reset params or timeout. */
export const UpdateWorkflowSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  instruction: z.string().trim().min(1).max(4_096).optional(),
  executor: RunExecutorSchema.optional(),
  params: WorkflowParamsSchema.optional(),
  timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
});

export type CreateWorkflowInput = z.input<typeof CreateWorkflowSchema>;
export type UpdateWorkflowInput = z.input<typeof UpdateWorkflowSchema>;

/** A schedule is only the automatic trigger of one workflow. */
export type ScheduleBinding = {
  readonly id: string;
  readonly workflowId: string;
  readonly trigger: ScheduleTrigger;
  readonly enabled: boolean;
  readonly args: Readonly<Record<string, unknown>>;
  readonly nextRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export const CreateScheduleBindingSchema = z.object({
  workflowId: z.string().min(1),
  trigger: ScheduleTriggerSchema,
  enabled: z.boolean().default(true),
  args: z.record(z.string(), z.unknown()).default({}),
});

export const UpdateScheduleBindingSchema = z.object({
  trigger: ScheduleTriggerSchema.optional(),
  enabled: z.boolean().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

export type CreateScheduleBindingInput = z.input<typeof CreateScheduleBindingSchema>;
export type UpdateScheduleBindingInput = z.input<typeof UpdateScheduleBindingSchema>;

export type RunSummary = {
  readonly id: string;
  readonly status: string;
  readonly triggerKind: string | null;
  readonly params: unknown;
  readonly resultJson: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
};

export type WorkflowView = Workflow & {
  readonly schedules: readonly ScheduleBinding[];
  readonly lastRun: RunSummary | null;
};

export type ScheduleBindingView = ScheduleBinding & {
  readonly workflowTitle: string;
  readonly lastRun: RunSummary | null;
};

/**
 * Deferred loading contract: one search mode at a time keeps the meaning of a
 * hit unambiguous, and the caller then asks for the detail sections it needs.
 */
export const WORKFLOW_DETAIL_SECTIONS = [
  "definition",
  "params",
  "executor",
  "schedules",
  "runs",
  "caps",
] as const;
export type WorkflowDetailSection = (typeof WORKFLOW_DETAIL_SECTIONS)[number];

export const WorkflowSearchSchema = z
  .object({
    keyword: z.string().trim().min(1).max(200).optional(),
    regex: z.string().min(1).max(500).optional(),
    bm25: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .superRefine((input, ctx) => {
    const modes = [input.keyword, input.regex, input.bm25].filter((value) => value !== undefined);
    if (modes.length > 1) {
      ctx.addIssue({ code: "custom", message: "search_mode_conflict" });
    }
  });

export type WorkflowSearchInput = z.infer<typeof WorkflowSearchSchema>;

export const WorkflowDetailQuerySchema = z.object({
  id: z.string().min(1),
  filter: z.array(z.enum(WORKFLOW_DETAIL_SECTIONS)).min(1).max(6).optional(),
});

export const RunWorkflowInputSchema = z.object({
  id: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  /** false: run now and return the outcome; true: enqueue and return the run id. */
  async: z.boolean().default(false),
});

export type RunWorkflowInput = z.input<typeof RunWorkflowInputSchema>;
