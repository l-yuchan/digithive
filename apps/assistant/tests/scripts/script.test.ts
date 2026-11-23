import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "../../src/db/store";
import { assertApproved, runScript, sandboxRequest, ScriptDenied } from "../../src/runtime/executors/script";
import { ScriptManifest, SandboxRequest } from "../../src/contracts/tools";
import { enqueue } from "../../src/runtime/queue";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function database(): Database {
  const db = new Database(":memory:", { strict: true });
  migrate(db, migrations());
  databases.push(db);
  enqueue(db, { requestKey: `script-${crypto.randomUUID()}`, goal: "script", executor: "script" });
  return db;
}

const digest = `sha256:${"a".repeat(64)}`;
const manifest = ScriptManifest.parse({
  id: "text-transform", kind: "generated", artifactDigest: digest,
  timeoutMs: 5_000, maxOutputBytes: 65_536, memoryMb: 128, cpus: 0.5, pidsLimit: 32,
});

test("an unapproved generated script is refused before any sandbox call", async () => {
  const db = database();
  let called = false;
  const server = Bun.serve({
    port: 0,
    fetch: () => { called = true; return Response.json({}); },
  });
  try {
    await assert.rejects(
      () => runScript(db, { manifest, image: "dg-script:text-transform", argv: [] }, {
        runnerUrl: `http://127.0.0.1:${server.port}`, runnerToken: "x".repeat(20),
      }),
      (error: unknown) => error instanceof ScriptDenied && error.kind === "not_approved",
    );
    assert.equal(called, false);
  } finally {
    server.stop(true);
  }
});

test("an approved digest runs through the runner and returns its bounded result", async () => {
  const db = database();
  db.query("INSERT INTO tool_versions (id,tool_id,artifact_digest,active,approved_by) VALUES (?,?,?,?,?)")
    .run("tv-1", "text-transform", digest, 1, "user");
  assertApproved(db, manifest);
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      assert.equal(request.headers.get("authorization"), `Bearer ${"t".repeat(20)}`);
      const body = SandboxRequest.parse(await request.json());
      assert.deepEqual(body.argv, ["--uppercase", "value; rm -rf /"]);
      return Response.json({
        exitCode: 0, timedOut: false, stdout: "OK", truncated: false,
        outputs: [{ path: "result.txt", sha256: "b".repeat(64), bytes: 3 }],
      });
    },
  });
  try {
    const result = await runScript(db, {
      manifest, image: "dg-script:text-transform", argv: ["--uppercase", "value; rm -rf /"],
    }, { runnerUrl: `http://127.0.0.1:${server.port}`, runnerToken: "t".repeat(20) });
    assert.equal(result.stdout, "OK");
    assert.deepEqual(result.outputs, [{ path: "result.txt", sha256: "b".repeat(64), bytes: 3 }]);
  } finally {
    server.stop(true);
  }
});

test("shell metacharacters stay inside one argv element", () => {
  const request = sandboxRequest(manifest, "dg-script:text-transform", ["a b", "$(id)", "; ls"]);
  assert.deepEqual(request.argv, ["a b", "$(id)", "; ls"]);
  assert.equal(request.entrypoint, "main.ts");
});

test("a missing runner fails closed instead of executing on the host", async () => {
  const db = database();
  db.query("INSERT INTO tool_versions (id,tool_id,artifact_digest,active,approved_by) VALUES (?,?,?,?,?)")
    .run("tv-2", "text-transform", digest, 1, "user");
  await assert.rejects(
    () => runScript(db, { manifest, image: "dg-script:text-transform", argv: [] },
      { runnerUrl: undefined, runnerToken: undefined }),
    (error: unknown) => error instanceof ScriptDenied && error.kind === "sandbox_unavailable",
  );
});

test("the manifest refuses an unbounded timeout and an unpinned digest", () => {
  assert.throws(() => ScriptManifest.parse({ ...manifest, timeoutMs: 600_001 }));
  assert.throws(() => ScriptManifest.parse({ ...manifest, artifactDigest: "sha256:short" }));
});
