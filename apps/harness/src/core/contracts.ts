import { z } from "zod";

/**
 * One conversation event. Thinking, each tool call, each tool result and each text
 * paragraph are separate events, so a turn reads as a list rather than one blob.
 *
 * `id` is the event's position inside its turn, not the tool call it belongs to:
 * the view and the edit path address events by that number, and the two events of
 * one call (the call and its result) must stay distinct. `callId` is what pairs a
 * result with the call it answers.
 */
export const EventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thinking"), id: z.number().int(), text: z.string() }),
  z.object({ type: z.literal("text"), id: z.number().int(), text: z.string() }),
  z.object({
    type: z.literal("tool_call"),
    id: z.number().int(),
    callId: z.string(),
    name: z.string(),
    detail: z.string(),
  }),
  z.object({
    type: z.literal("tool_result"),
    id: z.number().int(),
    callId: z.string(),
    name: z.string(),
    detail: z.string(),
    failed: z.boolean().optional(),
  }),
  z.object({ type: z.literal("error"), id: z.number().int(), detail: z.string() }),
]);
export type ConversationEvent = z.infer<typeof EventSchema>;

export function conversationText(events: readonly ConversationEvent[]): string {
  return events
    .filter((event): event is Extract<ConversationEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.text)
    .join("");
}

/** A part as records written before v11 stored it; converted on the way out. */
const LegacyPartSchema = z.discriminatedUnion("type", [
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

function eventsFromParts(payload: unknown): ConversationEvent[] {
  const parts = z.object({ parts: z.array(LegacyPartSchema) }).safeParse(payload);
  if (!parts.success) return [];
  return parts.data.parts.map((part, index): ConversationEvent => {
    switch (part.type) {
      case "text":
        return { type: "text", id: index, text: part.text };
      case "reasoning":
        return { type: "thinking", id: index, text: part.text };
      case "tool_call":
        return {
          type: "tool_call",
          id: index,
          callId: part.id,
          name: part.name,
          detail: part.arguments,
        };
      case "tool_result":
        return {
          type: "tool_result",
          id: index,
          callId: part.id,
          name: part.name,
          detail: part.output,
          ...(part.denied || part.timeout ? { failed: true } : {}),
        };
      case "error":
        return { type: "error", id: index, detail: part.message };
      default: {
        const unexpected: never = part;
        throw new Error(`Unknown stored part: ${JSON.stringify(unexpected)}`);
      }
    }
  });
}

/**
 * Reads a stored entry payload. A record written before events existed carries
 * `parts`; it is converted here so every reader sees one shape.
 */
export function parseEntryEvents(payloadJson: string): ConversationEvent[] {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  const events = z.object({ events: z.array(EventSchema) }).safeParse(payload);
  if (events.success) return events.data.events;
  return eventsFromParts(payload);
}

export const SessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  /* Who named it: still the default, named by the app, or named by the owner. */
  titleSource: z.enum(["initial", "auto", "user"]).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const EntrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.string(),
  role: z.string().nullable(),
  status: z.string().nullable(),
  events: z.array(EventSchema),
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
