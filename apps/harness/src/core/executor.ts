import { z } from "zod";

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
  }),
]);
export type RunExecutor = z.infer<typeof RunExecutorSchema>;
