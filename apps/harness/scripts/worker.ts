import { createRuntime, loadConfig } from "../src/runtime";
import { claimNext, executeRun, reconcileWork } from "../src/surfaces/work/runner";
import { dispatchDueSchedules } from "../src/scheduler/schedules";
import { ensureCollectionWorkflows } from "../src/workflows/collection";

/** Definitions only dispatch; every executor shares the leased work queue. */
const config = loadConfig();
const runtime = createRuntime(config);
const { db, events } = runtime.work;
const owner = `worker-${process.pid}`;
const stopping = new AbortController();
const active = new Set<Promise<void>>();
process.on("SIGINT", () => stopping.abort(new Error("host_shutdown")));
process.on("SIGTERM", () => stopping.abort(new Error("host_shutdown")));

console.log(
  `worker ${owner} started (model ${config.model}, max concurrent ${config.maxConcurrent})`,
);
ensureCollectionWorkflows(db, events);

try {
  while (!stopping.signal.aborted) {
    const reconciled = reconcileWork(db, events);
    if (reconciled.expiredApprovals || reconciled.interrupted) {
      console.log(
        `reconciled: expired=${reconciled.expiredApprovals} interrupted=${reconciled.interrupted}`,
      );
    }
    const dispatched = dispatchDueSchedules({ db, events });
    if (dispatched.enqueued) console.log(`schedules: enqueued=${dispatched.enqueued}`);

    while (active.size < config.maxConcurrent && !stopping.signal.aborted) {
      const run = claimNext(db, events, owner, config.maxConcurrent, Date.now(), config.leaseMs);
      if (!run) break;
      const execution = executeRun({ ...runtime.work, shutdownSignal: stopping.signal }, run)
        .then((outcome) => {
          console.log(`run ${run.id} -> ${outcome}`);
        })
        .catch((error: unknown) => {
          console.error(
            `run ${run.id} failed: ${error instanceof Error ? error.stack : String(error)}`,
          );
        })
        .finally(() => {
          active.delete(execution);
        });
      active.add(execution);
    }
    await Bun.sleep(500);
  }
} finally {
  await Promise.allSettled(active);
  runtime.close();
  console.log("worker stopped");
}
