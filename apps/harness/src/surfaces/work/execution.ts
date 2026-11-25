import { WORK_LIMITS, type WorkDeps } from "./runner";
import type { RunRow } from "./record";
import { keepLease } from "./lease";
import { RunExecutorSchema } from "../../core/executor";
import { executeAgent } from "./agent-run";
import { executeNonAgent } from "./executor-branch";
import { dbCancelled, type RunOutcome } from "./settle";

/**
 * Runs one claimed run under a renewed lease. Agent runs stream; builtin and
 * script runs share the same cancellation, timeout and settlement path.
 *
 * `extra` is for inline workflow calls: the child borrows the caller's abort
 * signal and a matching budget instead of owning a queue slot of its own.
 */
export async function executeRun(
  deps: WorkDeps,
  run: RunRow,
  extra?: { readonly signal?: AbortSignal; readonly totalMs?: number },
): Promise<RunOutcome> {
  const now = () => (deps.now ?? Date.now)();
  const limits = deps.limits ?? WORK_LIMITS;
  const executor = RunExecutorSchema.parse(
    JSON.parse(run.executorJson.length > 0 ? run.executorJson : '{"kind":"agent"}'),
  );
  const totalMs = Math.min(
    run.timeoutSeconds * 1_000,
    deps.limits?.totalMs ?? Infinity,
    extra?.totalMs ?? Infinity,
  );
  const lease = keepLease(deps.db, deps.events, run, deps.leaseMs ?? 45_000, totalMs, now);
  const cancelPoll = setInterval(() => {
    if (dbCancelled(deps.db, run.id)) lease.abort(new Error("run_cancelled"));
  }, 200);
  const onShutdown = () => lease.abort(new Error("host_restart"));
  const onCallerAbort = () =>
    lease.abort(
      extra?.signal?.reason instanceof Error ? extra.signal.reason : new Error("inline_cancelled"),
    );
  if (deps.shutdownSignal) {
    if (deps.shutdownSignal.aborted) onShutdown();
    else deps.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  }
  if (extra?.signal) {
    if (extra.signal.aborted) onCallerAbort();
    else extra.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  try {
    if (executor.kind !== "agent") return await executeNonAgent(deps, run, executor, lease, now());
    return await executeAgent(deps, run, lease, now, limits);
  } finally {
    deps.shutdownSignal?.removeEventListener("abort", onShutdown);
    extra?.signal?.removeEventListener("abort", onCallerAbort);
    clearInterval(cancelPoll);
    lease.close();
  }
}
