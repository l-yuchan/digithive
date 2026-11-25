import { z } from "zod";

export const AccountSourceSchema = z.object({
  source: z.enum(["calendar", "gmail", "canvas"]),
  enabled: z.boolean(),
  ok: z.boolean(),
  cursor: z.union([z.string(), z.null()]),
  lastSyncAt: z.union([z.string(), z.null()]),
  lastAttemptAt: z.union([z.string(), z.null()]),
  error: z.union([z.string(), z.null()]),
});

export const AccountSchema = z.object({
  id: z.string(),
  provider: z.enum(["google", "canvas"]),
  subject: z.union([z.string(), z.null()]),
  email: z.union([z.string(), z.null()]),
  label: z.string(),
  connected: z.boolean(),
  sources: z.array(AccountSourceSchema),
});

export const AccountsResponseSchema = z.object({
  accounts: z.array(AccountSchema),
  googleConfigured: z.boolean(),
  canvasConfigured: z.boolean(),
});

export type AccountSource = z.infer<typeof AccountSourceSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type AccountsResponse = z.infer<typeof AccountsResponseSchema>;

export const SOURCE_LABELS: Record<AccountSource["source"], string> = {
  calendar: "캘린더",
  gmail: "메일",
  canvas: "한양 LMS",
};

export const PROVIDER_LABELS: Record<Account["provider"], string> = {
  google: "Google",
  canvas: "한양 LMS",
};
