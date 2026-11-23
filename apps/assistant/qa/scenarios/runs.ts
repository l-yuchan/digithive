import assert from "node:assert/strict";
import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { claim, complete, recoverExpired, start } from "../../src/runtime/attempts";
import { cancel, enqueue, eventsAfter, getRun, RunConflict } from "../../src/runtime/queue";

type RunContext = {
  readonly db: Database;
  readonly dbPath: string;
  readonly evidence: string;
};

export async function runReconnect(context: RunContext): Promise<void> {
  const base = "http://127.0.0.1:4317";
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "qa-only-long-passphrase" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const requestKey = randomUUID();
  const headers = { origin: base, cookie, "content-type": "application/json" };
  const body = JSON.stringify({ goal: "reconnect", executor: "sha256", client_request_id: requestKey });
  const first = await fetch(`${base}/api/runs`, { method: "POST", headers, body });
  const duplicate = await fetch(`${base}/api/runs`, { method: "POST", headers, body });
  assert.equal(first.status, 202);
  assert.equal(duplicate.status, 202);
  const created = z.object({ id: z.string().uuid(), status: z.string() }).parse(await first.json());
  const replay = z.object({ id: z.string().uuid() }).parse(await duplicate.json());
  assert.equal(created.id, replay.id);

  const worker = Bun.spawn([process.execPath, "scripts/worker.ts", "--once"], {
    env: { ...process.env, ASSISTANT_DB_PATH: context.dbPath },
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => worker.kill(), 10_000);
  const exitCode = await worker.exited;
  clearTimeout(deadline);
  assert.equal(exitCode, 0);
  const result = await fetch(`${base}/api/runs/${created.id}`, { headers: { cookie } });
  const run = z.object({ status: z.string() }).parse(await result.json());
  assert.equal(run.status, "succeeded");
  const stream = await fetch(`${base}/api/runs/${created.id}/events?after=0`, { headers: { cookie } });
  const events = await stream.text();
  const digest = createHash("sha256").update("reconnect").digest("hex");
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("content-type")?.startsWith("text/event-stream"), true);
  assert.equal(events.includes(`"output":"${digest}"`), true);
  assert.equal(events.match(/event: succeeded/g)?.length, 1);
  const resumed = await fetch(`${base}/api/runs/${created.id}/events?after=1`, { headers: { cookie } });
  assert.equal((await resumed.text()).match(/event: succeeded/g)?.length, 1);
  await writeFile(join(context.evidence, "events.json"), `${JSON.stringify({
    initial: created.status, afterWorker: run.status, digest,
    succeededEvents: 1, replayRunIdMatches: created.id === replay.id,
  }, null, 2)}\n`);
  await writeFile(join(context.evidence, "http.json"), `${JSON.stringify({
    enqueueStatus: first.status, replayStatus: duplicate.status,
    runStatus: result.status, eventsStatus: stream.status, resumedStatus: resumed.status,
    workerExitCode: exitCode,
  }, null, 2)}\n`);
}

export async function runLeaseCrashCancel(context: RunContext): Promise<void> {
  const now = Date.now();
  const lost = enqueue(context.db, {
    requestKey: randomUUID(), goal: "crash-before-publish", executor: "sha256",
  }, now);
  const code = `import {openDatabase} from "./src/db/store.ts";
    import {claim,start} from "./src/runtime/attempts.ts";
    const db=openDatabase(process.env.ASSISTANT_DB_PATH);
    const attempt=claim(db,"crash-worker",Number(process.env.QA_TIME));
    if (attempt) start(db,attempt,"crash-worker",Number(process.env.QA_TIME));
    console.log(JSON.stringify(attempt));
    await Bun.sleep(60_000);`;
  const first = Bun.spawn([process.execPath, "-e", code], {
    env: { ...process.env, ASSISTANT_DB_PATH: context.dbPath, QA_TIME: String(now) },
    stdout: "pipe",
    stderr: "pipe",
  });
  let firstExited = false;
  try {
    assert.ok(first.stdout);
    const reader = first.stdout.getReader();
    const timeout = setTimeout(() => first.kill(), 10_000);
    const claimedLine = await reader.read();
    clearTimeout(timeout);
    reader.releaseLock();
    assert.equal(claimedLine.done, false);
    const attempt = z.object({
      id: z.string(), run_id: z.string(), fence: z.number(),
      goal: z.string(), executor_kind: z.string(), lease_until: z.string(),
    }).parse(JSON.parse(new TextDecoder().decode(claimedLine.value).trim()));
    assert.equal(attempt.run_id, lost.id);
    const second = Bun.spawn([process.execPath, "scripts/worker.ts", "--once"], {
      env: { ...process.env, ASSISTANT_DB_PATH: context.dbPath },
      stdout: "ignore",
      stderr: "pipe",
    });
    const secondDeadline = setTimeout(() => second.kill(), 10_000);
    const secondExit = await second.exited;
    clearTimeout(secondDeadline);
    assert.equal(secondExit, 0);
    assert.equal(getRun(context.db, lost.id).status, "running");

    first.kill();
    const killedExit = await first.exited;
    assert.notEqual(killedExit, 0);
    firstExited = true;
    const interrupted = recoverExpired(context.db, now + 31_000);
    assert.deepEqual(interrupted, [lost.id]);
    assert.throws(() => complete(context.db, attempt, "crash-worker", {
      status: "succeeded", output: "late",
    }, now + 31_001), RunConflict);
    assert.equal(claim(context.db, "worker-after-crash", now + 31_001), undefined);
    const fresh = enqueue(context.db, {
      requestKey: randomUUID(), goal: "cancel-me", executor: "sha256",
    }, now + 31_002);
    const claimedFresh = claim(context.db, "other-worker", now + 31_003);
    assert.ok(claimedFresh);
    assert.equal(start(context.db, claimedFresh, "other-worker", now + 31_003), true);
    assert.equal(cancel(context.db, fresh.id, now + 31_004), true);
    assert.throws(() => complete(context.db, claimedFresh, "other-worker", {
      status: "succeeded", output: "too-late",
    }, now + 31_005), RunConflict);
    assert.equal(getRun(context.db, fresh.id).status, "cancelled");
    const staleWrites = eventsAfter(context.db, lost.id, 0).filter((event) => event.kind === "succeeded").length
      + eventsAfter(context.db, fresh.id, 0).filter((event) => event.kind === "succeeded").length;
    assert.equal(staleWrites, 0);
    await writeFile(join(context.evidence, "db-diff.json"), `${JSON.stringify({
      lostStatus: getRun(context.db, lost.id).status,
      cancelledStatus: getRun(context.db, fresh.id).status,
      lostEvents: eventsAfter(context.db, lost.id, 0).map((event) => event.kind),
      cancelledEvents: eventsAfter(context.db, fresh.id, 0).map((event) => event.kind),
      staleWrites,
    }, null, 2)}\n`);
    await writeFile(join(context.evidence, "process-cleanup.json"), `${JSON.stringify({
      firstWorkerKilled: firstExited, killedExit, competingWorkerExit: secondExit,
    }, null, 2)}\n`);
  } finally {
    if (!firstExited) {
      first.kill();
      await first.exited;
    }
  }
}
