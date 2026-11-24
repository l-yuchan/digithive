/**
 * Serves an OpenAI-compatible streaming endpoint for local verification.
 * Deterministic, offline, and free: the QA path never calls a paid model.
 */
const PORT = Number(process.env["MOCK_PORT"] ?? "8798");

const encoder = new TextEncoder();

function frame(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseResponse(parts: string[], finish = "stop"): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        frame({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }),
      );
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

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const body = (await request.json()) as { messages?: { role: string; content: string }[] };
    const capture = process.env["MOCK_CAPTURE"];
    if (capture) {
      await Bun.write(capture, JSON.stringify({ at: new Date().toISOString(), messages: body.messages ?? [] }, null, 1));
    }
    const last = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
    const prompt = last?.content ?? "";
    const reply = `요청을 받았습니다: ${prompt.slice(0, 60)}. 스트리밍 응답입니다.`;
    return sseResponse(Array.from(reply));
  },
});

console.log(`mock provider on http://127.0.0.1:${server.port}/v1`);
