import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startServer } from "../../src/server/server";

test("records persist across restart and a standalone SQLite snapshot restores them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "digithive-storage-"));
  const options = { port: 0, dbPath: join(dir, "main.sqlite"), backupDir: join(dir, "backups") };
  let server = startServer(options);
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${server.url}/api${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    expect(response.status).toBeLessThan(400);
    const value: unknown = await response.json();
    return value;
  };
  try {
    const created = z.object({ entry: z.object({ id: z.string() }) }).parse(await request("/entries", "POST", { kind: "interest", text: "persistent memory", context: { kind: "interest" } }));
    server.close();
    server = startServer(options);
    const persisted = z.object({ entry: z.object({ id: z.string(), text: z.string() }) }).parse(await request(`/entries/${created.entry.id}`));
    expect(persisted.entry).toEqual({ id: created.entry.id, text: "persistent memory" });
    const { snapshot } = z.object({ snapshot: z.object({ file_name: z.string(), size_bytes: z.number() }) }).parse(await request("/backup/snapshot", "POST"));
    expect(snapshot.size_bytes).toBeGreaterThan(0);
    server.close();
    server = startServer({ ...options, dbPath: join(options.backupDir, snapshot.file_name) });
    const restored = z.object({ entries: z.array(z.object({ text: z.string() })) }).parse(await request("/entries"));
    expect(restored.entries).toEqual([{ text: "persistent memory" }]);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("cross-origin mutations are rejected by the real HTTP server", async () => {
  const server = startServer({ port: 0, dbPath: ":memory:" });
  try {
    const response = await fetch(`${server.url}/api/entries`, { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json" }, body: JSON.stringify({ kind: "interest", text: "unauthorized" }) });
    expect(response.status).toBe(403);
    expect(server.store.count("entries")).toBe(0);
  } finally { server.close(); }
});
