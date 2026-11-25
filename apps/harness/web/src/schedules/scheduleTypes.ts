import { z } from "zod";

export const TriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string().min(1) }),
  z.object({
    kind: z.literal("interval"),
    everySeconds: z.number().int().min(1),
    anchorAt: z.string().min(1),
  }),
  z.object({
    kind: z.literal("daily"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timeZone: z.string().min(1),
  }),
]);

export const ExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }),
  z.object({
    kind: z.literal("builtin"),
    name: z.enum(["sync_sources", "briefing"]),
    accountId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("script"),
    path: z.string().min(1).max(500),
    args: z.array(z.string().max(4000)).max(100),
  }),
]);

const LastRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  resultJson: z.union([z.string(), z.null()]),
  settledAt: z.union([z.string(), z.null()]),
});

export const ScheduleSchema = z.object({
  id: z.string(),
  title: z.string(),
  instruction: z.string(),
  enabled: z.boolean(),
  trigger: TriggerSchema,
  executor: ExecutorSchema,
  timeoutSeconds: z.number().int().min(1).max(86400),
  nextRunAt: z.union([z.string(), z.null()]),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRun: z.union([LastRunSchema, z.null()]),
});

export const ScheduleRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  goal: z.string(),
  resultJson: z.union([z.string(), z.null()]),
  settledAt: z.union([z.string(), z.null()]),
  pendingApprovalId: z.union([z.string(), z.null()]).optional(),
  pendingTool: z.union([z.string(), z.null()]).optional(),
  scheduledFor: z.union([z.string(), z.null()]).optional(),
  manual: z.boolean().optional(),
  createdAt: z.string().optional(),
});

export const ScheduleInputSchema = z.object({
  title: z.string().min(1),
  instruction: z.string().min(1),
  enabled: z.boolean(),
  trigger: TriggerSchema,
  executor: ExecutorSchema,
  timeoutSeconds: z.number().int().min(1).max(86400),
});

export type Trigger = z.infer<typeof TriggerSchema>;
export type Executor = z.infer<typeof ExecutorSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type ScheduleRun = z.infer<typeof ScheduleRunSchema>;
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;
