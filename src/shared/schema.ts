import { z } from "zod";
import type { EntryKind } from "./types";

const id = z.string();
const isoDateTime = z.string();
const nullableText = z.string().nullable();
const preference = z.enum(["never", "digest_only", "when_strong", "immediate"]);
const context = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interest"), why_it_matters: nullableText, known_obstacle: nullableText, interruption: preference }),
  z.object({ kind: z.literal("fact"), decided_at: isoDateTime.nullable() }),
  z.object({ kind: z.literal("hypothesis"), falsifier: nullableText }),
  z.object({ kind: z.literal("commitment"), due_at: isoDateTime.nullable(), scheduled_start: isoDateTime.nullable(), scheduled_end: isoDateTime.nullable(), reschedule_allowed: z.boolean() }),
  z.object({ kind: z.literal("delegation"), scope: z.string(), max_steps: z.number().int().min(1).max(10), local_only: z.literal(true) }),
]);
const kinds = ["interest", "fact", "hypothesis", "commitment", "delegation"] as const satisfies readonly EntryKind[];

export const createEntryRequestSchema = z.object({
  kind: z.enum(kinds), text: z.string(), context,
  source_ids: z.array(id).optional(), scope: z.string().optional(),
}).refine((value) => value.context.kind === value.kind, {
  message: "context kind must match entry kind", path: ["context", "kind"],
});
export const updateEntryRequestSchema = z.object({
  text: z.string().optional(), correction_note: z.string().optional(),
  context: z.object({}).catchall(z.unknown()).optional(),
});
export const withdrawRequestSchema = z.object({ reason: z.string().optional(), stop_preparation: z.boolean().optional() });
export const cancelScheduleRequestSchema = z.object({ reason: z.string(), reschedule_allowed: z.literal(false).optional() });
export const promoteRequestSchema = z.object({
  to: z.enum(["commitment", "delegation"]), text: z.string().optional(),
  due_at: isoDateTime.nullable().optional(), scope: z.string().optional(),
  max_steps: z.number().int().min(1).max(10).optional(),
}).refine((value) => value.to !== "delegation" || (value.scope?.length ?? 0) > 0, {
  message: "scope is required for delegation", path: ["scope"],
});
export const createSourceRequestSchema = z.object({
  title: z.string(), url: z.string().nullable().optional(), publisher: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(), evidence_summary: z.string(),
});
export const updateSourceRequestSchema = createSourceRequestSchema.partial();
export const createDevelopmentRequestSchema = z.object({
  source_id: id, occurred_at: isoDateTime, summary: z.string(), content: z.string().nullable().optional(),
  time_sensitivity: z.enum(["none", "time_sensitive"]).optional(), deadline: isoDateTime.nullable().optional(),
  addresses_obstacle_entry_ids: z.array(id).optional(),
});
export const updateDevelopmentRequestSchema = createDevelopmentRequestSchema.omit({ source_id: true }).partial();
export const createPreferenceRequestSchema = z.object({
  key: z.enum(["report_style", "interruption", "delivery", "proactivity"]),
  scope: z.string().optional(), value: z.string(),
});
export const updatePreferenceRequestSchema = createPreferenceRequestSchema.partial().extend({
  status: z.enum(["active", "withdrawn"]).optional(),
});
export const suggestionResponseRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), note: z.string().optional(), promote_to: z.object({ kind: z.enum(["commitment", "delegation"]), text: z.string().optional(), due_at: isoDateTime.nullable().optional(), scope: z.string().optional(), max_steps: z.number().int().min(1).max(10).optional() }).optional() }),
  z.object({ action: z.literal("dismiss"), reason: z.string().optional() }),
  z.object({ action: z.literal("defer"), defer_until: isoDateTime }),
  z.object({ action: z.literal("correct"), correction: updateEntryRequestSchema }),
  z.object({ action: z.literal("explore"), request: z.string(), max_steps: z.number().int().min(1).max(10).optional() }),
]);
export const createPreparationRequestSchema = z.object({
  request: z.string(), delegation_id: id.nullable().optional(), suggestion_id: id.nullable().optional(),
  scope: z.string(), max_steps: z.number().int().min(1).max(10).optional(), local_only: z.literal(true),
});
const calendarColors = ["accent", "info", "amber", "danger", "neutral"] as const;
export const createCalendarRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().min(1).max(2048),
  color: z.enum(calendarColors).optional(),
  enabled: z.boolean().optional(),
});
export const updateCalendarRequestSchema = createCalendarRequestSchema.partial();
export const deleteAllRequestSchema = z.object({ confirm: z.literal("DELETE_ALL") });
