import type { ConversationEvent } from "./api";
import { MarkdownText } from "./MarkdownText";
import { Spinner } from "./SpinnerView";
import {
  formatToolArguments,
  formatToolResult,
  resultBytes,
  sizeLabel,
  toolResultBody,
} from "./formatTool";
import { useState } from "react";

/**
 * The turn's events, each rendered as its own block:
 *
 *   사용자 ─ 말풍선
 *   비서 ─ 생각 과정(접힘) · 문단 · 도구 이름 + 그 결과(접힘) · 오류
 *
 * A tool call and its result form one block because they are one action; nothing else
 * is grouped. The result is folded away by default: a long JSON body must not bury the
 * answer the reader came for.
 */
type CallPair = {
  readonly call: Extract<ConversationEvent, { type: "tool_call" }>;
  readonly result: Extract<ConversationEvent, { type: "tool_result" }> | null;
};

export type Block =
  | { readonly kind: "thinking"; readonly event: Extract<ConversationEvent, { type: "thinking" }> }
  | { readonly kind: "text"; readonly event: Extract<ConversationEvent, { type: "text" }> }
  | { readonly kind: "tool"; readonly pair: CallPair }
  | { readonly kind: "error"; readonly event: Extract<ConversationEvent, { type: "error" }> };

/** Calls keep their position; a result joins the call it answers. */
export function conversationBlocks(events: readonly ConversationEvent[]): Block[] {
  const blocks: Block[] = [];
  const callIndex = new Map<string, number>();
  for (const event of events) {
    switch (event.type) {
      case "thinking":
        blocks.push({ kind: "thinking", event });
        break;
      case "text":
        blocks.push({ kind: "text", event });
        break;
      case "tool_call":
        callIndex.set(event.callId, blocks.length);
        blocks.push({ kind: "tool", pair: { call: event, result: null } });
        break;
      case "tool_result": {
        const at = callIndex.get(event.callId);
        const existing = at === undefined ? undefined : blocks[at];
        if (at !== undefined && existing?.kind === "tool")
          blocks[at] = { kind: "tool", pair: { call: existing.pair.call, result: event } };
        else
          blocks.push({
            kind: "tool",
            pair: {
              call: {
                type: "tool_call",
                id: event.id,
                callId: event.callId,
                name: event.name,
                detail: "",
              },
              result: event,
            },
          });
        break;
      }
      case "error":
        blocks.push({ kind: "error", event });
        break;
      default: {
        const unexpected: never = event;
        throw new Error(`Unknown conversation event: ${JSON.stringify(unexpected)}`);
      }
    }
  }
  return blocks;
}

export function ConversationEventList({
  events,
  status,
}: {
  readonly events: readonly ConversationEvent[];
  /** The turn's state: a running turn whose answer has not started still says so. */
  readonly status?: string | null;
}) {
  const blocks = conversationBlocks(events);
  return (
    <>
      {blocks.map((block) => {
        switch (block.kind) {
          case "thinking":
            // Reachable but never the visible answer: reasoning is often not in the
            // reader's language and is not what the assistant committed to.
            return (
              <details
                key={`t-${block.event.id}`}
                className="event thinking"
                data-testid="event-thinking"
              >
                <summary>생각 과정</summary>
                <p>{block.event.text}</p>
              </details>
            );
          case "text":
            return <MarkdownText key={`x-${block.event.id}`} text={block.event.text} />;
          case "error":
            return (
              <pre key={`e-${block.event.id}`} className="event error" data-testid="event-error">
                {block.event.detail}
              </pre>
            );
          case "tool":
            return <ToolCallBlock key={`c-${block.pair.call.id}`} pair={block.pair} />;
          default: {
            const unexpected: never = block;
            throw new Error(`Unknown block: ${JSON.stringify(unexpected)}`);
          }
        }
      })}
      {/* Nothing has arrived yet: the wait itself is the state the reader needs. */}
      {status === "streaming" && !blocks.some((block) => block.kind === "text") ? (
        <Spinner label="응답을 기다리는 중" startedAt={waitingSince(events)} />
      ) : null}
    </>
  );
}

/**
 * When this turn started, as far as the view can tell: the first event's arrival is
 * the best anchor it has, so elapsed time is never reported from a later reload.
 */
const starts = new WeakMap<readonly ConversationEvent[], number>();
function waitingSince(events: readonly ConversationEvent[]): number {
  const known = starts.get(events);
  if (known !== undefined) return known;
  const now = Date.now();
  starts.set(events, now);
  return now;
}

/**
 * One tool call. The header states name, state and size; the payload is behind a
 * disclosure that starts closed, and the arguments keep the same treatment one level
 * in. While the call runs, elapsed seconds say it is still moving.
 */
function ToolCallBlock({ pair }: { readonly pair: CallPair }) {
  const { call, result } = pair;
  const [pretty, setPretty] = useState(false);
  const failed = result?.failed === true;
  const view = result === null ? null : formatToolResult(result.detail);
  const state = result === null ? "실행 중" : failed ? "실패" : "완료";
  return (
    <details
      className={`event tool${failed ? " failed" : ""}${result === null ? " running" : ""}`}
      data-testid="event-tool"
      data-call-id={call.callId}
      data-state={result === null ? "running" : failed ? "failed" : "done"}
    >
      <summary>
        <span className="tool-name">{call.name}</span>
        <span className="tool-state">{state}</span>
        {result === null ? (
          <RunningTool />
        ) : view === null ? null : (
          <span className="tool-size" data-testid="tool-size">
            {sizeLabel(view, resultBytes(result.detail))}
          </span>
        )}
      </summary>
      {call.detail.trim().length > 0 ? (
        <details className="tool-arguments">
          <summary>입력</summary>
          <pre>{formatToolArguments(call.detail)}</pre>
        </details>
      ) : null}
      {view === null || result === null ? null : (
        <>
          {view.pretty === null ? null : (
            <span className="tool-view-toggle" role="group" aria-label="표시 형식">
              <button
                type="button"
                className="link"
                aria-pressed={!pretty}
                data-testid="tool-raw"
                onClick={() => setPretty(false)}
              >
                원문
              </button>
              <button
                type="button"
                className="link"
                aria-pressed={pretty}
                data-testid="tool-pretty"
                onClick={() => setPretty(true)}
              >
                정리
              </button>
            </span>
          )}
          <pre className="tool-output" data-testid="tool-output">
            {toolResultBody(view, pretty)}
          </pre>
        </>
      )}
    </details>
  );
}

/** Elapsed seconds while a tool is still running, so silence is not mistaken for a hang. */
function RunningTool() {
  const started = useStartedAt();
  return <Spinner label="실행 중" startedAt={started} />;
}

function useStartedAt(): number {
  const [started] = useState(() => Date.now());
  return started;
}
