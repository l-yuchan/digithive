import { describe, expect, test } from "bun:test";
import { ProviderError, openAiStream, type AdapterEvent } from "../src/providers/openai";

function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
}

const config = { baseUrl: "http://mock/v1", apiKey: "k", model: "m" };

async function collect(iterable: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

const options = { maxOutputTokens: 100, firstTokenTimeoutMs: 5_000, idleTimeoutMs: 5_000 };

describe("openai streaming adapter", () => {
  test("emits text deltas in arrival order and a done event", async () => {
    const frames = [chunk({ content: "안" }), chunk({ content: "녕" }), chunk({}, "stop"), "data: [DONE]\n\n"];
    const events = await collect(
      openAiStream(config)([{ role: "user", content: "hi" }], [], {
        ...options,
        fetchImpl: Object.assign((async () => sseResponse(frames)), { preconnect: fetch.preconnect }),
      }),
    );
    expect(events.filter((event) => event.type === "text_delta").map((event) => (event as { text: string }).text)).toEqual(["안", "녕"]);
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  test("assembles streamed tool-call fragments into one call", async () => {
    const frames = [
      chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "echo", arguments: '{"te' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'xt":"hi"}' } }] }),
      chunk({}, "tool_calls"),
      "data: [DONE]\n\n",
    ];
    const events = await collect(
      openAiStream(config)([{ role: "user", content: "hi" }], [], { ...options, fetchImpl: Object.assign((async () => sseResponse(frames)), { preconnect: fetch.preconnect }) }),
    );
    const call = events.find((event) => event.type === "tool_call");
    expect(call).toEqual({ type: "tool_call", id: "call_a", name: "echo", arguments: '{"text":"hi"}' });
  });

  test("finish_reason length is a truncated error, not a partial success", async () => {
    const frames = [chunk({ content: "반" }), chunk({}, "length"), "data: [DONE]\n\n"];
    const failure = collect(
      openAiStream(config)([{ role: "user", content: "hi" }], [], { ...options, fetchImpl: Object.assign((async () => sseResponse(frames)), { preconnect: fetch.preconnect }) }),
    );
    await Promise.resolve(expect(failure).rejects.toMatchObject({ kind: "truncated" }));
  });

  for (const [status, kind] of [
    [429, "rate_limited"],
    [401, "auth_expired"],
    [503, "http_5xx"],
    [400, "http_4xx"],
  ] as const) {
    test(`HTTP ${status} is classified as ${kind}`, async () => {
      const failure = collect(
        openAiStream(config)([{ role: "user", content: "hi" }], [], { ...options, fetchImpl: Object.assign((async () => sseResponse([], status)), { preconnect: fetch.preconnect }) }),
      );
      await Promise.resolve(expect(failure).rejects.toMatchObject({ kind }));
    });
  }

  test("an already-aborted signal fails fast without a request", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const failure = collect(
      openAiStream(config)([{ role: "user", content: "hi" }], [], {
        ...options,
        signal: controller.signal,
        fetchImpl: Object.assign((async () => {
          called = true;
          return sseResponse([]);
        }), { preconnect: fetch.preconnect }),
      }),
    );
    await Promise.resolve(expect(failure).rejects.toBeInstanceOf(ProviderError));
    expect(called).toBe(false);
  });
});

test("transport EOF before a finish marker rejects partial text and unfinished tool calls", async () => {
  for (const delta of [{ content: "partial" }, { tool_calls: [{ index: 0, id: "c", function: { name: "echo", arguments: '{"x":' } }] }]) {
    const fetchImpl: typeof fetch = Object.assign(async () => sseResponse([chunk(delta)]), { preconnect: fetch.preconnect });
    await Promise.resolve(expect(collect(openAiStream(config)([], [], { ...options, fetchImpl }))).rejects.toMatchObject({ kind: "truncated" }));
  }
});

test("UTF-8 and CRLF frames survive byte-by-byte network fragmentation", async () => {
  const bytes = new TextEncoder().encode((chunk({ content: "한글" }) + chunk({}, "stop") + "data: [DONE]\n\n").replaceAll("\n", "\r\n"));
  const fetchImpl: typeof fetch = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
  })), { preconnect: fetch.preconnect });
  const events = await collect(openAiStream(config)([], [], { ...options, fetchImpl }));
  expect(events).toEqual([{ type: "text_delta", text: "한글" }, { type: "done", finishReason: "stop" }]);
});

test("first-token deadline includes time waiting for HTTP response headers", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({ port: 0, async fetch() { await gate; return sseResponse([chunk({ content: "late" }), chunk({}, "stop")]); } });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = collect(openAiStream({ ...config, baseUrl: `http://127.0.0.1:${server.port}` })([], [], { ...options, firstTokenTimeoutMs: 20 }));
    await Promise.resolve(expect(Promise.race([request, new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("deadline not enforced")), 300); })])).rejects.toMatchObject({ kind: "timeout" }));
  } finally { if (watchdog) clearTimeout(watchdog); release(); await server.stop(true); }
}, 1000);
