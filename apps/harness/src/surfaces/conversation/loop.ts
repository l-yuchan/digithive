import type { Database } from "bun:sqlite";
import type { EventLog } from "../../events/log";
import { appendEntry, updateEntryParts, type Part } from "../../core/sessions";
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
 * One conversation turn: user entry → streamed assistant entry → optional tool
 * rounds → settled run. A deadline abort is recorded as `message.aborted` and
 * the run is settled, never left `running`.
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
      parts: [{ type: "text", text: input.text }],
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
    parts: [],
    parentId: userEntryId,
    now: startedAt,
  });
  setLeaf(deps.db, input.sessionId, assistantEntry.id);
  deps.events.append({
    kind: "message.started",
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
  const parts: Part[] = [];
  let text = "";

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
        parts.push({ type: "error", message });
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
        content: entry.parts
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join(""),
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
      const routing = (diagnostic: ProviderDiagnostic) => {
        const message = describeRouting(diagnostic);
        parts.push({ type: "error", message });
        deps.events.append({
          kind: diagnostic.kind,
          runId,
          sessionId: input.sessionId,
          payload: { ...diagnostic, message },
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
          const last = parts.at(-1);
          if (last && last.type === "text")
            parts[parts.length - 1] = { type: "text", text: last.text + event.text };
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
          if (last && last.type === "reasoning")
            parts[parts.length - 1] = { type: "reasoning", text: last.text + event.text };
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
        parts.push({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
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
        if (!tool || decision !== "allow") {
          const output = tool
            ? "정책이 이 호출을 거부했습니다."
            : `알 수 없는 도구입니다: ${call.name}`;
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
        let toolTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          output = await Promise.race([
            tool.execute(args, { runId }),
            new Promise<string>((resolve) => {
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
          parts.push({ type: "tool_result", id: call.id, name: call.name, output, timeout: true });
          deps.events.append({
            kind: "tool.timeout",
            runId,
            sessionId: input.sessionId,
            payload: { id: call.id, name: call.name },
            now: now(),
          });
        } else {
          parts.push({ type: "tool_result", id: call.id, name: call.name, output });
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
    updateEntryParts(deps.db, assistantEntry.id, parts, "complete", input.sessionId);
    deps.events.append({
      kind: "message.completed",
      runId,
      sessionId: input.sessionId,
      payload: { entryId: assistantEntry.id },
      now: now(),
    });
    deps.events.append({
      kind: "turn.settled",
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
    parts.push({
      type: "error",
      message: interrupted ? `실행 중단: ${reason(controller.signal.reason)}` : kind,
    });
    updateEntryParts(
      deps.db,
      assistantEntry.id,
      parts,
      interrupted ? "aborted" : "failed",
      input.sessionId,
    );
    deps.events.append({
      kind: "message.aborted",
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
