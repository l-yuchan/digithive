import type { ConversationEvent } from "./api";

/**
 * The turn's events, each rendered as its own block:
 *
 *   사용자 ─ 말풍선
 *   비서 ─ 생각 과정(접힘) · 문단 · 도구 이름 + 그 결과 · 오류
 *
 * A tool call and its result form one block because they are one action; nothing
 * else is grouped, so the reader never opens a bundle to find what happened.
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

function prettyArguments(detail: string): string {
  if (detail.trim().length === 0) return "";
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

export function ConversationEventList({
  events,
}: {
  readonly events: readonly ConversationEvent[];
}) {
  return (
    <>
      {conversationBlocks(events).map((block) => {
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
            return (
              <p key={`x-${block.event.id}`} className="event text" data-testid="event-text">
                {block.event.text}
              </p>
            );
          case "error":
            return (
              <pre key={`e-${block.event.id}`} className="event error" data-testid="event-error">
                {block.event.detail}
              </pre>
            );
          case "tool": {
            const { call, result } = block.pair;
            const failed = result?.failed === true;
            return (
              <section
                key={`c-${call.id}`}
                className={`event tool${failed ? " failed" : ""}${result === null ? " running" : ""}`}
                data-testid="event-tool"
                data-call-id={call.callId}
              >
                <header>
                  <span className="tool-name">{call.name}</span>
                  <span className="tool-state">
                    {result === null ? "실행 중" : failed ? "실패" : "완료"}
                  </span>
                </header>
                {call.detail.trim().length > 0 ? (
                  <details className="tool-arguments">
                    <summary>입력</summary>
                    <pre>{prettyArguments(call.detail)}</pre>
                  </details>
                ) : null}
                {result === null ? null : <pre className="tool-output">{result.detail}</pre>}
              </section>
            );
          }
          default: {
            const unexpected: never = block;
            throw new Error(`Unknown block: ${JSON.stringify(unexpected)}`);
          }
        }
      })}
    </>
  );
}
