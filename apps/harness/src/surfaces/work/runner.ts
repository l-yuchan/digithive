import type { Database } from "bun:sqlite";
import type { EventLog } from "../../events/log";
import { decide, type PolicyRule } from "../../core/policy";
import { isLeaseExpired, leaseExpiry } from "../../core/run-state";
import { specs, type ToolRegistry } from "../../tools/registry";
import type { AdapterEvent, ChatMessage, StreamFn } from "../../providers/openai";

export type WorkDeps = {
  readonly db: Database;
  readonly events: EventLog;
  readonly stream: StreamFn;
  readonly tools: ToolRegistry;
  readonly policy: readonly PolicyRule[];
  readonly now?: () => number;
  readonly limits?: { readonly firstTokenMs: number; readonly idleMs: number; readonly toolMs: number; readonly maxOutputTokens: number; readonly maxToolRounds: number; readonly totalMs: number };
  readonly maxConcurrent?: number;
  readonly leaseMs?: number;
};

export const WORK_LIMITS = {
  firstTokenMs: 60_000,
  idleMs: 120_000,
  toolMs: 30_000,
  maxOutputTokens: 2_048,
  maxToolRounds: 6,
  totalMs: 30 * 60_000,
};

export type RunRow = {
  id: string;
  sessionId: string | null;
  parentRunId: string | null;
  origin: string;
  goal: string;
  status: string;
  cancelIntent: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attempt: number;
  budgetJson: string;
  resultJson: string | null;
  stateJson: string | null;
  createdAt: string;
  settledAt: string | null;
};

type WorkState = {
  messages: ChatMessage[];
  pending?: { callId: string; name: string; arguments: string; approvalId: string };
};

const RunShape = (row: Record<string, unknown>): RunRow => ({
  id: String(row["id"]),
  sessionId: row["session_id"] === null ? null : String(row["session_id"]),
  parentRunId: row["parent_run_id"] === null ? null : String(row["parent_run_id"]),
  origin: String(row["origin"]),
  goal: String(row["goal"]),
  status: String(row["status"]),
  cancelIntent: row["cancel_intent"] === null ? null : String(row["cancel_intent"]),
  leaseOwner: row["lease_owner"] === null ? null : String(row["lease_owner"]),
  leaseExpiresAt: row["lease_expires_at"] === null ? null : String(row["lease_expires_at"]),
  attempt: Number(row["attempt"]),
  budgetJson: String(row["budget_json"]),
  resultJson: row["result_json"] === null ? null : String(row["result_json"]),
  stateJson: row["state_json"] === null ? null : String(row["state_json"]),
  createdAt: String(row["created_at"]),
  settledAt: row["settled_at"] === null ? null : String(row["settled_at"]),
});

const SELECT = "SELECT id, session_id, parent_run_id, origin, goal, status, cancel_intent, lease_owner, lease_expires_at, attempt, budget_json, result_json, state_json, created_at, settled_at FROM runs";

export function getRun(db: Database, id: string): RunRow | null {
  const row = db.query(`${SELECT} WHERE id = ?`).get(id);
  return row ? RunShape(row as Record<string, unknown>) : null;
}

export function listRuns(db: Database, limit = 30): RunRow[] {
  return (db.query(`${SELECT} ORDER BY created_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[]).map(RunShape);
}

export type RunView = RunRow & {
  readonly pendingApprovalId: string | null;
  readonly pendingTool: string | null;
};

/** Run rows plus the pending approval the UI must render, if any. */
export function withApprovals(db: Database, runs: readonly RunRow[]): RunView[] {
  return runs.map((run) => {
    const row = db
      .query("SELECT a.id AS id, t.name AS name FROM approvals a LEFT JOIN tool_calls t ON t.id = a.tool_call_id WHERE a.run_id = ? AND a.status = 'pending' ORDER BY a.requested_at DESC LIMIT 1")
      .get(run.id) as { id: string; name: string | null } | null;
    return { ...run, pendingApprovalId: row?.id ?? null, pendingTool: row?.name ?? null };
  });
}

export type DelegateFields = {
  readonly goal: string;
  readonly inputRefs: readonly string[];
  readonly permissionProfile: string;
  readonly budget: { readonly maxMicroUsd: number; readonly maxToolCalls: number };
  readonly completionCondition: string;
};

/**
 * The five-field contract from the plan: a delegated run without a completion
 * condition, permission profile, input refs, or budget is rejected outright.
 */
export function validateDelegation(fields: Partial<DelegateFields>): string[] {
  const missing: string[] = [];
  if (!fields.goal || fields.goal.trim().length === 0) missing.push("goal");
  if (!fields.inputRefs || fields.inputRefs.length === 0) missing.push("inputRefs");
  if (!fields.permissionProfile || fields.permissionProfile.trim().length === 0) missing.push("permissionProfile");
  if (!fields.budget || typeof fields.budget.maxMicroUsd !== "number" || typeof fields.budget.maxToolCalls !== "number") missing.push("budget");
  if (!fields.completionCondition || fields.completionCondition.trim().length === 0) missing.push("completionCondition");
  return missing;
}

export function enqueueRun(
  db: Database,
  events: EventLog,
  input: {
    readonly goal: string;
    readonly origin?: "work" | "delegation";
    readonly sessionId?: string | null;
    readonly parentRunId?: string | null;
    readonly budget?: unknown;
    readonly now?: number;
  },
): RunRow {
  const now = input.now ?? Date.now();
  const id = crypto.randomUUID();
  const iso = new Date(now).toISOString();
  db.query(
    `INSERT INTO runs (id, session_id, parent_run_id, origin, goal, status, budget_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(
    id,
    input.sessionId ?? null,
    input.parentRunId ?? null,
    input.origin ?? "work",
    input.goal.slice(0, 4_096),
    JSON.stringify(input.budget ?? {}),
    iso,
  );
  events.append({
    kind: "run.queued",
    runId: id,
    sessionId: input.sessionId ?? null,
    payload: { goal: input.goal, origin: input.origin ?? "work", parentRunId: input.parentRunId ?? null },
    now,
  });
  const run = getRun(db, id);
  if (!run) throw new Error("run_not_created");
  return run;
}

/** Claims the oldest queued run under the concurrency cap, with a lease. */
export function claimNext(db: Database, events: EventLog, owner: string, maxConcurrent = 2, now = Date.now(), leaseMs = 45_000): RunRow | null {
  const running = db.query("SELECT count(*) AS n FROM runs WHERE origin IN ('work','delegation') AND status = 'running'").get() as { n: number };
  if (running.n >= maxConcurrent) return null;
  const candidate = db
    .query("SELECT id FROM runs WHERE status = 'queued' AND origin IN ('work','delegation') ORDER BY created_at LIMIT 1")
    .get() as { id: string } | null;
  if (!candidate) return null;
  const changed = db
    .query("UPDATE runs SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempt = attempt + 1 WHERE id = ? AND status = 'queued'")
    .run(owner, leaseExpiry(now, leaseMs), candidate.id);
  if (changed.changes === 0) return null;
  events.append({ kind: "run.started", runId: candidate.id, payload: { owner }, now });
  return getRun(db, candidate.id);
}

function parseState(run: RunRow): WorkState {
  if (!run.stateJson) return { messages: [{ role: "user", content: run.goal }] };
  try {
    const parsed = JSON.parse(run.stateJson) as WorkState;
    if (!Array.isArray(parsed.messages)) return { messages: [{ role: "user", content: run.goal }] };
    return parsed;
  } catch {
    return { messages: [{ role: "user", content: run.goal }] };
  }
}

function saveState(db: Database, runId: string, state: WorkState): void {
  db.query("UPDATE runs SET state_json = ? WHERE id = ?").run(JSON.stringify(state), runId);
}

function settle(db: Database, events: EventLog, run: RunRow, status: "succeeded" | "failed" | "interrupted", payload: Record<string, unknown>, now: number): void {
  db.query("UPDATE runs SET status = ?, lease_owner = NULL, lease_expires_at = NULL, settled_at = ?, result_json = ? WHERE id = ?").run(
    status,
    new Date(now).toISOString(),
    JSON.stringify(payload),
    run.id,
  );
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
      payload: { childRunId: run.id, status, summary: String(payload["text"] ?? payload["error"] ?? "").slice(0, 200) },
      now,
    });
  }
}

async function executeTool(
  deps: WorkDeps,
  run: RunRow,
  call: { id: string; name: string; arguments: string },
): Promise<{ output: string; denied?: boolean; timeout?: boolean }> {
  const tool = deps.tools.get(call.name);
  const limits = deps.limits ?? WORK_LIMITS;
  if (!tool) return { output: `알 수 없는 도구입니다: ${call.name}`, denied: true };
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(call.arguments || "{}");
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    args = {};
  }
  const started = Date.now();
  deps.db
    .query("INSERT OR REPLACE INTO tool_calls (id, run_id, name, arguments_json, decision, status, started_at, deadline_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(call.id, run.id, call.name, call.arguments, "allow", "running", new Date(started).toISOString(), new Date(started + limits.toolMs).toISOString());
  let output: string;
  let timedOut = false;
  try {
    output = await Promise.race([
      tool.execute(args, { runId: run.id }),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("__tool_timeout__"), limits.toolMs);
      }),
    ]);
    timedOut = output === "__tool_timeout__";
  } catch (error) {
    output = `도구 실행 실패: ${error instanceof Error ? error.message : "unknown"}`;
  }
  const status = timedOut ? "timeout" : "succeeded";
  deps.db.query("UPDATE tool_calls SET status = ?, ended_at = ? WHERE id = ?").run(status, new Date().toISOString(), call.id);
  if (timedOut) return { output: "도구 실행 시간이 초과되었습니다.", timeout: true };
  return { output };
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
  let text = "";

  try {
    if (state.pending) {
      const approval = deps.db.query("SELECT status FROM approvals WHERE id = ?").get(state.pending.approvalId) as { status: string } | null;
      const call = { id: state.pending.callId, name: state.pending.name, arguments: state.pending.arguments };
      if (approval?.status === "approved") {
        const result = await executeTool(deps, run, call);
        state.messages.push({ role: "tool", content: result.output, toolCallId: call.id });
        deps.events.append({ kind: "tool.result", runId: run.id, payload: { id: call.id, name: call.name, output: result.output }, now: now() });
      } else {
        const output = approval?.status === "rejected" ? "사용자가 이 호출을 거부했습니다." : "승인이 만료되어 실행하지 않았습니다.";
        state.messages.push({ role: "tool", content: output, toolCallId: call.id });
        deps.events.append({ kind: "tool.denied", runId: run.id, payload: { id: call.id, name: call.name, reason: approval?.status ?? "expired" }, now: now() });
      }
      delete state.pending;
      saveState(deps.db, run.id, state);
    }

    for (let round = 0; round < limits.maxToolRounds; round += 1) {
      const pending: { id: string; name: string; arguments: string }[] = [];
      for await (const event of deps.stream(state.messages, specs(deps.tools), {
        maxOutputTokens: limits.maxOutputTokens,
        firstTokenTimeoutMs: limits.firstTokenMs,
        idleTimeoutMs: limits.idleMs,
      })) {
        const typed = event as AdapterEvent;
        if (typed.type === "text_delta") {
          text += typed.text;
          deps.events.append({ kind: "message.delta", runId: run.id, sessionId: run.sessionId, payload: { text: typed.text }, now: now() });
        } else if (typed.type === "tool_call") {
          pending.push({ id: typed.id, name: typed.name, arguments: typed.arguments });
        }
      }
      if (pending.length === 0) break;

      let paused = false;
      for (const call of pending) {
        const tool = deps.tools.get(call.name);
        const args = (() => {
          try {
            const parsed: unknown = JSON.parse(call.arguments || "{}");
            return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
          } catch {
            return {};
          }
        })();
        const decision = tool ? decide(deps.policy, { action: tool.action, resource: String(args["path"] ?? args["summary"] ?? "*") }) : "deny";
        if (decision === "ask") {
          const approvalId = crypto.randomUUID();
          deps.db
            .query(
              "INSERT OR REPLACE INTO tool_calls (id, run_id, name, arguments_json, decision, decision_by, status, started_at) VALUES (?,?,?,?,?,?,?,?)",
            )
            .run(call.id, run.id, call.name, call.arguments, "ask", "policy", "pending", new Date(now()).toISOString());
          deps.db
            .query("INSERT INTO approvals (id, run_id, tool_call_id, status, requested_at) VALUES (?,?,?,?,?)")
            .run(approvalId, run.id, call.id, "pending", new Date(now()).toISOString());
          state.pending = { callId: call.id, name: call.name, arguments: call.arguments, approvalId };
          saveState(deps.db, run.id, state);
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
        const result = await executeTool(deps, run, call);
        state.messages.push({ role: "tool", content: result.output, toolCallId: call.id });
        if (!result.timeout) deps.events.append({ kind: "tool.result", runId: run.id, payload: { id: call.id, name: call.name, output: result.output }, now: now() });
        else deps.events.append({ kind: "tool.timeout", runId: run.id, payload: { id: call.id, name: call.name }, now: now() });
      }
      if (paused) return "paused";
      if (text.length > 0) state.messages.push({ role: "assistant", content: text });
    }

    saveState(deps.db, run.id, state);
    settle(deps.db, deps.events, run, "succeeded", { text }, now());
    return "succeeded";
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    saveState(deps.db, run.id, state);
    settle(deps.db, deps.events, run, "failed", { error: message }, now());
    return "failed";
  }
}

export type Decision = "approve" | "reject";

/** Records a decision and re-queues the run so a worker resumes it. */
export function decideApproval(
  deps: Pick<WorkDeps, "db" | "events">,
  input: { readonly runId: string; readonly approvalId: string; readonly decision: Decision; readonly now?: number },
): { status: string } {
  const now = input.now ?? Date.now();
  const approval = deps.db.query("SELECT id, run_id, status FROM approvals WHERE id = ?").get(input.approvalId) as
    | { id: string; run_id: string; status: string }
    | null;
  if (!approval || approval.run_id !== input.runId) throw new Error("approval_not_found");
  if (approval.status !== "pending") throw new Error("approval_already_decided");
  const status = input.decision === "approve" ? "approved" : "rejected";
  deps.db.query("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?").run(status, new Date(now).toISOString(), approval.id);
  deps.db.query("UPDATE tool_calls SET decision_by = 'user', decision = ? WHERE run_id = ? AND status = 'pending'").run(status, input.runId);
  deps.db.query("UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = ?").run(input.runId);
  deps.events.append({ kind: "approval.decided", runId: input.runId, payload: { approvalId: approval.id, status }, now });
  return { status };
}

/** Expires approvals nobody answered, and settles runs whose lease died. */
export function reconcileWork(db: Database, events: EventLog, now = Date.now(), ttlMs = 30 * 60_000): { expiredApprovals: number; interrupted: number } {
  const stale = db
    .query("SELECT id, run_id FROM approvals WHERE status = 'pending' AND requested_at <= ?")
    .all(new Date(now - ttlMs).toISOString()) as { id: string; run_id: string }[];
  for (const approval of stale) {
    db.query("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?").run(new Date(now).toISOString(), approval.id);
    db.query("UPDATE runs SET status = 'queued' WHERE id = ? AND status = 'awaiting_approval'").run(approval.run_id);
    events.append({ kind: "approval.expired", runId: approval.run_id, payload: { approvalId: approval.id }, now });
  }
  const live = db.query("SELECT id, lease_expires_at FROM runs WHERE status = 'running'").all() as { id: string; lease_expires_at: string | null }[];
  let interrupted = 0;
  for (const run of live) {
    if (!isLeaseExpired(run.lease_expires_at, now)) continue;
    db.query("UPDATE runs SET status = 'interrupted', cancel_intent = 'host_restart', settled_at = ? WHERE id = ?").run(new Date(now).toISOString(), run.id);
    events.append({ kind: "run.interrupted", runId: run.id, payload: { reason: "lease_expired" }, now });
    interrupted += 1;
  }
  return { expiredApprovals: stale.length, interrupted };
}
