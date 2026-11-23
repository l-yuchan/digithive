import ky, { HTTPError, TimeoutError } from "ky";
import { z } from "zod";

export const ToolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

const Completion = z.object({
  choices: z.array(z.object({
    message: z.object({
      role: z.string().optional(),
      content: z.string().nullable().optional(),
      tool_calls: z.array(ToolCall).optional(),
    }),
    finish_reason: z.string().nullable().optional(),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().nonnegative(),
    completion_tokens: z.number().nonnegative(),
  }).optional(),
});
export type Completion = z.infer<typeof Completion>;

export type ChatMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly tool_call_id?: string;
};

export const Pricing = z.object({
  version: z.string().min(1),
  inputMicroUsdPerToken: z.number().nonnegative(),
  outputMicroUsdPerToken: z.number().nonnegative(),
});
export type Pricing = z.infer<typeof Pricing>;

export class ProviderError extends Error {
  constructor(readonly kind: "http" | "timeout" | "malformed" | "truncated") {
    super(kind);
    this.name = "ProviderError";
  }
}

export type ProviderOptions = {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly pricing: Pricing;
};

export function estimateMicroUsd(promptChars: number, maxOutputTokens: number, pricing: Pricing): number {
  const inputTokens = Math.ceil(promptChars / 3);
  return inputTokens * pricing.inputMicroUsdPerToken + maxOutputTokens * pricing.outputMicroUsdPerToken;
}

export function billedMicroUsd(completion: Completion, pricing: Pricing): number | null {
  if (!completion.usage) return null;
  return completion.usage.prompt_tokens * pricing.inputMicroUsdPerToken +
    completion.usage.completion_tokens * pricing.outputMicroUsdPerToken;
}

/**
 * OpenAI-compatible Chat Completions adapter. Tool calls are only returned to
 * the caller; nothing is executed here. A truncated response is an error, not
 * a partial success, so the caller can keep the charge as unknown.
 */
export async function complete(
  options: ProviderOptions,
  messages: readonly ChatMessage[],
  tools: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[],
  limits: { readonly maxOutputTokens: number; readonly timeoutMs: number },
): Promise<Completion> {
  const client = ky.create({
    prefix: `${options.baseUrl.replace(/\/+$/, "")}/`,
    timeout: limits.timeoutMs,
    retry: 0,
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
  });
  let payload: unknown;
  try {
    payload = await client.post("chat/completions", {
      json: {
        model: options.model,
        messages,
        max_tokens: limits.maxOutputTokens,
        stream: false,
        ...(tools.length === 0 ? {} : {
          tools: tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
          tool_choice: "auto",
        }),
      },
    }).json();
  } catch (error) {
    if (error instanceof TimeoutError) throw new ProviderError("timeout");
    if (error instanceof HTTPError) throw new ProviderError("http");
    throw error;
  }
  const parsed = Completion.safeParse(payload);
  if (!parsed.success) throw new ProviderError("malformed");
  const choice = parsed.data.choices[0];
  if (!choice) throw new ProviderError("malformed");
  if (choice.finish_reason === "length") throw new ProviderError("truncated");
  return parsed.data;
}
