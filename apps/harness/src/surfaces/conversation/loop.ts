import type { Database } from "bun:sqlite";
import type { EventLog } from "../../events/log";
import { appendEntry, saveEntryEvents, updateEntryEvents } from "../../core/sessions";
import { conversationText, type ConversationEvent } from "../../core/contracts";
import { getLeaf, pathEntries, setLeaf } from "../../core/tree";
import { buildContext } from "../../core/context";
import { recallMemories } from "../../knowledge/memory";
import { latestCompaction, maybeCompact } from "../../core/compaction";
import { BASE_POLICY, decide, type PolicyRule } from "../../core/policy";
import { leaseExpiry } from "../../core/run-state";
import type { ChatMessage, StreamFn } from "../../providers/openai";
import type { ProviderDiagnostic } from "../../providers/router";
import { specs, type ToolRegistry } from "../../tools/registry";
import { keepLease, ownsLease } from "../work/lease";
import { z } from "zod";

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
  /** Optional: enables threshold compaction of older turns. */
  readonly summarize?: (transcript: string) => Promise<string>;
  readonly maxChars?: number;
};

export type TurnResult = {
  readonly runId: string;
  readonly entryId: string;
  readonly status: "succeeded" | "aborted" | "failed";
  readonly text: string;
};

function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** One readable line per routing decision, e.g. a provider suspended by quota. */
function describeRouting(diagnostic: ProviderDiagnostic): string {
  const target = `${diagnostic.provider}/${diagnostic.model}`;
  switch (diagnostic.kind) {
    case "provider.retry":
      return `모델 경로 ${target} 응답 실패(${diagnostic.reason ?? "unknown"}), 같은 경로로 다시 시도합니다.`;
    case "provider.fallback": {
      const cooldown =
        diagnostic.retryInMs && diagnostic.retryInMs > 0
          ? ` ${Math.ceil(diagnostic.retryInMs / 60_000)}분 동안 사용하지 않습니다.`
          : " 이번 호출만 대체 경로를 사용합니다.";
      return `모델 경로 ${diagnostic.failedProvider ?? "?"} 실패(${diagnostic.reason ?? "unknown"}): ${diagnostic.error ?? ""} → ${target}로 전환.${cooldown}`;
    }
    case "provider.exhausted":
      return `사용 가능한 모델 경로가 없습니다. ${diagnostic.retryInMs ? `${Math.ceil(diagnostic.retryInMs / 60_000)}분 후 다시 시도할 수 있습니다.` : ""}`.trim();
    case "provider.recovered":
      return `대체 모델 경로 ${target}에서 응답했습니다.`;
    default: {
      const unexpected: never = diagnostic.kind;
      return String(unexpected);
    }
  }
}

/**
 * One conversation turn: user entry → streamed assistant events → optional tool
 * rounds → settled run. Thinking, each paragraph, each tool call and each result is
 * appended as its own event with its own stream event, so the view never has to
 * unpack a bundle. A deadline abort is recorded as `turn.response.aborted` and the
 * run is settled, never left `running`.
 */
export async function runTurn(
  deps: ConversationDeps,
  input: {
    readonly sessionId: string;
    readonly text: string;
    /** false when the user entry already exists (edit or regenerate). */
    readonly appendUser?: boolean;
    /** parent for the assistant entry; defaults to the leaf. */
    readonly parentId?: string | null;
  },
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
    .run(
      runId,
      input.sessionId,
      input.text.slice(0, 4096),
      leaseExpiry(startedAt),
      JSON.stringify({ maxOutputTokens: limits.maxOutputTokens }),
      new Date(startedAt).toISOString(),
    );
  deps.events.append({
    kind: "run.started",
    runId,
    sessionId: input.sessionId,
    payload: { runId },
    now: startedAt,
  });

  let userEntryId: string;
  if (input.appendUser === false) {
    userEntryId = input.parentId ?? getLeaf(deps.db, input.sessionId) ?? "";
    if (userEntryId.length === 0) throw new Error("no_parent_entry");
    setLeaf(deps.db, input.sessionId, userEntryId);
  } else {
    const userEntry = appendEntry(deps.db, {
      sessionId: input.sessionId,
      parentId: input.parentId ?? getLeaf(deps.db, input.sessionId),
      kind: "message",
      role: "user",
      events: [{ type: "text", id: 0, text: input.text }],
      now: startedAt,
    });
    userEntryId = userEntry.id;
    setLeaf(deps.db, input.sessionId, userEntryId);
  }
  const assistantEntry = appendEntry(deps.db, {
    sessionId: input.sessionId,
    kind: "message",
    role: "assistant",
    status: "streaming",
    events: [],
    parentId: userEntryId,
    now: startedAt,
  });
  setLeaf(deps.db, input.sessionId, assistantEntry.id);
  deps.events.append({
    kind: "turn.response.started",
    runId,
    sessionId: input.sessionId,
    payload: { entryId: assistantEntry.id },
    now: startedAt,
  });
  deps.events.append({
    kind: "turn.started",
    runId,
    sessionId: input.sessionId,
    payload: { userEntryId },
    now: startedAt,
  });

  const controller = keepLease(
    deps.db,
    deps.events,
    { id: runId, leaseOwner: "conversation" },
    45_000,
    limits.totalMs,
    now,
  );
  /** Appends one event and streams it as its own event; the id is its position. */
  const events: ConversationEvent[] = [];
  const emit = (event: ConversationEvent) => {
    events.push(event);
    savedSince = 0;
    saveProgress(true);
    return event;
  };
  let text = "";
  // Partial text is stored between deltas so a reconnecting or reloading view sees
  // the answer that was already streamed instead of an empty bubble.
  let savedSince = 0;
  let savedOnce = false;
  const saveProgress = (force = false) => {
    if (!force && savedOnce && savedSince < 8) return;
    savedSince = 0;
    savedOnce = true;
    saveEntryEvents(deps.db, assistantEntry.id, events);
  };

  try {
    if (deps.summarize) {
      await maybeCompact({
        db: deps.db,
        sessionId: input.sessionId,
        summarize: deps.summarize,
        maxChars: deps.maxChars ?? 24_000,
        now: startedAt,
      }).catch((error: unknown) => {
        const message = `대화 요약 실패: ${reason(error)}`;
        emit({ type: "error", id: events.length, detail: message });
        deps.events.append({
          kind: "context.compaction_failed",
          runId,
          sessionId: input.sessionId,
          payload: { error: message },
          now: now(),
        });
      });
    }
    const compaction = latestCompaction(deps.db, input.sessionId);
    const history = pathEntries(deps.db, input.sessionId, userEntryId)
      .filter(
        (entry) =>
          entry.kind === "message" && (entry.role === "user" || entry.role === "assistant"),
      )
      .filter((entry) => !compaction || entry.seq > compaction.coversSeq)
      .map((entry) => ({
        role: entry.role === "user" ? ("user" as const) : ("assistant" as const),
        content: conversationText(entry.events),
      }))
      .filter((message) => message.content.length > 0);
    const built = buildContext({
      now: startedAt,
      history,
      memories: recallMemories(deps.db, input.text).map((memory) =>
        JSON.stringify({
          id: memory.id,
          kind: memory.kind,
          text: memory.text.slice(0, 1000),
          truncated: memory.text.length > 1000,
        }),
      ),
      tools: specs(deps.tools).map((tool) => ({ name: tool.name, description: tool.description })),
      compaction,
      ...(deps.maxChars === undefined ? {} : { budget: { maxChars: deps.maxChars } }),
    });
    const messages: ChatMessage[] = [{ role: "system", content: built.system }, ...built.messages];
    if (messages.at(-1)?.content !== input.text)
      messages.push({ role: "user", content: input.text });

    let round = 0;
    while (round < limits.maxToolRounds) {
      round += 1;
      const pending: { id: string; name: string; arguments: string }[] = [];
      // Deltas extend the event they belong to; any other event closes it, so a
      // paragraph after a tool result is a new block rather than being glued on.
      let open: { readonly type: "text" | "thinking"; readonly id: number } | null = null;
      const routing = (diagnostic: ProviderDiagnostic) => {
        const message = describeRouting(diagnostic);
        open = null;
        emit({ type: "error", id: events.length, detail: message });
        deps.events.append({
          kind: diagnostic.kind,
          runId,
          sessionId: input.sessionId,
          payload: { ...diagnostic, message },
          now: now(),
        });
      };
      const appendDelta = (type: "text" | "thinking", delta: string) => {
        if (open !== null && open.type === type) {
          const current = events[open.id];
          if (current && (current.type === "text" || current.type === "thinking"))
            events[open.id] = { ...current, text: current.text + delta };
        } else {
          const created = emit({ type, id: events.length, text: delta });
          open = { type, id: created.id };
        }
        savedSince += 1;
        saveProgress();
        deps.events.append({
          kind: deltaKind(type),
          runId,
          sessionId: input.sessionId,
          payload: { entryId: assistantEntry.id, id: open.id, text: delta },
          now: now(),
        });
      };
      for await (const event of deps.stream(messages, specs(deps.tools), {
        maxOutputTokens: limits.maxOutputTokens,
        firstTokenTimeoutMs: limits.firstTokenMs,
        idleTimeoutMs: limits.idleMs,
        signal: controller.signal,
        contextKey: `session:${input.sessionId}`,
        onDiagnostic: routing,
      })) {
        if (!ownsLease(deps.db, runId, "conversation", now())) throw new Error("lease_lost");
        if (event.type === "text_delta") {
          text += event.text;
          appendDelta("text", event.text);
        } else if (event.type === "reasoning_delta") {
          appendDelta("thinking", event.text);
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
      // A tool round ends any open paragraph: the next text is its own block.
      open = null;
      messages.push({ role: "assistant", content: text, toolCalls: pending });

      for (const call of pending) {
        if (!ownsLease(deps.db, runId, "conversation", now())) throw new Error("lease_lost");
        const tool = deps.tools.get(call.name);
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(call.arguments || "{}");
          if (parsed && typeof parsed === "object")
            args = z.record(z.string(), z.unknown()).parse(parsed);
        } catch {
          args = {};
        }
        const callEvent = emit({
          type: "tool_call",
          id: events.length,
          callId: call.id,
          name: call.name,
          detail: call.arguments,
        });
        deps.events.append({
          kind: "tool_call.started",
          runId,
          sessionId: input.sessionId,
          payload: {
            entryId: assistantEntry.id,
            id: callEvent.id,
            callId: call.id,
            name: call.name,
            detail: call.arguments,
          },
          now: now(),
        });
        deps.events.append({
          kind: "tool.started",
          runId,
          sessionId: input.sessionId,
          payload: { call },
          now: now(),
        });

        const decision = tool
          ? decide(policy, {
              action: tool.action,
              resource: z.string().parse(args["path"] ?? args["command"] ?? "*"),
            })
          : "deny";
        const recordResult = (output: string, failed: boolean) => {
          const resultEvent = emit({
            type: "tool_result",
            id: events.length,
            callId: call.id,
            name: call.name,
            detail: output,
            ...(failed ? { failed: true } : {}),
          });
          deps.events.append({
            kind: "tool_result.recorded",
            runId,
            sessionId: input.sessionId,
            payload: {
              entryId: assistantEntry.id,
              id: resultEvent.id,
              callId: call.id,
              name: call.name,
              detail: output,
              ...(failed ? { failed: true } : {}),
            },
            now: now(),
          });
        };
        if (!tool || decision !== "allow") {
          const output = tool
            ? "정책이 이 호출을 거부했습니다."
            : `알 수 없는 도구입니다: ${call.name}`;
          recordResult(output, true);
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
        let toolTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          // A tool that manages its own deadline must not be cut off by this timer:
          // an inline workflow run budgets from the caller's remaining time instead.
          output = await Promise.race([
            tool.execute(args, { runId }),
            new Promise<string>((resolve) => {
              if (tool.selfDeadline === true) return;
              toolTimer = setTimeout(() => resolve("__tool_timeout__"), limits.toolMs);
            }),
          ]);
          timedOut = output === "__tool_timeout__";
        } catch (error) {
          output = `도구 실행 실패: ${reason(error)}`;
        } finally {
          clearTimeout(toolTimer);
        }
        if (timedOut) {
          output = "도구 실행 시간이 초과되었습니다.";
          recordResult(output, true);
          deps.events.append({
            kind: "tool.timeout",
            runId,
            sessionId: input.sessionId,
            payload: { id: call.id, name: call.name },
            now: now(),
          });
        } else {
          recordResult(output, output.startsWith("도구 실행 실패"));
          deps.events.append({
            kind: "tool.result",
            runId,
            sessionId: input.sessionId,
            payload: { id: call.id, name: call.name, output },
            now: now(),
          });
        }
        messages.push({ role: "tool", content: output, toolCallId: call.id });
      }
    }

    if (!ownsLease(deps.db, runId, "conversation", now())) throw new Error("lease_lost");
    updateEntryEvents(deps.db, assistantEntry.id, events, "complete", input.sessionId);
    deps.events.append({
      kind: "turn.response.completed",
      runId,
      sessionId: input.sessionId,
      payload: { entryId: assistantEntry.id },
      now: now(),
    });
    deps.events.append({
      kind: "turn.done",
      runId,
      sessionId: input.sessionId,
      payload: { entryId: assistantEntry.id },
      now: now(),
    });
    deps.db
      .query("UPDATE runs SET status = 'succeeded', settled_at = ?, result_json = ? WHERE id = ?")
      .run(new Date(now()).toISOString(), JSON.stringify({ entryId: assistantEntry.id }), runId);
    deps.events.append({
      kind: "run.settled",
      runId,
      sessionId: input.sessionId,
      payload: { status: "succeeded" },
      now: now(),
    });
    return { runId, entryId: assistantEntry.id, status: "succeeded", text };
  } catch (error) {
    const kind = reason(error);
    const interrupted = controller.signal.aborted;
    if (!ownsLease(deps.db, runId, "conversation", now()))
      return { runId, entryId: assistantEntry.id, status: "aborted", text };
    emit({
      type: "error",
      id: events.length,
      detail: interrupted ? `실행 중단: ${reason(controller.signal.reason)}` : kind,
    });
    updateEntryEvents(
      deps.db,
      assistantEntry.id,
      events,
      interrupted ? "aborted" : "failed",
      input.sessionId,
    );
    deps.events.append({
      kind: "turn.response.aborted",
      runId,
      sessionId: input.sessionId,
      payload: { entryId: assistantEntry.id, reason: interrupted ? "timeout" : kind },
      now: now(),
    });
    deps.events.append({
      kind: "turn.aborted",
      runId,
      sessionId: input.sessionId,
      payload: { reason: interrupted ? "timeout" : kind },
      now: now(),
    });
    const status = interrupted ? "interrupted" : "failed";
    deps.db
      .query(
        "UPDATE runs SET status = ?, cancel_intent = ?, settled_at = ?, result_json = ? WHERE id = ?",
      )
      .run(
        status,
        interrupted ? "timeout" : null,
        new Date(now()).toISOString(),
        JSON.stringify({ error: kind }),
        runId,
      );
    deps.events.append({
      kind: interrupted ? "run.interrupted" : "run.failed",
      runId,
      sessionId: input.sessionId,
      payload: { reason: kind },
      now: now(),
    });
    return { runId, entryId: assistantEntry.id, status: interrupted ? "aborted" : "failed", text };
  } finally {
    controller.close();
  }
}

/** The stream event a delta is recorded under; one name per visible kind. */
function deltaKind(type: "text" | "thinking"): "text.delta" | "thinking.delta" {
  const names: Record<"text" | "thinking", "text.delta" | "thinking.delta"> = {
    text: "text.delta",
    thinking: "thinking.delta",
  };
  return names[type];
}
