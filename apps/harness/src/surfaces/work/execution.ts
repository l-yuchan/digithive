import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../../events/log";
import { specs } from "../../tools/registry";
import { WORK_LIMITS, type WorkDeps, type RunRow } from "./runner";
import { keepLease, ownsLease } from "./lease";
import { executeTool, toolDecision } from "./tool";
import { ChatMessageSchema } from "../../core/contracts";
import { z } from "zod";

const WorkStateSchema = z.object({
  messages: z.array(ChatMessageSchema),
  pending: z.object({ callId: z.string(), name: z.string(), arguments: z.string(), approvalId: z.string() }).optional(),
  remaining: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string() })).optional(),
  toolCallsUsed: z.number().optional(), roundsUsed: z.number().optional(),
});
type WorkState = z.infer<typeof WorkStateSchema>;
const BudgetSchema = z.object({
  inputRefs: z.array(z.string()).optional(), completionCondition: z.string().optional(), permissionProfile: z.string().optional(),
  budget: z.object({ maxToolCalls: z.number(), maxMicroUsd: z.number() }).optional(), maxToolCalls: z.number().optional(),
});

function parseState(run: RunRow): WorkState {
  if (!run.stateJson) return { messages: [{ role: "user", content: run.goal }] };
  try {
    return WorkStateSchema.parse(JSON.parse(run.stateJson));
  } catch {
    return { messages: [{ role: "user", content: run.goal }] };
  }
}

function saveState(db: Database, run: RunRow, state: WorkState): void {
  db.query("UPDATE runs SET state_json = ? WHERE id = ? AND status='running' AND lease_owner=?").run(JSON.stringify(state), run.id, run.leaseOwner);
}

function settle(db: Database, events: EventLog, run: RunRow, status: "succeeded" | "failed" | "interrupted", payload: { text?: string; error?: string }, now: number): void {
  const changed = db.query("UPDATE runs SET status = ?, lease_owner = NULL, lease_expires_at = NULL, settled_at = ?, result_json = ? WHERE id = ? AND status = 'running' AND lease_owner = ?").run(
    status,
    new Date(now).toISOString(),
    JSON.stringify(payload),
    run.id,
    run.leaseOwner,
  );
  if (changed.changes === 0) return;
  events.append({
    kind: status === "succeeded" ? "run.settled" : status === "failed" ? "run.failed" : "run.interrupted",
    runId: run.id,
    sessionId: run.sessionId,
    payload,
    now,
  });
  if (run.parentRunId) {
    events.append({
      kind: "run.progress",
      runId: run.parentRunId,
      sessionId: run.sessionId,
      payload: { childRunId: run.id, status, summary: (payload["text"] ?? payload["error"] ?? "").slice(0, 200) },
      now,
    });
  }
}

/**
 * Runs one claimed run to completion, or pauses it at the first tool call that
 * needs a human decision. The pause persists the whole conversation state, so
 * resuming after a decision never replays finished work.
 */
export async function executeRun(deps: WorkDeps, run: RunRow): Promise<"succeeded" | "paused" | "failed" | "interrupted"> {
  const now = () => (deps.now ?? Date.now)();
  const limits = deps.limits ?? WORK_LIMITS;
  const state = parseState(run);
  const lease = keepLease(deps.db, deps.events, run, deps.leaseMs ?? 45_000, limits.totalMs, now);
  const contract = BudgetSchema.parse(JSON.parse(run.budgetJson));
  if (state.messages.length === 1 && contract.completionCondition) {
    state.messages.unshift({ role: "system", content: `Input references: ${JSON.stringify(contract.inputRefs)}\nCompletion condition: ${contract.completionCondition}\nPermission profile: ${contract.permissionProfile}` });
  }
  const maxToolCalls = contract.budget?.maxToolCalls ?? contract.maxToolCalls ?? Infinity;
  const assertActive = () => {
    if (lease.signal.aborted) throw lease.signal.reason;
    if (!ownsLease(deps.db, run.id, run.leaseOwner, now())) throw new Error("lease_lost");
  };
  const consumeTool = () => {
    assertActive();
    if ((state.toolCallsUsed ?? 0) >= maxToolCalls) throw new Error("tool_budget_exceeded");
    state.toolCallsUsed = (state.toolCallsUsed ?? 0) + 1;
    saveState(deps.db, run, state);
  };
  let text = "";

  try {
    if (state.pending) {
      assertActive();
      const approval = deps.db.query<{ status: string }, SQLQueryBindings[]>("SELECT status FROM approvals WHERE id = ?").get(state.pending.approvalId);
      const call = { id: state.pending.callId, name: state.pending.name, arguments: state.pending.arguments };
      const permitted = toolDecision(deps, call, contract.permissionProfile) !== "deny";
      if (approval?.status === "approved" && permitted) {
        consumeTool();
        const result = await executeTool(deps, run, call, lease.signal);
        state.messages.push({ role: "tool", content: result.output, toolCallId: call.id });
        deps.events.append({ kind: "tool.result", runId: run.id, payload: { id: call.id, name: call.name, output: result.output }, now: now() });
      } else {
        const output = approval?.status === "rejected" ? "사용자가 이 호출을 거부했습니다." : "승인이 만료되어 실행하지 않았습니다.";
        state.messages.push({ role: "tool", content: output, toolCallId: call.id });
        deps.events.append({ kind: "tool.denied", runId: run.id, payload: { id: call.id, name: call.name, reason: approval?.status ?? "expired" }, now: now() });
      }
      delete state.pending;
      saveState(deps.db, run, state);
    }

    for (let round = 0; round < limits.maxToolRounds; round += 1) {
      assertActive();
      const pending: { id: string; name: string; arguments: string }[] = state.remaining ?? [];
      delete state.remaining;
      if (pending.length === 0) {
        if ((state.roundsUsed ?? 0) >= limits.maxToolRounds) throw new Error("tool_round_limit");
        state.roundsUsed = (state.roundsUsed ?? 0) + 1;
        for await (const event of deps.stream(state.messages, specs(deps.tools), {
        maxOutputTokens: limits.maxOutputTokens,
        firstTokenTimeoutMs: limits.firstTokenMs,
        idleTimeoutMs: limits.idleMs,
        signal: lease.signal,
        })) {
        const typed = event;
        if (typed.type === "text_delta") {
          text += typed.text;
          deps.events.append({ kind: "message.delta", runId: run.id, sessionId: run.sessionId, payload: { text: typed.text }, now: now() });
        } else if (typed.type === "tool_call") {
          pending.push({ id: typed.id, name: typed.name, arguments: typed.arguments });
        }
        }
        if (pending.length > 0) state.messages.push({ role: "assistant", content: text, toolCalls: pending });
      }
      if (pending.length === 0) break;

      let paused = false;
      for (const [index, call] of pending.entries()) {
        assertActive();
        const decision = toolDecision(deps, call, contract.permissionProfile);
        if (decision === "ask") {
          const approvalId = crypto.randomUUID();
          deps.db
            .query(
              "INSERT OR REPLACE INTO tool_calls (id, run_id, name, arguments_json, decision, decision_by, status, started_at) VALUES (?,?,?,?,?,?,?,?)",
            )
            .run(`${run.id}:${call.id}`, run.id, call.name, call.arguments, "ask", "policy", "pending", new Date(now()).toISOString());
          deps.db
            .query("INSERT INTO approvals (id, run_id, tool_call_id, status, requested_at) VALUES (?,?,?,?,?)")
            .run(approvalId, run.id, `${run.id}:${call.id}`, "pending", new Date(now()).toISOString());
          state.pending = { callId: call.id, name: call.name, arguments: call.arguments, approvalId };
          state.remaining = pending.slice(index + 1);
          saveState(deps.db, run, state);
          deps.db.query("UPDATE runs SET status = 'awaiting_approval', lease_owner = NULL, lease_expires_at = NULL WHERE id = ?").run(run.id);
          deps.events.append({
            kind: "approval.requested",
            runId: run.id,
            sessionId: run.sessionId,
            payload: { approvalId, callId: call.id, name: call.name, arguments: call.arguments },
            now: now(),
          });
          paused = true;
          break;
        }
        if (decision === "deny") {
          const output = "정책이 이 호출을 거부했습니다.";
          state.messages.push({ role: "tool", content: output, toolCallId: call.id });
          deps.events.append({ kind: "tool.denied", runId: run.id, payload: { id: call.id, name: call.name }, now: now() });
          continue;
        }
        consumeTool();
        const result = await executeTool(deps, run, call, lease.signal);
        state.messages.push({ role: "tool", content: result.output, toolCallId: call.id });
        if (!result.timeout) deps.events.append({ kind: "tool.result", runId: run.id, payload: { id: call.id, name: call.name, output: result.output }, now: now() });
        else deps.events.append({ kind: "tool.timeout", runId: run.id, payload: { id: call.id, name: call.name }, now: now() });
      }
      if (paused) return "paused";
      if (round === limits.maxToolRounds - 1) throw new Error("tool_round_limit");
    }

    assertActive();
    saveState(deps.db, run, state);
    settle(deps.db, deps.events, run, "succeeded", { text }, now());
    return "succeeded";
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    saveState(deps.db, run, state);
    const interrupted = lease.signal.aborted || message === "lease_lost";
    if (lease.signal.aborted && ownsLease(deps.db, run.id, run.leaseOwner, now())) {
      deps.db.query("UPDATE runs SET cancel_intent='timeout' WHERE id=?").run(run.id);
    }
    settle(deps.db, deps.events, run, interrupted ? "interrupted" : "failed", { error: message }, now());
    return interrupted ? "interrupted" : "failed";
  } finally {
    lease.close();
  }
}
