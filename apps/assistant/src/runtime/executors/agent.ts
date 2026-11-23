import type { Database } from "bun:sqlite";
import { complete, billedMicroUsd, estimateMicroUsd, type ChatMessage, type Pricing, type ProviderOptions } from "../../agents/provider";
import type { ToolRegistry } from "../../agents/tools";
import { ToolDenied } from "../../agents/tools";
import { BudgetError, monthBucket, reserve, settle } from "../budget";
import { getRun, RunConflict } from "../queue";

export type AgentOutcome = {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly output: string;
  readonly steps: number;
  readonly toolCalls: readonly { readonly name: string; readonly ok: boolean }[];
  readonly reason?: string;
};

export type AgentInput = {
  readonly runId: string;
  readonly goal: string;
  readonly scopes: readonly string[];
  readonly systemPrompt?: string;
  readonly maxSteps?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly limitMicroUsd: number;
  readonly timeZone: string;
  readonly epoch?: () => number;
};

const MAX_TOOL_CALLS = 8;

export async function runAgent(
  db: Database,
  provider: ProviderOptions,
  registry: ToolRegistry,
  input: AgentInput,
  now = () => Date.now(),
): Promise<AgentOutcome> {
  const startEpoch = input.epoch?.();
  const maxSteps = input.maxSteps ?? 6;
  const maxOutputTokens = input.maxOutputTokens ?? 1_024;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const messages: ChatMessage[] = [
    ...(input.systemPrompt ? [{ role: "system" as const, content: input.systemPrompt }] : []),
    { role: "user", content: input.goal },
  ];
  const calls: { readonly name: string; readonly ok: boolean }[] = [];

  for (let step = 1; step <= maxSteps; step++) {
    if (getRun(db, input.runId).status === "cancelled") {
      return { status: "cancelled", output: "", steps: step - 1, toolCalls: calls, reason: "cancelled" };
    }
    const promptChars = messages.reduce((total, message) => total + message.content.length, 0);
    const estimate = estimateMicroUsd(promptChars, maxOutputTokens, provider.pricing);
    const reservation = reserve(db, {
      runId: input.runId,
      providerRequestId: `${input.runId}:${step}`,
      bucket: monthBucket(now(), input.timeZone),
      priceVersion: provider.pricing.version,
      estimateMicroUsd: Math.max(estimate, 1),
      limitMicroUsd: input.limitMicroUsd,
    });

    let completion;
    try {
      completion = await complete(provider, messages, registry.freeform(), { maxOutputTokens, timeoutMs });
    } catch (error) {
      settle(db, reservation.id, null, now());
      if (error instanceof Error) {
        return { status: "failed", output: "", steps: step, toolCalls: calls, reason: error.message };
      }
      throw error;
    }
    settle(db, reservation.id, billedMicroUsd(completion, provider.pricing), now());

    const message = completion.choices[0]?.message;
    if (!message) return { status: "failed", output: "", steps: step, toolCalls: calls, reason: "malformed" };
    const requested = message.tool_calls ?? [];
    if (requested.length === 0) {
      if (input.epoch !== undefined && startEpoch !== undefined && input.epoch() !== startEpoch) {
        return { status: "failed", output: "", steps: step, toolCalls: calls, reason: "context_changed" };
      }
      return { status: "succeeded", output: message.content ?? "", steps: step, toolCalls: calls };
    }
    messages.push({ role: "assistant", content: message.content ?? "" });
    for (const call of requested) {
      if (calls.length >= MAX_TOOL_CALLS) {
        return { status: "failed", output: "", steps: step, toolCalls: calls, reason: "tool_call_limit" };
      }
      let result: string;
      try {
        result = await registry.run(call.name, call.arguments, { runId: input.runId, scopes: input.scopes });
        calls.push({ name: call.name, ok: true });
      } catch (error) {
        if (error instanceof ToolDenied) {
          calls.push({ name: call.name, ok: false });
          result = `tool_error: ${error.kind}`;
        } else if (error instanceof RunConflict) {
          throw error;
        } else {
          throw error;
        }
      }
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
    }
  }
  return { status: "failed", output: "", steps: maxSteps, toolCalls: calls, reason: "step_limit" };
}

export { BudgetError };
