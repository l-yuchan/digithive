import type { WorkDeps } from "../surfaces/work/runner";
import { syncEnabledSources, type SyncSourcesDeps } from "../integrations/sync";
import { runBriefing } from "./compose";
import { getAccount } from "../integrations/accounts";
import { sendPush, type PushConfig } from "./push";

type BuiltinDeps = SyncSourcesDeps & { readonly push: PushConfig };

/** Scheduler and manual work share the same domain operations and cancellation. */
export function createBuiltinExecutor(deps: BuiltinDeps): NonNullable<WorkDeps["scriptExecutor"]> {
  return async (executor, context) => {
    context.signal.throwIfAborted();
    const scopedFetch = (implementation: typeof fetch): typeof fetch =>
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          implementation(input, { ...init, signal: context.signal }),
        { preconnect: implementation.preconnect },
      );
    switch (executor.name) {
      case "sync_sources": {
        const outcomes = await syncEnabledSources(
          {
            google: { ...deps.google, fetchImpl: scopedFetch(deps.google.fetchImpl ?? fetch) },
            canvas: { ...deps.canvas, fetchImpl: scopedFetch(deps.canvas.fetchImpl ?? fetch) },
          },
          executor.accountId,
        );
        context.signal.throwIfAborted();
        const output = JSON.stringify({ outcomes });
        if (outcomes.some((outcome) => !outcome.ok && !outcome.skipped)) throw new Error(output);
        return output;
      }
      case "briefing": {
        if (executor.accountId && !getAccount(deps.google.db, executor.accountId)) {
          throw new Error("account_not_found");
        }
        const result = await runBriefing(
          {
            db: deps.google.db,
            events: deps.google.events,
            runId: context.runId,
            ...(executor.accountId ? { accountId: executor.accountId } : {}),
            push: async (payload) => {
              context.signal.throwIfAborted();
              const outcome = await sendPush(deps.google.db, deps.push, payload);
              return outcome.sent > 0
                ? { ok: true }
                : { ok: false, error: outcome.errors.join(",") || "no_device" };
            },
          },
          true,
        );
        context.signal.throwIfAborted();
        return JSON.stringify(result);
      }
      default: {
        const unexpected: never = executor.name;
        throw new Error(`Unknown builtin: ${String(unexpected)}`);
      }
    }
  };
}
