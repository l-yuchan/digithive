import type { WorkDeps } from "./runner";
import type { RunRow } from "./record";
import type { keepLease } from "./lease";
import { ownsLease } from "./lease";
import type { RunExecutor } from "../../core/executor";
import { runScriptFile } from "./script";
import { abortMessage, dbCancelled, settle, type RunOutcome } from "./settle";

type Lease = ReturnType<typeof keepLease>;

function cancelledOutcome(
  deps: WorkDeps,
  run: RunRow,
  lease: Lease,
  now: number,
): RunOutcome | null {
  const reason = abortMessage(lease.signal);
  if (reason !== "run_cancelled" && !dbCancelled(deps.db, run.id)) return null;
  settle(deps.db, deps.events, run, "cancelled", { error: "cancelled" }, now);
  return "cancelled";
}

/** Builtin callbacks and confined local scripts share lease and settlement. */
export async function executeNonAgent(
  deps: WorkDeps,
  run: RunRow,
  executor: Exclude<RunExecutor, { kind: "agent" }>,
  lease: Lease,
  now: number,
): Promise<RunOutcome> {
  try {
    if (executor.kind === "builtin") {
      if (!deps.scriptExecutor) throw new Error("script_executor_unavailable");
      const text = await deps.scriptExecutor(executor, {
        runId: run.id,
        signal: lease.signal,
      });
      if (lease.signal.aborted) throw lease.signal.reason;
      settle(deps.db, deps.events, run, "succeeded", { text }, now);
      return "succeeded";
    }

    if (!deps.scriptsRoot) throw new Error("scripts_root_unavailable");
    const result = await runScriptFile({
      scriptsRoot: deps.scriptsRoot,
      path: executor.path,
      args: executor.args,
      signal: lease.signal,
    });
    if (result.exitCode !== 0) {
      settle(
        deps.db,
        deps.events,
        run,
        "failed",
        {
          error: `script_exit_${result.exitCode}`,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          truncated: result.truncated,
        },
        now,
      );
      return "failed";
    }
    settle(
      deps.db,
      deps.events,
      run,
      "succeeded",
      {
        text: result.stdout,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
        truncated: result.truncated,
      },
      now,
    );
    return "succeeded";
  } catch (error) {
    const cancelled = cancelledOutcome(deps, run, lease, now);
    if (cancelled) return cancelled;
    if (lease.signal.aborted) {
      const reason = abortMessage(lease.signal) ?? "work_timeout";
      if (ownsLease(deps.db, run.id, run.leaseOwner, now))
        deps.db
          .query("UPDATE runs SET cancel_intent=? WHERE id=?")
          .run(reason === "host_restart" ? "host_restart" : "timeout", run.id);
      settle(deps.db, deps.events, run, "interrupted", { error: reason }, now);
      return "interrupted";
    }
    settle(
      deps.db,
      deps.events,
      run,
      "failed",
      { error: error instanceof Error ? error.message : "unknown" },
      now,
    );
    return "failed";
  }
}
