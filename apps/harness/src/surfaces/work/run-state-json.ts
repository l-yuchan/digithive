import type { Database } from "bun:sqlite";
import { ChatMessageSchema } from "../../core/contracts";
import type { RunRow } from "./record";
import { z } from "zod";

export const WorkStateSchema = z.object({
  messages: z.array(ChatMessageSchema),
  pending: z
    .object({ callId: z.string(), name: z.string(), arguments: z.string(), approvalId: z.string() })
    .optional(),
  remaining: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: z.string() }))
    .optional(),
  toolCallsUsed: z.number().optional(),
  roundsUsed: z.number().optional(),
});

export type WorkState = z.infer<typeof WorkStateSchema>;

export function parseState(run: RunRow): WorkState {
  if (!run.stateJson) return { messages: [{ role: "user", content: run.goal }] };
  try {
    return WorkStateSchema.parse(JSON.parse(run.stateJson));
  } catch {
    return { messages: [{ role: "user", content: run.goal }] };
  }
}

export function saveState(db: Database, run: RunRow, state: WorkState): void {
  db.query(
    "UPDATE runs SET state_json = ? WHERE id = ? AND status='running' AND lease_owner=?",
  ).run(JSON.stringify(state), run.id, run.leaseOwner);
}
