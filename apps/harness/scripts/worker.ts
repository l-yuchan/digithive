import { loadConfig } from "../src/runtime";
import { claimNext, executeRun, reconcileWork } from "../src/surfaces/work/runner";

/**
 * The work worker. It claims queued runs under a lease, executes them, and
 * reconciles deaths; it never touches the conversation surface.
 */
const config = loadConfig();
const { createRuntime } = await import("../src/runtime");
const runtime = createRuntime(config);
const owner = `worker-${process.pid}`;
let stopping = false;

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

console.log(`worker ${owner} started (model ${config.model}, max concurrent ${config.maxConcurrent})`);

while (!stopping) {
  const reconciled = reconcileWork(runtime.work.db, runtime.work.events);
  if (reconciled.expiredApprovals > 0 || reconciled.interrupted > 0) {
    console.log(`reconciled: expired=${reconciled.expiredApprovals} interrupted=${reconciled.interrupted}`);
  }
  const run = claimNext(runtime.work.db, runtime.work.events, owner, config.maxConcurrent, Date.now(), runtime.work.leaseMs ?? 45_000);
  if (run) {
    const outcome = await executeRun(runtime.work, run);
    console.log(`run ${run.id} -> ${outcome}`);
  } else {
    await Bun.sleep(500);
  }
}

runtime.close();
console.log("worker stopped");
