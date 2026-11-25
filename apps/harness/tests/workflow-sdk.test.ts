import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/store/db";
import { createRegistry } from "../src/tools/registry";
import { memoryTools } from "../src/tools/memory";
import { SdkBridge } from "../src/sdk/bridge";
import { syncSdkFile } from "../src/sdk/generated";
import { runScriptFile } from "../src/surfaces/work/script";
import { remember } from "../src/knowledge/memory";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(capabilities: readonly ("memory.read" | "memory.write")[]) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  const root = mkdtempSync(join(tmpdir(), "harness-sdk-"));
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const bridge = new SdkBridge({ tools: createRegistry(memoryTools(db)), now: () => NOW });
  cleanups.push(() => bridge.close());
  const ticket = bridge.issue({
    runId: "run-1",
    workflowId: "wf-1",
    workflowTitle: "테스트",
    params: { day: "월" },
    capabilities,
    deadlineAt: NOW + 10_000,
  });
  return { db, root, bridge, ticket };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("sdk bridge", () => {
  test("a token names one run and only the granted tools", async () => {
    const { db, bridge, ticket } = fixture(["memory.read"]);
    remember(db, { kind: "fact", text: "회의는 화요일", now: NOW });

    const context = await fetch(`${bridge.url}/sdk/context`, { headers: auth(ticket.token) });
    expect(context.status).toBe(200);
    expect(await context.json()).toMatchObject({
      runId: "run-1",
      workflowTitle: "테스트",
      params: { day: "월" },
    });

    const tools = await fetch(`${bridge.url}/sdk/tools`, { headers: auth(ticket.token) });
    const listed = z
      .object({ tools: z.array(z.object({ name: z.string() })) })
      .parse(await tools.json());
    expect(listed.tools.map((tool) => tool.name)).toEqual(["memory_recall"]);

    const allowed = await fetch(`${bridge.url}/sdk/call`, {
      method: "POST",
      headers: auth(ticket.token),
      body: JSON.stringify({ name: "memory_recall", args: { query: "회의" } }),
    });
    expect(allowed.status).toBe(200);
    const body = z.object({ result: z.string() }).parse(await allowed.json());
    expect(body.result).toContain("회의는 화요일");

    const denied = await fetch(`${bridge.url}/sdk/call`, {
      method: "POST",
      headers: auth(ticket.token),
      body: JSON.stringify({ name: "memory_note", args: { kind: "fact", text: "몰래" } }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "script_capability_denied" });
  });

  test("an unknown or expired token is refused and revocation is immediate", async () => {
    const { db, bridge, ticket } = fixture(["memory.read"]);
    remember(db, { kind: "fact", text: "기억", now: NOW });
    expect((await fetch(`${bridge.url}/sdk/context`, { headers: auth("nope") })).status).toBe(401);

    const expired = bridge.issue({
      runId: "run-2",
      workflowId: null,
      workflowTitle: null,
      params: {},
      capabilities: ["memory.read"],
      deadlineAt: NOW - 1,
    });
    expect(
      (await fetch(`${bridge.url}/sdk/context`, { headers: auth(expired.token) })).status,
    ).toBe(401);

    bridge.revoke(ticket.token);
    expect((await fetch(`${bridge.url}/sdk/context`, { headers: auth(ticket.token) })).status).toBe(
      401,
    );
  });

  test("a script process reaches the bridge through the generated SDK", async () => {
    const { db, root, ticket } = fixture(["memory.read"]);
    remember(db, { kind: "fact", text: "회의록은 공유 폴더에 있다", now: NOW });
    syncSdkFile(root);
    mkdirSync(join(root, "jobs"), { recursive: true });
    writeFileSync(
      join(root, "jobs", "recall.ts"),
      [
        'import { sdk } from "../.digithive/sdk.ts";',
        "const context = await sdk.context();",
        'const hits = await sdk.memory.recall("회의록");',
        "const parsed = hits as { text: string }[];",
        "console.log(JSON.stringify({ runId: context.runId, texts: parsed.map((hit) => hit.text) }));",
      ].join("\n"),
      "utf8",
    );
    const result = await runScriptFile({
      scriptsRoot: root,
      path: "jobs/recall.ts",
      args: [],
      signal: new AbortController().signal,
      env: ticket.env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      runId: "run-1",
      texts: ["회의록은 공유 폴더에 있다"],
    });
  });

  test("a script without a ticket has no bridge at all", async () => {
    const { root } = fixture(["memory.read"]);
    syncSdkFile(root);
    mkdirSync(join(root, "jobs"), { recursive: true });
    writeFileSync(
      join(root, "jobs", "context.ts"),
      [
        'import { sdk } from "../.digithive/sdk.ts";',
        "try {",
        "  await sdk.context();",
        "  console.log('unexpected');",
        "} catch (error) {",
        "  console.log('no-ticket');",
        "}",
      ].join("\n"),
      "utf8",
    );
    const result = await runScriptFile({
      scriptsRoot: root,
      path: "jobs/context.ts",
      args: [],
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("no-ticket");
  });
});
