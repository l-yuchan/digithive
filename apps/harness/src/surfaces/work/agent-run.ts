import type { SQLQueryBindings } from "bun:sqlite";
import { specs } from "../../tools/registry";
import { buildContext } from "../../core/context";
import type { WorkDeps } from "./runner";
import type { RunRow } from "./record";
import type { keepLease } from "./lease";
import { ownsLease } from "./lease";
import { executeTool, toolDecision } from "./tool";
import { parseState, saveState } from "./run-state-json";
import { runStream } from "./stream-diagnostics";
import { ProviderError } from "../../providers/errors";
import { abortMessage, dbCancelled, settle, type RunOutcome } from "./settle";
import { z } from "zod";

type Lease = ReturnType<typeof keepLease>;

const BudgetSchema = z.object({
  inputRefs: z.array(z.string()).optional(),
  completionCondition: z.string().optional(),
  permissionProfile: z.string().optional(),
  budget: z.object({ maxToolCalls: z.number(), maxMicroUsd: z.number() }).optional(),
  maxToolCalls: z.number().optional(),
});

function cancelledOutcome(
  deps: WorkDeps,
  run: RunRow,
  lease: Lease,
  now: number,
): RunOutcome | null {
  const reason = abortMessage(lease.signal);
  if (reason !== "run_cancelled" && !dbCancelled(deps.db, run.id)) return null;
  settle(deps.db, deps.events, run, "cancelled", { error: "cancelled" }, now);
  return "cancelled";
}

/**
 * Agent path: stream the model, pause at approvals, and resume from persisted
 * state without replaying finished work.
 */
export async function executeAgent(
  deps: WorkDeps,
  run: RunRow,
  lease: Lease,
  now: () => number,
  limits: NonNullable<WorkDeps["limits"]>,
): Promise<RunOutcome> {
  const state = parseState(run);
  const contract = BudgetSchema.parse(JSON.parse(run.budgetJson));
  // The context producer is shared with conversations: fresh clock, language,
  // policy and the actual tool list on every start and approval resume.
  const history = state.messages.filter((message) => message.role !== "system");
  const built = buildContext({
    now: now(),
    history: [],
    tools: specs(deps.tools).map((tool) => ({ name: tool.name, description: tool.description })),
  });
  let system = built.system;
  if (contract.completionCondition) {
    system += `\n\nInput references: ${JSON.stringify(contract.inputRefs)}\nCompletion condition: ${contract.completionCondition}\nPermission profile: ${contract.permissionProfile}`;
  }
  state.messages = [{ role: "system", content: system }, ...history];
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
      const approval = deps.db
        .query<{ status: string }, SQLQueryBindings[]>("SELECT status FROM approvals WHERE id = ?")
        .get(state.pending.approvalId);
      const call = {
        id: state.pending.callId,
        name: state.pending.name,
        arguments: state.pending.arguments,
      };
      const permitted = toolDecision(deps, call, contract.permissionProfile) !== "deny";
      if (approval?.status === "approved" && permitted) {
        consumeTool();
        const result = await executeTool(deps, run, call, lease.signal);
        state.messages.push({ role: "tool", content: result.output, toolCallId: call.id });
        deps.events.append({
          kind: "tool.result",
          runId: run.id,
          payload: { id: call.id, name: call.name, output: result.output },
          now: now(),
        });
      } else {
        const output =
          approval?.status === "rejected"
            ? "사용자가 이 호출을 거부했습니다."
            : "승인이 만료되어 실행하지 않았습니다.";
        state.messages.push({ role: "tool", content: output, toolCallId: call.id });
        deps.events.append({
          kind: "tool.denied",
          runId: run.id,
          payload: { id: call.id, name: call.name, reason: approval?.status ?? "expired" },
          now: now(),
        });
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
        for await (const typed of runStream(
          deps,
          run,
          state.messages,
          specs(deps.tools),
          {
            maxOutputTokens: limits.maxOutputTokens,
            firstTokenTimeoutMs: limits.firstTokenMs,
            idleTimeoutMs: limits.idleMs,
            signal: lease.signal,
            contextKey: `run:${run.id}`,
          },
          now,
        )) {
          if (typed.type === "text_delta") {
            text += typed.text;
            deps.events.append({
              kind: "message.delta",
              runId: run.id,
              sessionId: run.sessionId,
              payload: { text: typed.text },
              now: now(),
            });
          } else if (typed.type === "tool_call") {
            pending.push({ id: typed.id, name: typed.name, arguments: typed.arguments });
          }
        }
        if (pending.length > 0)
          state.messages.push({ role: "assistant", content: text, toolCalls: pending });
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
            .run(
              `${run.id}:${call.id}`,
              run.id,
              call.name,
              call.arguments,
              "ask",
              "policy",
              "pending",
              new Date(now()).toISOString(),
            );
          deps.db
            .query(
              "INSERT INTO approvals (id, run_id, tool_call_id, status, requested_at) VALUES (?,?,?,?,?)",
            )
            .run(
              approvalId,
              run.id,
              `${run.id}:${call.id}`,
              "pending",
              new Date(now()).toISOString(),
            );
          state.pending = {
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
            approvalId,
          };
          state.remaining = pending.slice(index + 1);
          saveState(deps.db, run, state);
          deps.db
            .query(
              "UPDATE runs SET status = 'awaiting_approval', lease_owner = NULL, lease_expires_at = NULL WHERE id = ?",
            )
            .run(run.id);
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
          deps.events.append({
            kind: "tool.denied",
            runId: run.id,
            payload: { id: call.id, name: call.name },
            now: now(),
          });
          continue;
        }
        consumeTool();
        const result = await executeTool(deps, run, call, lease.signal);
        state.messages.push({ role: "tool", content: result.output, toolCallId: call.id });
        if (!result.timeout)
          deps.events.append({
            kind: "tool.result",
            runId: run.id,
            payload: { id: call.id, name: call.name, output: result.output },
            now: now(),
          });
        else
          deps.events.append({
            kind: "tool.timeout",
            runId: run.id,
            payload: { id: call.id, name: call.name },
            now: now(),
          });
      }
      if (paused) return "paused";
      if (round === limits.maxToolRounds - 1) throw new Error("tool_round_limit");
    }

    assertActive();
    saveState(deps.db, run, state);
    settle(deps.db, deps.events, run, "succeeded", { text }, now());
    return "succeeded";
  } catch (error) {
    // The provider's own words (status, upstream message) are the owner's diagnostic.
    const message = error instanceof Error ? error.message : String(error);
    const detail = error instanceof ProviderError ? error.body : undefined;
    saveState(deps.db, run, state);
    const cancelled = cancelledOutcome(deps, run, lease, now());
    if (cancelled) return cancelled;
    const interrupted = lease.signal.aborted || message === "lease_lost";
    if (lease.signal.aborted && ownsLease(deps.db, run.id, run.leaseOwner, now())) {
      const reason = abortMessage(lease.signal) ?? message;
      deps.db
        .query("UPDATE runs SET cancel_intent=? WHERE id=?")
        .run(reason === "host_restart" ? "host_restart" : "timeout", run.id);
    }
    settle(
      deps.db,
      deps.events,
      run,
      interrupted ? "interrupted" : "failed",
      { error: message },
      now(),
      detail,
    );
    return interrupted ? "interrupted" : "failed";
  }
}
