import { z } from "zod";

export const PartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({
    type: z.literal("tool_call"),
    id: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
  z.object({
    type: z.literal("tool_result"),
    id: z.string(),
    name: z.string(),
    output: z.string(),
    denied: z.boolean().optional(),
    timeout: z.boolean().optional(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export const SessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const EntrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.string(),
  role: z.string().nullable(),
  status: z.string().nullable(),
  parts: z.array(PartSchema),
  createdAt: z.string(),
  seq: z.number(),
  siblingCount: z.number().optional(),
  siblingIndex: z.number().optional(),
  siblingIds: z.array(z.string()).optional(),
});
export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCallId: z.string().optional(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: z.string() }))
    .optional(),
});
