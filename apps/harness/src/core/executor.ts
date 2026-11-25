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
  "mail.send",
  "account.read",
  "files.read",
] as const;

export const CapabilityGroupSchema = z.enum(CAPABILITY_GROUPS);
export type CapabilityGroup = z.infer<typeof CapabilityGroupSchema>;

/** A data source one account keeps. A job reads only the ones the owner left on. */
export const SourceNameSchema = z.enum(["calendar", "gmail", "canvas"]);
export type ExecutorSource = z.infer<typeof SourceNameSchema>;

/**
 * Execution mechanism only; instructions, deadline and state belong to the run.
 *
 * There are two kinds on purpose: the model, and a script file. The collection and
 * briefing jobs the app ships are ordinary scripts whose path happens to point at
 * `jobs/`, so a job is not a special kind of workflow — only its path is unusual.
 */
export const RunExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }),
  z.object({
    kind: z.literal("script"),
    path: z.string().min(1).max(500),
    args: z.array(z.string().max(4000)).max(100).default([]),
    /** Read-only by default; write and run groups are granted in the form. */
    capabilities: z.array(CapabilityGroupSchema).max(CAPABILITY_GROUPS.length).optional(),
  }),
]);
export type RunExecutor = z.infer<typeof RunExecutorSchema>;
