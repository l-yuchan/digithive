export type ProviderConfig = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** Extra request headers some gateways require (e.g. a session header). */
  readonly headers?: Readonly<Record<string, string>>;
};

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export type ToolSpec = {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
};

export type AdapterEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "reasoning_delta"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | { readonly type: "usage"; readonly promptTokens: number; readonly completionTokens: number }
  | { readonly type: "done"; readonly finishReason: string | null };

export type ProviderErrorKind =
  | "http_4xx"
  | "http_5xx"
  | "rate_limited"
  | "auth_expired"
  | "timeout"
  | "malformed"
  | "truncated"
  | "aborted";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly status?: number,
  ) {
    super(kind);
    this.name = "ProviderError";
  }
}

export type StreamOptions = {
  readonly maxOutputTokens: number;
  readonly firstTokenTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
};

export type StreamFn = (
  messages: readonly ChatMessage[],
  tools: readonly ToolSpec[],
  options: StreamOptions,
) => AsyncIterable<AdapterEvent>;

function classifyStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth_expired";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "http_5xx";
  return "http_4xx";
}

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type ToolCallAccumulator = { id: string; name: string; arguments: string };
const StreamFrameSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning_content: z.string().nullish(),
            reasoning: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().optional(),
                  id: z.string().optional(),
                  function: z
                    .object({ name: z.string().optional(), arguments: z.string().optional() })
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
});

/**
 * OpenAI-compatible streaming adapter. Emits deltas in arrival order, assembles
 * streamed tool-call fragments into one `tool_call` event, and turns a
 * `finish_reason: "length"` response into a `truncated` error rather than a
 * silent partial answer.
 */
export function openAiStream(config: ProviderConfig): StreamFn {
  return async function* stream(messages, tools, options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const firstTokenDeadline = setTimeout(
      () => controller.abort(new ProviderError("timeout")),
      options.firstTokenTimeoutMs,
    );
    const onAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(firstTokenDeadline);
        throw new ProviderError("aborted");
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          ...config.headers,
        },
        body: JSON.stringify({
          model: config.model,
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
            ...(message.toolCalls
              ? {
                  tool_calls: message.toolCalls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }
              : {}),
          })),
          stream: true,
          max_tokens: options.maxOutputTokens,
          ...(tools.length === 0
            ? {}
            : {
                tools: tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
                tool_choice: "auto",
              }),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new ProviderError(classifyStatus(response.status), response.status);
      if (!response.body) throw new ProviderError("malformed");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const calls = new Map<number, ToolCallAccumulator>();
      let buffer = "";
      let finishReason: string | null = null;
      let sawFirst = false;

      while (true) {
        const next = await readWithTimeout(
          reader,
          sawFirst ? options.idleTimeoutMs : options.firstTokenTimeoutMs,
        );
        if (next.done) break;
        clearTimeout(firstTokenDeadline);
        sawFirst = true;
        buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, "\n");

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              finishReason = finishReason ?? "stop";
              continue;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
              throw new ProviderError("malformed");
            }
            const envelope = StreamFrameSchema.parse(parsed);
            const choice = envelope.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta ?? {};
            const text = delta["content"];
            if (typeof text === "string" && text.length > 0) {
              yield { type: "text_delta", text };
            }
            const reasoning = delta["reasoning_content"] ?? delta["reasoning"];
            if (typeof reasoning === "string" && reasoning.length > 0) {
              yield { type: "reasoning_delta", text: reasoning };
            }
            const toolCalls = delta["tool_calls"];
            if (Array.isArray(toolCalls)) {
              for (const raw of toolCalls) {
                const call = raw;
                const index = call.index ?? 0;
                const current = calls.get(index) ?? {
                  id: `call_${index}`,
                  name: "",
                  arguments: "",
                };
                if (call.id) current.id = call.id;
                if (call.function?.name) current.name += call.function.name;
                if (call.function?.arguments) current.arguments += call.function.arguments;
                calls.set(index, current);
              }
            }
            const usage = envelope.usage;
            if (
              usage &&
              typeof usage.prompt_tokens === "number" &&
              typeof usage.completion_tokens === "number"
            ) {
              yield {
                type: "usage",
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
              };
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }

      if (finishReason === "length") throw new ProviderError("truncated");
      if (finishReason === null) throw new ProviderError("truncated");
      for (const call of calls.values()) {
        yield { type: "tool_call", id: call.id, name: call.name, arguments: call.arguments };
      }
      yield { type: "done", finishReason };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.reason instanceof ProviderError) throw controller.signal.reason;
      if (options.signal?.aborted || controller.signal.aborted) throw new ProviderError("aborted");
      if (error instanceof Error && error.name === "AbortError") throw new ProviderError("aborted");
      throw new ProviderError("malformed");
    } finally {
      clearTimeout(firstTokenDeadline);
      controller.abort();
      options.signal?.removeEventListener("abort", onAbort);
    }
  };
}
import { z } from "zod";
import type { ChatMessageSchema } from "../core/contracts";
