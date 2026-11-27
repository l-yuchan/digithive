import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { ConversationEvent } from "../core/contracts";
import { parseEntryEvents } from "../core/contracts";
import type { WhiteboardDraft } from "./document";
import { draft } from "./projection-format";

class UnexpectedConversationEventError extends Error {
  constructor(readonly event: never) {
    super(`unknown_conversation_event:${JSON.stringify(event)}`);
  }
}

type EntryRow = {
  id: string;
  session_id: string;
  session_title: string;
  kind: string;
  role: string | null;
  payload_json: string;
  created_at: string;
};

function eventMarkdown(event: ConversationEvent): string {
  switch (event.type) {
    case "text":
      return event.text;
    case "thinking":
      return `**추론**\n\n${event.text}`;
    case "tool_call":
      return `**도구 호출: ${event.name}**\n\n${event.detail}`;
    case "tool_result":
      return `**도구 결과: ${event.name}**\n\n${event.detail}`;
    case "error":
      return `**오류**\n\n${event.detail}`;
    default:
      throw new UnexpectedConversationEventError(event);
  }
}

/** Immutable conversation Evidence; no text becomes an instruction or a new task. */
export function conversationDrafts(db: Database, now: string): WhiteboardDraft[] {
  const rows = db
    .query<EntryRow, SQLQueryBindings[]>(
      `SELECT e.id,e.session_id,s.title AS session_title,e.kind,e.role,e.payload_json,e.created_at
       FROM entries e JOIN sessions s ON s.id = e.session_id ORDER BY e.session_id,e.seq,e.id`,
    )
    .all();
  return rows.map((row) => {
    const text = parseEntryEvents(row.payload_json).map(eventMarkdown).join("\n\n");
    return draft({
      directory: "records/conversations",
      originKey: row.id,
      kind: "record",
      title: `${row.session_title} · ${row.role || row.kind}`,
      text: `${text || "기록된 이벤트 본문이 없습니다."}\n\n기록 시각: ${row.created_at}\n종류: ${row.kind}\n대화: ${row.session_title}`,
      source: {
        type: "conversation",
        entryId: row.id,
        sessionId: row.session_id,
        role: row.role,
        kind: row.kind,
      },
      status: "current",
      createdAt: row.created_at,
      updatedAt: now,
    });
  });
}
