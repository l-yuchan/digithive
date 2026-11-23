import type { Database } from "bun:sqlite";
import { z } from "zod";
import { cancel, enqueue, eventsAfter, getRun, RunConflict } from "../../runtime/queue";

const NewRun = z.object({
  goal: z.string().min(1).max(4096),
  client_request_id: z.string().uuid(),
  executor: z.literal("sha256"),
}).strict();

export async function runsRoute(db: Database, request: Request, path: string): Promise<Response> {
  if (path === "/api/runs" && request.method === "POST") {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return Response.json({ error: "invalid_input" }, { status: 422 });
    }
    const input = NewRun.safeParse(raw);
    if (!input.success) return Response.json({ error: "invalid_input" }, { status: 422 });
    const run = enqueue(db, {
      requestKey: input.data.client_request_id,
      goal: input.data.goal,
      executor: input.data.executor,
    });
    return Response.json({ id: run.id, status: run.status }, { status: 202 });
  }
  const match = /^\/api\/runs\/([^/]+)(?:\/(events|cancel))?$/.exec(path);
  if (!match) return Response.json({ error: "not_found" }, { status: 404 });
  const id = match[1];
  if (!id || !z.string().uuid().safeParse(id).success) {
    return Response.json({ error: "invalid_input" }, { status: 422 });
  }
  try {
    if (match[2] === "cancel" && request.method === "POST") {
      return cancel(db, id)
        ? Response.json({ id, status: "cancelled" })
        : Response.json({ error: "run_not_cancellable" }, { status: 409 });
    }
    if (match[2] === "events" && request.method === "GET") {
      const rawAfter = new URL(request.url).searchParams.get("after") ?? "0";
      const after = z.coerce.number().int().nonnegative().safeParse(rawAfter);
      if (!after.success) return Response.json({ error: "invalid_input" }, { status: 422 });
      const events = eventsAfter(db, id, after.data);
      const body = events.map((event) =>
        `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event.payload)}\n\n`).join("");
      return new Response(body, {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (match[2] === undefined && request.method === "GET") {
      return Response.json(getRun(db, id));
    }
  } catch (error) {
    if (error instanceof RunConflict && error.kind === "missing") {
      return Response.json({ error: "run_not_found" }, { status: 404 });
    }
    throw error;
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}
