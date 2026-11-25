import { z } from "zod";

/** Execution mechanism only; instructions, deadline and state belong to the run. */
export const RunExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }),
  z.object({
    kind: z.literal("builtin"),
    name: z.enum(["sync_sources", "briefing"]),
    accountId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("script"),
    path: z.string().min(1).max(500),
    args: z.array(z.string().max(4000)).max(100).default([]),
  }),
]);
export type RunExecutor = z.infer<typeof RunExecutorSchema>;
