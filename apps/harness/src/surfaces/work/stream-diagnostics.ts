import type { WorkDeps } from "./runner";
import type { AdapterEvent, ChatMessage, StreamOptions, ToolSpec } from "../../providers/openai";
import type { ProviderDiagnostic } from "../../providers/router";

/**
 * Model calls inside a work run, with every routing decision appended to the run's
 * own event stream. The run view already reads that stream, so a fallback or an
 * exhausted route explains itself where the owner looks, and the worker prints it.
 */
export async function* runStream(
  deps: WorkDeps,
  run: { readonly id: string; readonly sessionId: string | null },
  messages: readonly ChatMessage[],
  tools: readonly ToolSpec[],
  options: StreamOptions,
  now: () => number,
): AsyncIterable<AdapterEvent> {
  const report = (diagnostic: ProviderDiagnostic): void => {
    deps.events.append({
      kind: diagnostic.kind === "provider.fallback" ? "provider.fallback" : diagnostic.kind,
      runId: run.id,
      sessionId: run.sessionId,
      payload: {
        level: diagnostic.kind === "provider.exhausted" ? "error" : "warning",
        decision: diagnostic.kind,
        provider: diagnostic.provider,
        model: diagnostic.model,
        failedProvider: diagnostic.failedProvider,
        reason: diagnostic.reason,
        retryInMs: diagnostic.retryInMs,
        error: diagnostic.error,
      },
      now: now(),
    });
    deps.streamDiagnostics?.([diagnostic]);
  };
  for await (const event of deps.stream(messages, tools, { ...options, onDiagnostic: report })) {
    yield event;
  }
}
