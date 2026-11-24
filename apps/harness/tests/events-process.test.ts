import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server/main";
import { loadConfig } from "../src/runtime";

test("an open HTTP SSE connection receives another process's event and reconnects without replaying it", async () => {
  const root = mkdtempSync(join(tmpdir(), "events-process-"));
  const path = join(root, "events.db");
  const harness = createHarness(loadConfig({ HARNESS_DB: path, HARNESS_WORKSPACE: join(root, "workspace") }));
  const server = Bun.serve({ port: 0, fetch: harness.handler });
  const controller = new AbortController();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/events`, { signal: controller.signal });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no stream");
    const decoder = new TextDecoder();
    await reader.read(); // snapshot means the connection is open before the writer starts
    child = Bun.spawn([process.execPath, "-e", `
      import { openDatabase } from "./src/store/db";
      import { EventLog } from "./src/events/log";
      const db=openDatabase(process.env.TEST_DB);
      new EventLog(db).append({kind:"run.progress",payload:{text:"from-worker"}});
      db.close();
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, TEST_DB: path }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    let received = "";
    await Promise.race([
      (async () => { while (!received.includes("from-worker")) { const next = await reader.read(); if (next.done) throw new Error("closed early"); received += decoder.decode(next.value); } })(),
      new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("worker event not delivered")), 1500); }),
    ]);
    expect(received).toContain("event: run.progress");
    const id = /id: (\d+)/.exec(received)?.[1];
    if (!id) throw new Error("missing event id");
    controller.abort();
    const reconnect = new AbortController();
    try {
      const resumed = await fetch(`http://127.0.0.1:${server.port}/api/events`, { headers: { "Last-Event-ID": id }, signal: reconnect.signal });
      const resumedReader = resumed.body?.getReader();
      if (!resumedReader) throw new Error("no stream");
      const first = await resumedReader.read();
      expect(decoder.decode(first.value)).not.toContain("from-worker");
    } finally { reconnect.abort(); }
  } finally {
    if (watchdog) clearTimeout(watchdog);
    controller.abort();
    child?.kill();
    server.stop(true);
    harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});
