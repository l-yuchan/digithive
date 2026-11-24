import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { enqueueRun, reconcileWork, getRun } from "../src/surfaces/work/runner";
import { z } from "zod";

test("separate workers race for one concurrency slot and an exited worker's lease is reclaimed", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-race-"));
  const path = join(root, "runs.db");
  const gate = join(root, "go");
  const db = openDatabase(path);
  const events = new EventLog(db);
  enqueueRun(db, events, { goal: "first" });
  enqueueRun(db, events, { goal: "second" });
  const code = `
    import { existsSync } from "node:fs";
    import { openDatabase } from "./src/store/db";
    import { EventLog } from "./src/events/log";
    import { claimNext } from "./src/surfaces/work/runner";
    const db=openDatabase(process.env.TEST_DB);
    console.log("ready");
    while(!existsSync(process.env.TEST_GATE)) await Bun.sleep(1);
    const run=claimNext(db,new EventLog(db),String(process.pid),1);
    console.log(JSON.stringify(run));
    db.close();
  `;
  const workers = [0, 1].map(() => Bun.spawn([process.execPath, "-e", code], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, TEST_DB: path, TEST_GATE: gate }, stdout: "pipe", stderr: "pipe",
  }));
  try {
    const readers = workers.map((worker) => worker.stdout.getReader());
    await Promise.all(readers.map(async (reader) => {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value).trim()).toBe("ready");
    }));
    await Bun.write(gate, "go");
    const outputs = await Promise.all(readers.map(async (reader) => {
      let text = "";
      while (true) { const next = await reader.read(); if (next.done) return text; text += new TextDecoder().decode(next.value); }
    }));
    expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual([0, 0]);
    const claimed = outputs.map((text) => z.object({ id: z.string() }).nullable().parse(JSON.parse(text))).filter((row) => row !== null);
    expect(claimed).toHaveLength(1);
    const active = db.query<{ id: string; lease_expires_at: string }, []>("SELECT id, lease_expires_at FROM runs WHERE status='running'").get();
    if (!active) throw new Error("no owner");
    expect(reconcileWork(db, events, Date.parse(active.lease_expires_at) + 1).interrupted).toBe(1);
    expect(getRun(db, active.id)?.status).toBe("interrupted");
  } finally {
    for (const worker of workers) worker.kill();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("killing an executing worker leaves an interrupted run after its final lease expires", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-kill-"));
  const path = join(root, "runs.db");
  const db = openDatabase(path);
  const events = new EventLog(db);
  const run = enqueueRun(db, events, { goal: "kill during stream" });
  const child = Bun.spawn([process.execPath, "-e", `
    import { openDatabase } from "./src/store/db";
    import { EventLog } from "./src/events/log";
    import { claimNext,executeRun } from "./src/surfaces/work/runner";
    import { createRegistry } from "./src/tools/registry";
    const db=openDatabase(process.env.TEST_DB);
    const events=new EventLog(db);
    const run=claimNext(db,events,"child");
    const stream=async function* (_messages,_tools,options) {
      console.log("executing");
      await new Promise((_resolve,reject)=>options.signal.addEventListener("abort",()=>reject(new Error("aborted"))));
    };
    await executeRun({db,events,stream,tools:createRegistry([]),policy:[]},run);
  `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, TEST_DB: path }, stdout: "pipe", stderr: "pipe" });
  try {
    const ready = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value).trim()).toBe("executing");
    expect(getRun(db, run.id)?.status).toBe("running");
    child.kill();
    expect(await child.exited).not.toBe(0);
    const expiry = getRun(db, run.id)?.leaseExpiresAt;
    if (!expiry) throw new Error("missing lease");
    expect(reconcileWork(db, events, Date.parse(expiry) + 1).interrupted).toBe(1);
    expect(getRun(db, run.id)?.status).toBe("interrupted");
  } finally { child.kill(); await child.exited; db.close(); rmSync(root, { recursive: true, force: true }); }
});
