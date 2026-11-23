import type { Database } from "bun:sqlite";
import { z } from "zod";
import { enqueue, getRun } from "../../runtime/queue";

const NewMessage = z.object({
  text: z.string().min(1).max(8_000),
  client_request_id: z.string().uuid(),
}).strict();

export class ConversationError extends Error {
  constructor(readonly kind: "missing" | "invalid") {
    super(kind);
    this.name = "ConversationError";
  }
}

export function createConversation(db: Database, title: string, now = Date.now()): { id: string; title: string } {
  const id = crypto.randomUUID();
  db.query("INSERT INTO conversations (id,title,created_at) VALUES (?,?,?)")
    .run(id, title.slice(0, 200), new Date(now).toISOString());
  return { id, title };
}

export function listConversations(db: Database): readonly { id: string; title: string; created_at: string }[] {
  return db.query("SELECT id,title,created_at FROM conversations ORDER BY created_at DESC")
    .all()
    .map((row) => z.object({ id: z.string(), title: z.string(), created_at: z.string() }).parse(row));
}

export function messages(db: Database, conversationId: string): readonly {
  id: string; role: string; content: string; run_id: string | null; created_at: string;
}[] {
  return db.query("SELECT id,role,content,run_id,created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid")
    .all(conversationId)
    .map((row) => z.object({
      id: z.string(), role: z.string(), content: z.string(),
      run_id: z.string().nullable(), created_at: z.string(),
    }).parse(row));
}

/**
 * Appends a user message and its Run in one transaction. A repeated
 * client_request_id returns the original message and Run instead of creating a
 * second one, so a retried send or a double click cannot start two tasks.
 */
export function appendMessage(
  db: Database, conversationId: string, input: { readonly text: string; readonly clientRequestId: string },
  now = Date.now(),
): { messageId: string; runId: string } {
  return db.transaction(() => {
    const conversation = db.query("SELECT id FROM conversations WHERE id = ?").get(conversationId);
    if (!conversation) throw new ConversationError("missing");
    const existing = db.query("SELECT id, run_id FROM messages WHERE client_request_id = ?").get(input.clientRequestId);
    if (existing) {
      const row = z.object({ id: z.string(), run_id: z.string().nullable() }).parse(existing);
      if (row.run_id) return { messageId: row.id, runId: row.run_id };
      throw new ConversationError("invalid");
    }
    const run = enqueue(db, {
      requestKey: `message:${input.clientRequestId}`,
      goal: input.text,
      executor: "agent",
      conversationId,
    }, now);
    const messageId = crypto.randomUUID();
    db.query("INSERT INTO messages (id,conversation_id,run_id,client_request_id,role,content,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(messageId, conversationId, run.id, input.clientRequestId, "user", input.text, new Date(now).toISOString());
    return { messageId, runId: run.id };
  }).immediate();
}

export function appendAssistant(db: Database, conversationId: string, runId: string, content: string, now = Date.now()): string {
  const id = crypto.randomUUID();
  db.query("INSERT INTO messages (id,conversation_id,run_id,client_request_id,role,content,created_at) VALUES (?,?,?,NULL,'assistant',?,?)")
    .run(id, conversationId, runId, content, new Date(now).toISOString());
  return id;
}

export function conversationRuns(db: Database, conversationId: string): readonly {
  id: string; status: string; goal: string; created_at: string;
}[] {
  return db.query("SELECT id,status,goal,created_at FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(conversationId)
    .map((row) => z.object({ id: z.string(), status: z.string(), goal: z.string(), created_at: z.string() }).parse(row));
}

export async function conversationsRoute(db: Database, request: Request, path: string): Promise<Response> {
  if (path === "/api/conversations") {
    if (request.method === "GET") return Response.json({ conversations: listConversations(db) });
    if (request.method === "POST") {
      let raw: unknown = {};
      try {
        raw = request.json === undefined ? {} : await request.json();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        raw = {};
      }
      const title = z.object({ title: z.string().min(1).max(200).optional() }).safeParse(raw ?? {});
      return Response.json(createConversation(db, title.success ? title.data.title ?? "새 대화" : "새 대화"), { status: 201 });
    }
  }
  const match = /^\/api\/conversations\/([^/]+)(?:\/(messages|runs))?$/.exec(path);
  if (!match) return Response.json({ error: "not_found" }, { status: 404 });
  const id = match[1];
  if (!id || !z.string().uuid().safeParse(id).success) return Response.json({ error: "invalid_input" }, { status: 422 });
  try {
    if (match[2] === "messages" && request.method === "GET") {
      return Response.json({ messages: messages(db, id) });
    }
    if (match[2] === "messages" && request.method === "POST") {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return Response.json({ error: "invalid_input" }, { status: 422 });
      }
      const parsed = NewMessage.safeParse(raw);
      if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 422 });
      const result = appendMessage(db, id, { text: parsed.data.text, clientRequestId: parsed.data.client_request_id });
      return Response.json({ message_id: result.messageId, run_id: result.runId }, { status: 202 });
    }
    if (match[2] === "runs" && request.method === "GET") {
      return Response.json({ runs: conversationRuns(db, id) });
    }
  } catch (error) {
    if (error instanceof ConversationError) {
      return Response.json({ error: "conversation_not_found" }, { status: 404 });
    }
    throw error;
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

export { getRun };
