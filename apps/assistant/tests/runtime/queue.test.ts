import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "../../src/db/store";
import { claim, complete, heartbeat, pauseForApproval, recoverExpired, start } from "../../src/runtime/attempts";
import { cancel, enqueue, eventsAfter, getRun, RunConflict } from "../../src/runtime/queue";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function database(): Database {
  const db = new Database(":memory:", { strict: true });
  migrate(db, migrations());
  databases.push(db);
  return db;
}

test("one request key creates one Run and only one worker can claim it", () => {
  const db = database();
  const input = { requestKey: "same-request", goal: "abc", executor: "sha256" as const };
  const first = enqueue(db, input, 1000);
  const duplicate = enqueue(db, input, 1001);
  const claimed = claim(db, "worker-one", 1002);

  assert.equal(first.id, duplicate.id);
  assert.equal(claimed?.run_id, first.id);
  assert.equal(claim(db, "worker-two", 1002), undefined);
  assert.deepEqual(eventsAfter(db, first.id, 0).map((event) => event.kind), ["queued"]);
});

test("cancel wins over a stale worker completion", () => {
  const db = database();
  const run = enqueue(db, { requestKey: "cancel", goal: "abc", executor: "sha256" }, 1000);
  const attempt = claim(db, "worker", 1001);
  assert.ok(attempt);
  assert.equal(start(db, attempt, "worker", 1001), true);

  assert.equal(cancel(db, run.id, 1002), true);
  assert.throws(() => complete(db, attempt, "worker", { status: "succeeded", output: "result" }, 1003), RunConflict);
  assert.equal(getRun(db, run.id).status, "cancelled");
  assert.deepEqual(eventsAfter(db, run.id, 0).map((event) => event.kind), ["queued", "cancelled"]);
});

test("expired lease invalidates writes and records an uncertain external call", () => {
  const db = database();
  const run = enqueue(db, { requestKey: "expire", goal: "abc", executor: "sha256" }, 1000);
  const attempt = claim(db, "worker", 1001);
  assert.ok(attempt);
  assert.equal(start(db, attempt, "worker", 1001), true);
  db.query("INSERT INTO tool_calls (id,run_id,attempt_id,action_hash,status,args_json) VALUES (?,?,?,?,?,?)")
    .run("tool", run.id, attempt.id, "hash", "consumed", "{}");

  assert.deepEqual(recoverExpired(db, 31_002), [run.id]);
  assert.equal(heartbeat(db, attempt, "worker", 31_003), false);
  assert.throws(() => complete(db, attempt, "worker", { status: "succeeded", output: "late" }, 31_003), RunConflict);
  assert.equal(getRun(db, run.id).status, "interrupted");
  assert.deepEqual(db.query("SELECT status FROM tool_calls WHERE id = 'tool'").get(), { status: "outcome_unknown" });
  assert.equal(claim(db, "new-worker", 31_003), undefined);
});

test("approval wait stores the exact call and releases its worker lease", () => {
  const db = database();
  const run = enqueue(db, { requestKey: "approval", goal: "replace a file", executor: "agent" }, 1000);
  const attempt = claim(db, "worker", 1001);
  assert.ok(attempt);
  assert.equal(start(db, attempt, "worker", 1001), true);

  const callId = pauseForApproval(db, attempt, "worker", {
    actionHash: "sha256:expected", args: { file: "draft.md", version: 2 },
  }, 1002);

  assert.equal(getRun(db, run.id).status, "awaiting_approval");
  assert.deepEqual(db.query("SELECT status,action_hash,args_json FROM tool_calls WHERE id = ?").get(callId), {
    status: "planned", action_hash: "sha256:expected",
    args_json: '{"file":"draft.md","version":2}',
  });
  assert.equal(claim(db, "another-worker", 1003), undefined);
  assert.throws(() => complete(db, attempt, "worker", { status: "succeeded", output: "bad" }, 1003), RunConflict);
});
