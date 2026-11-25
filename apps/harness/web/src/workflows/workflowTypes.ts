import { z } from "zod";

export const PARAM_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
export const MAX_WORKFLOW_PARAMS = 16;
export const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "awaiting_approval"]);

export const CAPABILITY_GROUPS = [
  "workflow.read",
  "workflow.write",
  "workflow.run",
  "schedule.write",
  "memory.read",
  "memory.write",
  "mail.read",
  "files.read",
] as const;
export const CapabilityGroupSchema = z.enum(CAPABILITY_GROUPS);
export type CapabilityGroup = z.infer<typeof CapabilityGroupSchema>;

export const SourceNameSchema = z.enum(["calendar", "gmail", "canvas"]);
export const WorkflowParamTypeSchema = z.enum(["string", "number", "boolean", "json"]);
export type WorkflowParamType = z.infer<typeof WorkflowParamTypeSchema>;

export function valueMatchesParamType(type: WorkflowParamType, value: unknown): boolean {
  if (type === "string") return typeof value === "string" && value.length <= 4_000;
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  try {
    const text = JSON.stringify(value);
    return text !== undefined && text.length <= 8_000;
  } catch {
    return false;
  }
}

export const WorkflowParamSchema = z
  .object({
    name: z.string().regex(PARAM_NAME_PATTERN),
    type: WorkflowParamTypeSchema,
    required: z.boolean(),
    default: z.unknown().optional(),
    description: z.string().max(200).optional(),
  })
  .superRefine((param, context) => {
    if (param.default !== undefined && !valueMatchesParamType(param.type, param.default)) {
      context.addIssue({ code: "custom", path: ["default"], message: "invalid_param_default" });
    }
  });

export const WorkflowParamsSchema = z
  .array(WorkflowParamSchema)
  .max(MAX_WORKFLOW_PARAMS)
  .superRefine((params, context) => {
    const names = new Set<string>();
    for (const [index, param] of params.entries()) {
      if (names.has(param.name)) {
        context.addIssue({ code: "custom", path: [index, "name"], message: "duplicate_param" });
      }
      names.add(param.name);
    }
  });

export const ExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }),
  z.object({
    kind: z.literal("builtin"),
    name: z.enum(["sync_sources", "briefing"]),
    accountId: z.string().optional(),
    sources: z.array(SourceNameSchema).min(1).max(3).optional(),
  }),
  z.object({
    kind: z.literal("script"),
    path: z.string().min(1).max(500),
    args: z.array(z.string().max(4_000)).max(100),
    capabilities: z.array(CapabilityGroupSchema).max(CAPABILITY_GROUPS.length).optional(),
  }),
]);

const parseable = (value: string) => !Number.isNaN(Date.parse(value));
export const TriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string().refine(parseable) }),
  z.object({
    kind: z.literal("interval"),
    everySeconds: z.number().int().min(1),
    anchorAt: z.string().refine(parseable),
  }),
  z.object({
    kind: z.literal("daily"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timeZone: z.string().min(1),
  }),
]);

export const RunSummarySchema = z.object({
  id: z.string(),
  status: z.string(),
  triggerKind: z.union([z.string(), z.null()]),
  params: z.unknown(),
  resultJson: z.union([z.string(), z.null()]),
  createdAt: z.string(),
  settledAt: z.union([z.string(), z.null()]),
});

export const ScheduleBindingSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  trigger: TriggerSchema,
  enabled: z.boolean(),
  args: z.record(z.string(), z.unknown()),
  nextRunAt: z.union([z.string(), z.null()]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ScheduleBindingViewSchema = ScheduleBindingSchema.extend({
  workflowTitle: z.string(),
  lastRun: z.union([RunSummarySchema, z.null()]),
});

export const WorkflowSchema = z.object({
  id: z.string(),
  title: z.string(),
  instruction: z.string(),
  executor: ExecutorSchema,
  params: WorkflowParamsSchema,
  timeoutSeconds: z.number().int().min(1).max(86_400),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const WorkflowViewSchema = WorkflowSchema.extend({
  schedules: z.array(ScheduleBindingSchema),
  lastRun: z.union([RunSummarySchema, z.null()]),
  score: z.number().nullish(),
});

export const WorkflowsResponseSchema = z.object({ workflows: z.array(WorkflowViewSchema) });
export const WorkflowDetailResponseSchema = z.object({
  workflow: WorkflowViewSchema,
  runs: z.array(RunSummarySchema),
});
export const WorkflowMutationResponseSchema = z.object({
  workflow: WorkflowSchema,
  rebound: z.array(z.string()),
});
export const SchedulesResponseSchema = z.object({
  schedules: z.array(ScheduleBindingViewSchema),
});
export const DeletedResponseSchema = z.object({ deleted: z.literal(true), id: z.string() });
export const DeleteWorkflowResponseSchema = DeletedResponseSchema.extend({
  removedSchedules: z.array(z.string()),
});

export const QueuedRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  createdAt: z.string(),
});
export const WorkflowRunResponseSchema = z.object({
  run: QueuedRunSchema,
  workflow: z.object({ id: z.string(), title: z.string() }),
  params: z.unknown(),
});
export const ScheduleRunResponseSchema = z.object({
  run: QueuedRunSchema,
  occurrence: z.object({ scheduledFor: z.string(), manual: z.boolean() }),
});
export const CancelRunResponseSchema = z.object({
  run: z.union([QueuedRunSchema, z.null()]),
  cancelled: z.boolean(),
});

export type Executor = z.infer<typeof ExecutorSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type SourceName = z.infer<typeof SourceNameSchema>;
export type WorkflowParam = z.infer<typeof WorkflowParamSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowView = z.infer<typeof WorkflowViewSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type QueuedRun = z.infer<typeof QueuedRunSchema>;
export type ScheduleBinding = z.infer<typeof ScheduleBindingSchema>;
export type ScheduleBindingView = z.infer<typeof ScheduleBindingViewSchema>;
