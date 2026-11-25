import { describe, expect, test } from "bun:test";
import type { AdapterEvent } from "../src/providers/openai";
import { ProviderError } from "../src/providers/errors";
import {
  createRoutingStream,
  type ProviderDiagnostic,
  type ProviderRouteConfig,
} from "../src/providers/router";

type Reply = Response | (() => Response) | Error;

/** A fetch that plays one scripted reply per call and records the route it served. */
function transport(...replies: Reply[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let cursor = 0;
  const fetchImpl: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const reply = replies[Math.min(cursor, replies.length - 1)];
      cursor += 1;
      if (reply === undefined) throw new Error("no scripted reply");
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply() : reply;
    },
    { preconnect: fetch.preconnect },
  );
  return { fetchImpl, calls };
}

function sse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status, headers: { "content-type": "text/event-stream" } },
  );
}

function answer(text: string): Response {
  return sse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ]);
}

function quotaBody(message: string): Response {
  return new Response(
    JSON.stringify({ type: "GoUsageLimitError", message, error: { message, type: "usage_limit" } }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

function route(name: string): ProviderRouteConfig {
  return { name, baseUrl: `http://${name}/v1`, apiKey: "k", model: `${name}-model` };
}

/** The adapter only uses `options.fetchImpl`; the routes share one scripted transport. */
const options = (fetchImpl?: typeof fetch) => ({
  maxOutputTokens: 100,
  firstTokenTimeoutMs: 1_000,
  idleTimeoutMs: 1_000,
  ...(fetchImpl === undefined ? {} : { fetchImpl }),
});

async function collect(iterable: AsyncIterable<AdapterEvent>): Promise<string> {
  let text = "";
  for await (const event of iterable) if (event.type === "text_delta") text += event.text;
  return text;
}

function routed(routes: ProviderRouteConfig[], fetchImpl: typeof fetch, clock = () => 0) {
  const [primary, ...fallbacks] = routes;
  if (!primary) throw new Error("a routing test needs at least one route");
  const diagnostics: ProviderDiagnostic[] = [];
  const stream = createRoutingStream(
    { primary, fallbacks },
    {
      now: clock,
      sleep: async () => {},
      retryDelayMs: 0,
      fetchImplOverride: fetchImpl,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  );
  return { stream, diagnostics };
}

describe("provider routing", () => {
  test("quota on the primary falls back once with the upstream reason kept", async () => {
    const { fetchImpl, calls } = transport(
      quotaBody("OpenCode Go usage limit reached (5-hour, resets in 31m)"),
      answer("대체 경로 응답"),
    );
    const { stream, diagnostics } = routed([route("primary"), route("backup")], fetchImpl);
    const text = await collect(stream([{ role: "user", content: "hi" }], [], options(fetchImpl)));
    expect(text).toBe("대체 경로 응답");
    expect(calls.map((url) => new URL(url).host)).toEqual(["primary", "backup"]);
    const fallback = diagnostics.find((diagnostic) => diagnostic.kind === "provider.fallback");
    expect(fallback).toMatchObject({ failedProvider: "primary", provider: "backup" });
    expect(fallback?.error).toContain("resets in 31m");
  });

  test("a context keeps the provider it settled on, so one context stays on one route", async () => {
    const { fetchImpl, calls } = transport(
      quotaBody("usage limit reached"),
      answer("첫 답"),
      answer("둘째 답"),
      answer("셋째 답"),
    );
    const { stream } = routed([route("primary"), route("backup")], fetchImpl);
    const run = (text: string) =>
      collect(
        stream([{ role: "user", content: text }], [], { ...options(fetchImpl), contextKey: "s-1" }),
      );
    expect(await run("a")).toBe("첫 답");
    expect(await run("b")).toBe("둘째 답");
    expect(await run("c")).toBe("셋째 답");
    expect(calls.map((url) => new URL(url).host)).toEqual([
      "primary",
      "backup",
      "backup",
      "backup",
    ]);
  });

  test("a transient failure retries the same route before any fallback", async () => {
    const { fetchImpl, calls } = transport(new Error("socket hang up"), answer("재시도 성공"));
    const { stream, diagnostics } = routed([route("primary"), route("backup")], fetchImpl);
    expect(await collect(stream([], [], options(fetchImpl)))).toBe("재시도 성공");
    expect(calls.map((url) => new URL(url).host)).toEqual(["primary", "primary"]);
    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["provider.retry"]);
  });

  test("a quota route stays out of rotation until its cooldown ends", async () => {
    let now = 0;
    const { fetchImpl, calls } = transport(
      quotaBody("usage limit reached"),
      answer("백업"),
      answer("백업 유지"),
      answer("프라이머리 복귀"),
    );
    const { stream } = routed([route("primary"), route("backup")], fetchImpl, () => now);
    const run = (key: string) =>
      collect(stream([], [], { ...options(fetchImpl), contextKey: key }));
    expect(await run("s-1")).toBe("백업");
    now = 60_000;
    expect(await run("s-2")).toBe("백업 유지");
    now = 16 * 60_000;
    expect(await run("s-3")).toBe("프라이머리 복귀");
    expect(calls.map((url) => new URL(url).host)).toEqual([
      "primary",
      "backup",
      "backup",
      "primary",
    ]);
  });

  test("exhausting every route is one detailed error, never an empty answer", async () => {
    const { fetchImpl } = transport(quotaBody("usage limit A"), quotaBody("usage limit B"));
    const { stream } = routed([route("primary"), route("backup")], fetchImpl);
    const failure = collect(stream([], [], options(fetchImpl)));
    expect(failure).rejects.toThrow(/usage limit A[\s\S]*usage limit B/);
    expect(failure).rejects.toMatchObject({ kind: "quota_exhausted" });
  });

  test("output already streamed is never replayed on another route", async () => {
    const stream: typeof fetch = Object.assign(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "부분" } }] })}\n\n`,
                ),
              );
              controller.error(new Error("connection reset"));
            },
          }),
        ),
      { preconnect: fetch.preconnect },
    );
    const { stream: routedStream } = routed([route("primary"), route("backup")], stream);
    const failure = collect(routedStream([], [], options(stream)));
    expect(failure).rejects.toThrow(/connection reset/);
    expect(failure).rejects.toBeInstanceOf(ProviderError);
  });

  test("cancellation is not retried or rerouted", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = transport(() => {
      controller.abort();
      return sse([]);
    });
    const { stream } = routed([route("primary"), route("backup")], fetchImpl);
    const failure = collect(stream([], [], { ...options(fetchImpl), signal: controller.signal }));
    expect(failure).rejects.toThrow(/aborted/);
    expect(failure).rejects.toMatchObject({ kind: "aborted" });
    expect(calls).toHaveLength(1);
  });
});

describe("openai adapter error detail", () => {
  test("an HTTP 200 JSON error envelope is a quota failure, not an empty success", async () => {
    const { openAiStream } = await import("../src/providers/openai");
    const { fetchImpl } = transport(
      new Response(
        JSON.stringify({ error: { message: "usage limit reached", type: "GoUsageLimitError" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const config = { baseUrl: "http://x/v1", apiKey: "k", model: "m" };
    const failure = collect(openAiStream(config)([], [], options(fetchImpl)));
    expect(failure).rejects.toMatchObject({
      kind: "quota_exhausted",
      detail: "GoUsageLimitError usage limit reached",
    });
  });

  test("a stream that ends with no content is empty_output, not a blank answer", async () => {
    const { openAiStream } = await import("../src/providers/openai");
    const { fetchImpl } = transport(
      sse([
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );
    const config = { baseUrl: "http://x/v1", apiKey: "k", model: "m" };
    const failure = collect(openAiStream(config)([], [], options(fetchImpl)));
    expect(failure).rejects.toMatchObject({ kind: "empty_output" });
  });
});
