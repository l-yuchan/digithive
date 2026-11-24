import type { Database } from "bun:sqlite";
import { EventLog } from "../../events/log";
import { appendEntry, historyMessages, updateEntryParts, type Part } from "../../core/sessions";
import { systemPrompt } from "../../core/context";
import { BASE_POLICY, decide, type PolicyRule } from "../../core/policy";
import { leaseExpiry } from "../../core/run-state";
import { ProviderError, type ChatMessage, type StreamFn } from "../../providers/openai";
import { specs, type ToolRegistry } from "../../tools/registry";

export type TurnLimits = {
  readonly firstTokenMs: number;
  readonly idleMs: number;
  readonly totalMs: number;
  readonly toolMs: number;
  readonly maxOutputTokens: number;
  readonly maxToolRounds: number;
};

export const DEFAULT_LIMITS: TurnLimits = {
  firstTokenMs: 60_000,
  idleMs: 120_000,
  totalMs: 15 * 60_000,
  toolMs: 30_000,
  maxOutputTokens: 2_048,
  maxToolRounds: 3,
};

export type ConversationDeps = {
  readonly db: Database;
  readonly events: EventLog;
  readonly stream: StreamFn;
  readonly tools: ToolRegistry;
  readonly policy?: readonly PolicyRule[];
  readonly limits?: TurnLimits;
  readonly now?: () => number;
};

export type TurnResult = {
  readonly runId: string;
  readonly entryId: string;
  readonly status: "succeeded" | "aborted" | "failed";
  readonly text: string;
};

function reason(error: unknown): string {
  if (error instanceof ProviderError) return error.kind;
  if (error instanceof Error) return error.message;
  return "unknown";
}

/**
 * One conversation turn: user entry → streamed assistant entry → optional tool
 * rounds → settled run. A deadline abort is recorded as `message.aborted` and
 * the run is settled, never left `running`.
 */
export async function runTurn(
  deps: ConversationDeps,
  input: { readonly sessionId: string; readonly text: string },
): Promise<TurnResult> {
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const policy = deps.policy ?? BASE_POLICY;
  const startedAt = now();
  const runId = crypto.randomUUID();

  deps.db
    .query(
      `INSERT INTO runs (id, session_id, origin, goal, status, lease_owner, lease_expires_at, budget_json, created_at)
       VALUES (?, ?, 'conversation', ?, 'running', 'conversation', ?, ?, ?)`,
    )
    .run(runId, input.sessionId, input.text.slice(0, 4096), leaseExpiry(startedAt), JSON.stringify({ maxOutputTokens: limits.maxOutputTokens }), new Date(startedAt).toISOString());
  deps.events.append({ kind: "run.started", runId, sessionId: input.sessionId, payload: { runId }, now: startedAt });

  const userEntry = appendEntry(deps.db, {
    sessionId: input.sessionId,
    kind: "message",
    role: "user",
    parts: [{ type: "text", text: input.text }],
    now: startedAt,
  });
  const assistantEntry = appendEntry(deps.db, {
    sessionId: input.sessionId,
    kind: "message",
    role: "assistant",
    status: "streaming",
    parts: [],
    parentId: userEntry.id,
    now: startedAt,
  });
  deps.events.append({
    kind: "message.started",
    runId,
    sessionId: input.sessionId,
    payload: { entryId: assistantEntry.id },
    now: startedAt,
  });
  deps.events.append({ kind: "turn.started", runId, sessionId: input.sessionId, payload: { userEntryId: userEntry.id }, now: startedAt });

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("turn_timeout")), limits.totalMs);
  const parts: Part[] = [];
  let text = "";

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(startedAt) },
      ...historyMessages(deps.db, input.sessionId).filter((message) => message.role !== "assistant" || message.content.length > 0),
    ];
    // The assistant placeholder is not history yet; make sure the new user text is present exactly once.
    if (messages.at(-1)?.content !== input.text) messages.push({ role: "user", content: input.text });

    let round = 0;
    while (round < limits.maxToolRounds) {
      round += 1;
      const pending: { id: string; name: string; arguments: string }[] = [];
      for await (const event of deps.stream(messages, specs(deps.tools), {
        maxOutputTokens: limits.maxOutputTokens,
        firstTokenTimeoutMs: limits.firstTokenMs,
        idleTimeoutMs: limits.idleMs,
        signal: controller.signal,
      })) {
        if (event.type === "text_delta") {
          text += event.text;
          const last = parts.at(-1);
          if (last && last.type === "text") parts[parts.length - 1] = { type: "text", text: last.text + event.text };
          else parts.push({ type: "text", text: event.text });
          deps.events.append({
            kind: "message.delta",
            runId,
            sessionId: input.sessionId,
            payload: { entryId: assistantEntry.id, text: event.text },
            now: now(),
          });
        } else if (event.type === "reasoning_delta") {
          const last = parts.at(-1);
          if (last && last.type === "reasoning") parts[parts.length - 1] = { type: "reasoning", text: last.text + event.text };
          else parts.push({ type: "reasoning", text: event.text });
          deps.events.append({
            kind: "message.delta",
            runId,
            sessionId: input.sessionId,
            payload: { entryId: assistantEntry.id, reasoning: event.text },
            now: now(),
          });
        } else if (event.type === "tool_call") {
          pending.push({ id: event.id, name: event.name, arguments: event.arguments });
        } else if (event.type === "usage") {
          deps.events.append({
            kind: "usage.recorded",
            runId,
            sessionId: input.sessionId,
            payload: { promptTokens: event.promptTokens, completionTokens: event.completionTokens },
            now: now(),
          });
        }
      }

      if (pending.length === 0) break;

      for (const call of pending) {
        const tool = deps.tools.get(call.name);
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(call.arguments || "{}");
          if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
        } catch {
          args = {};
        }
        parts.push({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
        deps.events.append({ kind: "tool.started", runId, sessionId: input.sessionId, payload: { call }, now: now() });

        const decision = tool ? decide(policy, { action: tool.action, resource: String(args["path"] ?? args["command"] ?? "*") }) : "deny";
        if (!tool || decision !== "allow") {
          const output = tool ? "정책이 이 호출을 거부했습니다." : `알 수 없는 도구입니다: ${call.name}`;
          parts.push({ type: "tool_result", id: call.id, name: call.name, output, denied: true });
          deps.events.append({
            kind: "tool.denied",
            runId,
            sessionId: input.sessionId,
            payload: { id: call.id, name: call.name, decision, reason: output },
            now: now(),
          });
          messages.push({ role: "tool", content: output, toolCallId: call.id });
          continue;
        }

        let output: string;
        let timedOut = false;
        try {
          output = await Promise.race([
            tool.execute(args, { runId }),
            new Promise<string>((resolve) => {
              setTimeout(() => resolve("__tool_timeout__"), limits.toolMs);
            }),
          ]);
          timedOut = output === "__tool_timeout__";
        } catch (error) {
          output = `도구 실행 실패: ${reason(error)}`;
        }
        if (timedOut) {
          output = "도구 실행 시간이 초과되었습니다.";
          parts.push({ type: "tool_result", id: call.id, name: call.name, output, timeout: true });
          deps.events.append({ kind: "tool.timeout", runId, sessionId: input.sessionId, payload: { id: call.id, name: call.name }, now: now() });
        } else {
          parts.push({ type: "tool_result", id: call.id, name: call.name, output });
          deps.events.append({ kind: "tool.result", runId, sessionId: input.sessionId, payload: { id: call.id, name: call.name, output }, now: now() });
        }
        messages.push({ role: "tool", content: output, toolCallId: call.id });
      }
      if (text.length > 0) messages.push({ role: "assistant", content: text });
    }

    updateEntryParts(deps.db, assistantEntry.id, parts, "complete");
    deps.events.append({ kind: "message.completed", runId, sessionId: input.sessionId, payload: { entryId: assistantEntry.id }, now: now() });
    deps.events.append({ kind: "turn.settled", runId, sessionId: input.sessionId, payload: { entryId: assistantEntry.id }, now: now() });
    deps.db.query("UPDATE runs SET status = 'succeeded', settled_at = ?, result_json = ? WHERE id = ?").run(
      new Date(now()).toISOString(),
      JSON.stringify({ entryId: assistantEntry.id }),
      runId,
    );
    deps.events.append({ kind: "run.settled", runId, sessionId: input.sessionId, payload: { status: "succeeded" }, now: now() });
    return { runId, entryId: assistantEntry.id, status: "succeeded", text };
  } catch (error) {
    const kind = reason(error);
    const interrupted = controller.signal.aborted;
    if (text.length > 0) parts.push({ type: "text", text: "" });
    updateEntryParts(deps.db, assistantEntry.id, parts, interrupted ? "aborted" : "failed");
    deps.events.append({
      kind: "message.aborted",
      runId,
      sessionId: input.sessionId,
      payload: { entryId: assistantEntry.id, reason: interrupted ? "timeout" : kind },
      now: now(),
    });
    deps.events.append({ kind: "turn.aborted", runId, sessionId: input.sessionId, payload: { reason: interrupted ? "timeout" : kind }, now: now() });
    const status = interrupted ? "interrupted" : "failed";
    deps.db.query("UPDATE runs SET status = ?, cancel_intent = ?, settled_at = ?, result_json = ? WHERE id = ?").run(
      status,
      interrupted ? "timeout" : null,
      new Date(now()).toISOString(),
      JSON.stringify({ error: kind }),
      runId,
    );
    deps.events.append({ kind: interrupted ? "run.interrupted" : "run.failed", runId, sessionId: input.sessionId, payload: { reason: kind }, now: now() });
    return { runId, entryId: assistantEntry.id, status: interrupted ? "aborted" : "failed", text };
  } finally {
    clearTimeout(deadline);
  }
}
