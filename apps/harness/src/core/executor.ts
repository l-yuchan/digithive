import { z } from "zod";

/**
 * What a script run may reach through the SDK bridge. The list lives with the
 * executor because it is a property of the run, not of the definition row: the
 * bridge reads it straight from `runs.executor_json`.
 */
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

/** A data source a collection run may read. */
export const SourceNameSchema = z.enum(["calendar", "gmail", "canvas"]);
export type ExecutorSource = z.infer<typeof SourceNameSchema>;

/** Execution mechanism only; instructions, deadline and state belong to the run. */
export const RunExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }),
  z.object({
    kind: z.literal("builtin"),
    name: z.enum(["sync_sources", "briefing"]),
    accountId: z.string().optional(),
    /**
     * Collection only: the account and the sources it reads. Collection is an
     * ordinary schedule, so what it reads is written down here rather than
     * triggered by connecting an account.
     */
    sources: z.array(SourceNameSchema).min(1).max(3).optional(),
  }),
  z.object({
    kind: z.literal("script"),
    path: z.string().min(1).max(500),
    args: z.array(z.string().max(4000)).max(100).default([]),
    /** Read-only by default; write and run groups are granted in the form. */
    capabilities: z.array(CapabilityGroupSchema).max(CAPABILITY_GROUPS.length).optional(),
  }),
]);
export type RunExecutor = z.infer<typeof RunExecutorSchema>;
