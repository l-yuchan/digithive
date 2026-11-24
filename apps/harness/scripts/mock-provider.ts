/**
 * Serves an OpenAI-compatible streaming endpoint for local verification.
 * Deterministic, offline, and free: the QA path never calls a paid model.
 *
 * Modes, chosen by the last user message:
 *   contains "파일"  -> tool_call workspace_write, then a final text on the next request
 *   contains "메일"  -> tool_call external_action (approval path), then final text
 *   otherwise        -> plain streamed echo
 */
const PORT = Number(process.env["MOCK_PORT"] ?? "8798");
const DELAY_MS = Number(process.env["MOCK_DELAY_MS"] ?? "0");

const encoder = new TextEncoder();
const frame = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

function sse(parts: string[], finish = "stop"): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(frame({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }));
      for (const part of parts) {
        controller.enqueue(frame({ choices: [{ delta: { content: part }, finish_reason: null }] }));
        await Bun.sleep(15);
      }
      controller.enqueue(frame({ choices: [{ delta: {}, finish_reason: finish }] }));
      controller.enqueue(frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: parts.length } }));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

function toolCall(name: string, args: Record<string, unknown>): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(frame({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }));
      controller.enqueue(
        frame({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: `call_${crypto.randomUUID().slice(0, 8)}`, function: { name, arguments: JSON.stringify(args) } }] },
              finish_reason: null,
            },
          ],
        }),
      );
      controller.enqueue(frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const body = (await request.json()) as { messages?: { role: string; content: string }[] };
    const capture = process.env["MOCK_CAPTURE"];
    if (capture) await Bun.write(capture, JSON.stringify({ at: new Date().toISOString(), messages: body.messages ?? [] }, null, 1));
    if (DELAY_MS > 0) await Bun.sleep(DELAY_MS);

    const messages = body.messages ?? [];
    const last = [...messages].reverse().find((message) => message.role === "user");
    const prompt = last?.content ?? "";
    const hasToolResult = messages.some((message) => message.role === "tool");

    if (!hasToolResult && prompt.includes("파일")) {
      return toolCall("workspace_write", { path: "note.txt", text: `요약: ${prompt.slice(0, 80)}` });
    }
    if (!hasToolResult && prompt.includes("메일")) {
      return toolCall("external_action", { summary: `메일 발송: ${prompt.slice(0, 40)}` });
    }
    const reply = `요청을 받았습니다: ${prompt.slice(0, 60)}. 스트리밍 응답입니다.`;
    return sse(Array.from(reply));
  },
});

console.log(`mock provider on http://127.0.0.1:${server.port}/v1 (delay ${DELAY_MS}ms)`);
