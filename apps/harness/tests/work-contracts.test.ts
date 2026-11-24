import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { createRegistry } from "../src/tools/registry";
import { enqueueRun, claimNext, executeRun, reconcileWork, decideApproval, getRun, validateDelegation, WORK_LIMITS, type WorkDeps } from "../src/surfaces/work/runner";
import type { StreamFn } from "../src/providers/openai";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(stream: StreamFn, policy: WorkDeps["policy"] = [{ action: "*", resource: "*", effect: "ask" }]) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  const events = new EventLog(db);
  let effects = 0;
  const deps: WorkDeps = {
    db, events, stream, policy, leaseMs: 60,
    limits: { ...WORK_LIMITS, totalMs: 1000, toolMs: 50 },
    tools: createRegistry([{ name: "effect", description: "count an effect", parameters: {}, action: "edit", execute: async () => { effects++; return "effect done"; } }]),
  };
  return { db, events, deps, effects: () => effects };
}

const calls: StreamFn = async function* () {
  yield { type: "tool_call", id: "call", name: "effect", arguments: "{}" };
  yield { type: "done", finishReason: "tool_calls" };
};

test("work total deadline aborts an unending provider and settles once as interrupted", async () => {
  const hanging: StreamFn = async function* (_messages, _tools, options) {
    await new Promise<void>((_resolve, reject) => {
      if (!options.signal) { reject(new Error("missing cancellation signal")); return; }
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  const { db, events, deps } = fixture(hanging);
  const run = enqueueRun(db, events, { goal: "deadline" });
  const claimed = claimNext(db, events, "worker");
  if (!claimed || !deps.limits) throw new Error("fixture");
  expect(await executeRun({ ...deps, limits: { ...deps.limits, totalMs: 20 } }, claimed)).toBe("interrupted");
  expect(getRun(db, run.id)?.cancelIntent).toBe("timeout");
});

test("an active stream renews its lease while reconciliation leaves it running", async () => {
  let release: () => void = () => { throw new Error("not started"); };
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stream: StreamFn = async function* () { yield { type: "text_delta", text: "started" }; await gate; yield { type: "done", finishReason: "stop" }; };
  const { db, events, deps } = fixture(stream);
  const run = enqueueRun(db, events, { goal: "lease" });
  const claimed = claimNext(db, events, "worker", 2, Date.now(), 60);
  if (!claimed) throw new Error("fixture");
  let stop: () => void = () => {};
  const renewed = new Promise<void>((resolve) => { stop = events.subscribe((event) => { if (event.kind === "run.heartbeat") resolve(); }); });
  const executing = executeRun(deps, claimed);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([renewed, new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("no heartbeat")), 300); })]);
    expect(reconcileWork(db, events).interrupted).toBe(0);
    expect(getRun(db, run.id)?.status).toBe("running");
  } finally { if (watchdog) clearTimeout(watchdog); stop(); release(); await executing; }
  expect(getRun(db, run.id)?.status).toBe("succeeded");
});

test("a cancelled run cannot execute the next tool or overwrite its terminal status", async () => {
  let db: Database;
  let id = "";
  const stream: StreamFn = async function* () {
    db.query("UPDATE runs SET status='cancelled', cancel_intent='user' WHERE id=?").run(id);
    yield* calls([], [], { maxOutputTokens: 1, firstTokenTimeoutMs: 1, idleTimeoutMs: 1 });
  };
  const f = fixture(stream, [{ action: "*", resource: "*", effect: "allow" }]);
  db = f.db;
  const run = enqueueRun(db, f.events, { goal: "cancel" });
  id = run.id;
  const claimed = claimNext(db, f.events, "worker");
  if (!claimed) throw new Error("fixture");
  await executeRun(f.deps, claimed);
  expect(f.effects()).toBe(0);
  expect(getRun(db, run.id)?.status).toBe("cancelled");
});

test("approval expires without an effect and repeated approval cannot replay it", async () => {
  let round = 0;
  const stream: StreamFn = async function* (...args) {
    if (++round === 1) yield* calls(...args);
    else yield { type: "done", finishReason: "stop" };
  };
  const f = fixture(stream);
  const run = enqueueRun(f.db, f.events, { goal: "approval" });
  const claimed = claimNext(f.db, f.events, "worker");
  if (!claimed) throw new Error("fixture");
  expect(await executeRun(f.deps, claimed)).toBe("paused");
  expect(f.effects()).toBe(0);
  const approval = f.db.query<{ id: string; requested_at: string }, []>("SELECT id, requested_at FROM approvals").get();
  if (!approval) throw new Error("fixture");
  reconcileWork(f.db, f.events, Date.parse(approval.requested_at) + 30 * 60_000);
  expect(() => decideApproval(f, { runId: run.id, approvalId: approval.id, decision: "approve" })).toThrow("approval_already_decided");
  const resumed = claimNext(f.db, f.events, "worker");
  if (!resumed) throw new Error("fixture");
  await executeRun(f.deps, resumed);
  expect(f.effects()).toBe(0);
});

test("approval executes exactly once and rejection executes zero times", async () => {
  for (const decision of ["approve", "reject"] as const) {
    let round = 0;
    const stream: StreamFn = async function* (...args) {
      if (++round === 1) yield* calls(...args);
      else {
        expect(args[0].some((message) => message.role === "tool" && message.content.includes(decision === "approve" ? "effect done" : "거부"))).toBe(true);
        yield { type: "done", finishReason: "stop" };
      }
    };
    const f = fixture(stream);
    const run = enqueueRun(f.db, f.events, { goal: decision });
    const claimed = claimNext(f.db, f.events, "worker");
    if (!claimed) throw new Error("fixture");
    await executeRun(f.deps, claimed);
    expect(f.effects()).toBe(0);
    const approval = f.db.query<{ id: string }, []>("SELECT id FROM approvals").get();
    if (!approval) throw new Error("fixture");
    decideApproval(f, { runId: run.id, approvalId: approval.id, decision });
    const resumed = claimNext(f.db, f.events, "worker");
    if (!resumed) throw new Error("fixture");
    await executeRun(f.deps, resumed);
    expect(f.effects()).toBe(decision === "approve" ? 1 : 0);
    expect(() => decideApproval(f, { runId: run.id, approvalId: approval.id, decision })).toThrow("approval_already_decided");
    expect(claimNext(f.db, f.events, "worker")).toBeNull();
  }
});

test("invalid delegation budgets and unknown permission profiles are rejected", () => {
  const fields = { goal: "g", inputRefs: ["mail:1"], completionCondition: "done", permissionProfile: "read-only" };
  for (const value of [NaN, Infinity, -1, 1.5]) {
    expect(validateDelegation({ ...fields, budget: { maxMicroUsd: value, maxToolCalls: value } })).toContain("budget");
  }
  expect(validateDelegation({ ...fields, permissionProfile: "unrestricted", budget: { maxMicroUsd: 100, maxToolCalls: 1 } })).toContain("permissionProfile");
});

test("a run stops at the tool-call budget instead of silently succeeding at its round limit", async () => {
  for (const limit of [1, 2]) {
    const f = fixture(calls, [{ action: "*", resource: "*", effect: "allow" }]);
    const run = enqueueRun(f.db, f.events, { goal: "budget", budget: { maxToolCalls: limit } });
    const claimed = claimNext(f.db, f.events, "worker");
    if (!claimed) throw new Error("fixture");
    expect(await executeRun(f.deps, claimed)).toBe("failed");
    expect(f.effects()).toBe(limit);
    expect(getRun(f.db, run.id)?.resultJson).toContain("tool_budget_exceeded");
  }
});

test("read-only delegation persists its instructions and never executes an edit", async () => {
  let round = 0;
  const stream: StreamFn = async function* (...args) {
    if (++round === 1) yield* calls(...args);
    else yield { type: "done", finishReason: "stop" };
  };
  const f = fixture(stream, [{ action: "*", resource: "*", effect: "allow" }]);
  const delegation = {
    goal: "read", inputRefs: ["mail:1"], permissionProfile: "read-only",
    budget: { maxMicroUsd: 1000, maxToolCalls: 1 }, completionCondition: "source-backed summary",
  };
  const run = enqueueRun(f.db, f.events, { goal: "read", origin: "delegation", delegation });
  expect(JSON.parse(run.budgetJson)).toEqual(delegation);
  const claimed = claimNext(f.db, f.events, "worker");
  if (!claimed) throw new Error("fixture");
  expect(await executeRun(f.deps, claimed)).toBe("succeeded");
  expect(f.effects()).toBe(0);
  expect(f.events.after(0).filter((event) => event.kind === "tool.denied")).toHaveLength(1);
});

test("multiple tool calls survive separate approval pauses without replaying completed effects", async () => {
  let round = 0;
  const stream: StreamFn = async function* () {
    if (++round === 1) {
      yield { type: "tool_call", id: "first", name: "effect", arguments: "{}" };
      yield { type: "tool_call", id: "second", name: "effect", arguments: "{}" };
    }
    yield { type: "done", finishReason: round === 1 ? "tool_calls" : "stop" };
  };
  const f = fixture(stream);
  const run = enqueueRun(f.db, f.events, { goal: "two approvals" });
  for (let step = 0; step < 3; step++) {
    const claimed = claimNext(f.db, f.events, "worker");
    if (!claimed) throw new Error("fixture");
    const outcome = await executeRun(f.deps, claimed);
    expect(f.effects()).toBe(step);
    if (step === 2) { expect(outcome).toBe("succeeded"); break; }
    expect(outcome).toBe("paused");
    const approval = f.db.query<{ id: string }, []>("SELECT id FROM approvals WHERE status='pending'").get();
    if (!approval) throw new Error("missing approval");
    decideApproval(f, { runId: run.id, approvalId: approval.id, decision: "approve" });
  }
  expect(round).toBe(2);
});

test("a timed-out tool receives cancellation and cannot perform a later cooperative effect", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let effects = 0;
  let cancelled = false;
  let finished: () => void = () => {};
  const toolFinished = new Promise<void>((resolve) => { finished = resolve; });
  let round = 0;
  const stream: StreamFn = async function* (...args) {
    if (++round === 1) yield* calls(...args);
    else yield { type: "done", finishReason: "stop" };
  };
  const f = fixture(stream, [{ action: "*", resource: "*", effect: "allow" }]);
  const tools = createRegistry([{ name: "effect", description: "delayed", parameters: {}, action: "edit", execute: async (_args, context) => {
    try { await gate; cancelled = context.signal?.aborted === true; context.signal?.throwIfAborted(); effects++; return "late"; }
    finally { finished(); }
  } }]);
  enqueueRun(f.db, f.events, { goal: "timeout" });
  const claimed = claimNext(f.db, f.events, "worker");
  if (!claimed) throw new Error("fixture");
  try {
    expect(await executeRun({ ...f.deps, tools }, claimed)).toBe("succeeded");
    expect(f.db.query("SELECT status FROM tool_calls").get()).toEqual({ status: "timeout" });
  } finally { release(); await toolFinished; }
  expect(cancelled).toBe(true);
  expect(effects).toBe(0);
});

test("a newly denied policy cannot be bypassed by an older approved call", async () => {
  let round = 0;
  const stream: StreamFn = async function* (...args) {
    if (++round === 1) yield* calls(...args);
    else yield { type: "done", finishReason: "stop" };
  };
  const f = fixture(stream);
  const run = enqueueRun(f.db, f.events, { goal: "policy changes" });
  const claimed = claimNext(f.db, f.events, "worker");
  if (!claimed) throw new Error("fixture");
  await executeRun(f.deps, claimed);
  const approval = f.db.query<{ id: string }, []>("SELECT id FROM approvals").get();
  if (!approval) throw new Error("fixture");
  decideApproval(f, { runId: run.id, approvalId: approval.id, decision: "approve" });
  const resumed = claimNext(f.db, f.events, "worker");
  if (!resumed) throw new Error("fixture");
  await executeRun({ ...f.deps, policy: [{ action: "*", resource: "*", effect: "deny" }] }, resumed);
  expect(f.effects()).toBe(0);
});

test("approving a pending call cannot resurrect a cancelled run", async () => {
  const f = fixture(calls);
  const run = enqueueRun(f.db, f.events, { goal: "cancel while paused" });
  const claimed = claimNext(f.db, f.events, "worker");
  if (!claimed) throw new Error("fixture");
  await executeRun(f.deps, claimed);
  const approval = f.db.query<{ id: string }, []>("SELECT id FROM approvals").get();
  if (!approval) throw new Error("fixture");
  f.db.query("UPDATE runs SET status='cancelled',cancel_intent='user' WHERE id=?").run(run.id);
  expect(() => decideApproval(f, { runId: run.id, approvalId: approval.id, decision: "approve" })).toThrow("run_not_awaiting_approval");
  expect(claimNext(f.db, f.events, "worker")).toBeNull();
  expect(f.effects()).toBe(0);
});

test("provider call IDs reused by separate runs do not replace each other's receipts", async () => {
  let round = 0;
  const stream: StreamFn = async function* (...args) {
    if (++round % 2 === 1) yield* calls(...args);
    else yield { type: "done", finishReason: "stop" };
  };
  const f = fixture(stream, [{ action: "*", resource: "*", effect: "allow" }]);
  const ids: string[] = [];
  for (const goal of ["first", "second"]) {
    const run = enqueueRun(f.db, f.events, { goal });
    ids.push(run.id);
    const claimed = claimNext(f.db, f.events, "worker");
    if (!claimed) throw new Error("fixture");
    expect(await executeRun(f.deps, claimed)).toBe("succeeded");
  }
  const rows = f.db.query<{ run_id: string }, []>("SELECT run_id FROM tool_calls ORDER BY run_id").all();
  expect(rows.map((row) => row.run_id)).toEqual(ids.sort());
  expect(f.effects()).toBe(2);
});
