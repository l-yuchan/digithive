import { z } from "zod";

export const Health = z.object({
  ok: z.literal(true),
  schemaVersion: z.number().int().nonnegative(),
});

export const ApiError = z.object({
  error: z.string(),
});
