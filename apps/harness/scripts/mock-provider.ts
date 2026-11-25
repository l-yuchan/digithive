/**
 * Serves an OpenAI-compatible streaming endpoint for local verification.
 * Deterministic, offline, and free: the QA path never calls a paid model.
 *
 * Modes, chosen by the last user message:
 *   contains "파일"  -> tool_call workspace_write, then a final text on the next request
 *   contains "도구"  -> tool_call stored_file_list (a JSON result), then a final text
 *   contains "메일"  -> tool_call external_action (approval path), then final text
 *   contains "마크다운" -> a markdown answer with a table, a list, code and refused inputs
 *   looks like the app's naming instruction -> one JSON title ("긴" asks for a bad reply)
 *   otherwise        -> plain streamed echo
 */
import { z } from "zod";
const PORT = Number(process.env["MOCK_PORT"] ?? "8798");
const DELAY_MS = Number(process.env["MOCK_DELAY_MS"] ?? "0");

const encoder = new TextEncoder();
const frame = (payload: unknown): Uint8Array =>
  encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

function sse(parts: string[], finish = "stop", reasoning: string[] = []): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        frame({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }),
      );
      // Reasoning first, so a local run shows the thinking block before any text.
      for (const part of reasoning) {
        controller.enqueue(
          frame({ choices: [{ delta: { reasoning_content: part }, finish_reason: null }] }),
        );
        await Bun.sleep(15);
      }
      for (const part of parts) {
        controller.enqueue(frame({ choices: [{ delta: { content: part }, finish_reason: null }] }));
        await Bun.sleep(15);
      }
      controller.enqueue(frame({ choices: [{ delta: {}, finish_reason: finish }] }));
      controller.enqueue(
        frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: parts.length } }),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

function toolCall(name: string, args: Record<string, unknown>): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        frame({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }),
      );
      controller.enqueue(
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${crypto.randomUUID().slice(0, 8)}`,
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
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
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const body = z
      .object({ messages: z.array(z.object({ role: z.string(), content: z.string() })).optional() })
      .parse(await request.json());
    const capture = process.env["MOCK_CAPTURE"];
    if (capture)
      await Bun.write(
        capture,
        JSON.stringify({ at: new Date().toISOString(), messages: body.messages ?? [] }, null, 1),
      );
    if (DELAY_MS > 0) await Bun.sleep(DELAY_MS);

    const messages = body.messages ?? [];
    const last = messages.toReversed().find((message) => message.role === "user");
    const prompt = last?.content ?? "";
    const hasToolResult = messages.some((message) => message.role === "tool");

    if (!hasToolResult && prompt.includes("파일")) {
      return toolCall("workspace_write", {
        path: "note.txt",
        text: `요약: ${prompt.slice(0, 80)}`,
      });
    }
    // "도구" asks for a search-like tool whose result is JSON, the case the collapsible
    // card pretty-prints; the account list is a read tool with a JSON answer.
    if (!hasToolResult && prompt.includes("도구")) {
      return toolCall("stored_file_list", {});
    }
    if (!hasToolResult && prompt.includes("메일")) {
      return toolCall("external_action", { summary: `메일 발송: ${prompt.slice(0, 40)}` });
    }
    // A naming run is recognized by its instruction, so the app's auto-title path can be
    // exercised offline like any other conversation. "긴" asks for an unusable reply.
    if (prompt.includes("너는 대화에 붙일 이름을 짓는다")) {
      const reply = prompt.includes("긴")
        ? "이 답변은 제목이 아니라 문장입니다."
        : '{"title": "오프라인 모의 제목"}';
      return sse(Array.from(reply));
    }
    // "마크다운" asks for every construct the renderer must handle, including two inputs
    // it must refuse: raw HTML and a script URL.
    if (prompt.includes("마크다운")) {
      const reply = [
        "## 정리",
        "",
        "| 항목 | 값 |",
        "| --- | --- |",
        "| 상태 | 좋음 |",
        "",
        "- 첫째",
        "- 둘째",
        "",
        "`inline code` 그리고 [링크](https://example.com).",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "<script>alert(1)</script> 그리고 [위험](javascript:alert(1))",
      ].join("\n");
      return sse(Array.from(reply));
    }
    const reply = `요청을 받았습니다: ${prompt.slice(0, 60)}. 스트리밍 응답입니다.`;
    return sse(Array.from(reply), "stop", Array.from("이 요청에 무엇을 답할지 살펴보는 중입니다."));
  },
});

console.log(`mock provider on http://127.0.0.1:${server.port}/v1 (delay ${DELAY_MS}ms)`);
