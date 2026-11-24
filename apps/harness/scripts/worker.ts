import { loadConfig } from "../src/runtime";
import { claimNext, executeRun, reconcileWork } from "../src/surfaces/work/runner";
import { syncCanvas } from "../src/integrations/canvas";
import { syncGoogleCalendar, syncGoogleGmail } from "../src/integrations/google";
import { runBriefing } from "../src/scheduler/compose";
import { sendPush } from "../src/scheduler/push";

/**
 * The work worker: claims runs under a lease, keeps integrations fresh, fires
 * the scheduled briefings, and reconciles deaths. It never serves HTTP.
 */
const config = loadConfig();
const { createRuntime } = await import("../src/runtime");
const runtime = createRuntime(config);
const { db, events } = runtime.work;
const owner = `worker-${process.pid}`;
const stopping = new AbortController();

const google = {
  db,
  events,
  vaultSecret: config.sessionSecret,
  config: { clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: config.googleRedirectUri },
};
const canvas = { db, events, config: { baseUrl: config.canvasBaseUrl, token: config.canvasToken } };
const vapid = { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey, subject: config.vapidSubject };

process.on("SIGINT", () => {
  stopping.abort();
});
process.on("SIGTERM", () => {
  stopping.abort();
});

console.log(`worker ${owner} started (model ${config.model}, max concurrent ${config.maxConcurrent})`);

let lastSync = 0;
const SYNC_INTERVAL_MS = 15 * 60_000;

while (!stopping.signal.aborted) {
  const reconciled = reconcileWork(db, events);
  if (reconciled.expiredApprovals > 0 || reconciled.interrupted > 0) {
    console.log(`reconciled: expired=${reconciled.expiredApprovals} interrupted=${reconciled.interrupted}`);
  }

  const now = Date.now();
  if (now - lastSync > SYNC_INTERVAL_MS) {
    lastSync = now;
    const results = [await syncGoogleCalendar(google), await syncGoogleGmail(google), await syncCanvas(canvas)];
    console.log(`sync: ${results.map((row) => `${row.source}=${row.ok ? row.count : "ERR:" + (row.error ?? "")}`).join(" ")}`);
  }

  const briefing = await runBriefing({
    db,
    events,
    push: async (payload) => {
      const outcome = await sendPush(db, vapid, payload);
      return outcome.sent > 0 ? { ok: true } : { ok: false, error: outcome.errors.join(",") || "no_device" };
    },
  });
  if (briefing.stored || briefing.error) console.log(`briefing ${briefing.slot}: stored=${briefing.stored} pushed=${briefing.pushed} error=${briefing.error ?? "-"}`);

  const run = claimNext(db, events, owner, config.maxConcurrent, Date.now(), runtime.work.leaseMs ?? 45_000);
  if (run) {
    const outcome = await executeRun(runtime.work, run);
    console.log(`run ${run.id} -> ${outcome}`);
  } else {
    await Bun.sleep(500);
  }
}

runtime.close();
console.log("worker stopped");
