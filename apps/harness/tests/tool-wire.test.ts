import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { createSession } from "../src/core/sessions";
import { runTurn } from "../src/surfaces/conversation/loop";
import { enqueueRun, claimNext, executeRun } from "../src/surfaces/work/runner";
import { createRegistry } from "../src/tools/registry";
import { openAiStream } from "../src/providers/openai";
import { z } from "zod";

const RequestBody = z.object({ messages: z.array(z.object({
  role: z.string(), content: z.string(), tool_call_id: z.string().optional(), toolCallId: z.string().optional(),
  tool_calls: z.array(z.object({ id: z.string(), type: z.literal("function"), function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
})) });

test("conversation and work send a valid assistant/tool round-trip over HTTP", async () => {
  for (const surface of ["conversation", "work"] as const) {
    const db = new Database(":memory:");
    migrate(db);
    const events = new EventLog(db);
    let requests = 0;
    let effects = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests++;
        const parsed = RequestBody.safeParse(await request.json());
        if (!parsed.success) return new Response("invalid request", { status: 400 });
        const body = parsed.data;
        if (requests === 1) {
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-wire", type: "function", function: { name: "echo", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        }
        const assistant = body.messages.find((message) => message.tool_calls);
        const result = body.messages.find((message) => message.role === "tool");
        if (!assistant || assistant.tool_calls?.[0]?.id !== "call-wire" || result?.tool_call_id !== "call-wire" || result.content !== "real tool result" || result.toolCallId !== undefined) {
          return new Response("invalid tool protocol", { status: 400 });
        }
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "finished" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      },
    });
    try {
      const stream = openAiStream({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "test", model: "test" });
      const tools = createRegistry([{ name: "echo", description: "echo", parameters: {}, action: "read", execute: async () => { effects++; return "real tool result"; } }]);
      if (surface === "conversation") {
        const session = createSession(db, "wire");
        expect((await runTurn({ db, events, stream, tools }, { sessionId: session.id, text: "use echo" })).status).toBe("succeeded");
      } else {
        enqueueRun(db, events, { goal: "use echo" });
        const run = claimNext(db, events, "worker");
        if (!run) throw new Error("fixture");
        expect(await executeRun({ db, events, stream, tools, policy: [{ action: "*", resource: "*", effect: "allow" }] }, run)).toBe("succeeded");
      }
      expect(effects).toBe(1);
      expect(requests).toBe(2);
    } finally { await server.stop(true); db.close(); }
  }
});
