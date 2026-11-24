import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { createRegistry } from "../src/tools/registry";
import { builtinTools, WORK_POLICY } from "../src/tools/builtins";
import type { AdapterEvent, StreamFn } from "../src/providers/openai";
import {
  claimNext,
  decideApproval,
  enqueueRun,
  executeRun,
  getRun,
  reconcileWork,
  validateDelegation,
  type WorkDeps,
} from "../src/surfaces/work/runner";

function scripted(steps: AdapterEvent[][]): StreamFn {
  let index = 0;
  return async function* () {
    const step = steps[Math.min(index, steps.length - 1)] ?? [];
    index += 1;
    for (const event of step) yield event;
  };
}

function setup(steps: AdapterEvent[][]) {
  const root = mkdtempSync(join(tmpdir(), "harness-work-"));
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const events = new EventLog(db);
  const deps: WorkDeps = {
    db,
    events,
    stream: scripted(steps),
    tools: createRegistry(builtinTools({ root })),
    policy: WORK_POLICY,
    limits: { firstTokenMs: 5_000, idleMs: 5_000, toolMs: 2_000, maxOutputTokens: 200, maxToolRounds: 3, totalMs: 30_000 },
    maxConcurrent: 2,
  };
  return { db, events, deps, root };
}

describe("work runner", () => {
  test("a queued run is claimed by lease and settles as succeeded with a written file", async () => {
    const { db, events, deps, root } = setup([
      [
        { type: "tool_call", id: "c1", name: "workspace_write", arguments: JSON.stringify({ path: "note.txt", text: "회의 준비물" }) },
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "text_delta", text: "파일을 작성했습니다." }, { type: "done", finishReason: "stop" }],
    ]);
    const run = enqueueRun(db, events, { goal: "메모를 파일로 남겨줘" });
    expect(run.status).toBe("queued");

    const claimed = claimNext(db, events, "w1");
    expect(claimed?.status).toBe("running");
    expect(claimed?.leaseOwner).toBe("w1");
    const outcome = await executeRun(deps, claimed!);
    expect(outcome).toBe("succeeded");

    const settled = getRun(db, run.id);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.leaseExpiresAt).toBeNull();
    expect(JSON.parse(settled?.resultJson ?? "{}")).toEqual({ text: "파일을 작성했습니다." });

    const written = await Bun.file(join(root, run.id, "note.txt")).text();
    expect(written).toBe("회의 준비물");
    const kinds = events.after(0).map((event) => event.kind);
    expect(kinds).toContain("run.queued");
    expect(kinds).toContain("tool.result");
    expect(kinds).toContain("run.settled");
  });

  test("an ask decision pauses the run, and approving resumes it to success", async () => {
    const { db, events, deps } = setup([
      [{ type: "tool_call", id: "c1", name: "external_action", arguments: JSON.stringify({ summary: "메일 발송" }) }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", text: "발송 절차를 마쳤습니다." }, { type: "done", finishReason: "stop" }],
    ]);
    const run = enqueueRun(db, events, { goal: "메일을 보내줘" });
    const claimed = claimNext(db, events, "w1")!;
    expect(await executeRun(deps, claimed)).toBe("paused");

    const paused = getRun(db, run.id);
    expect(paused?.status).toBe("awaiting_approval");
    const approval = db.query("SELECT id, status FROM approvals WHERE run_id = ?").get(run.id) as { id: string; status: string };
    expect(approval.status).toBe("pending");
    expect(events.after(0).map((event) => event.kind)).toContain("approval.requested");

    decideApproval({ db, events }, { runId: run.id, approvalId: approval.id, decision: "approve" });
    const resumed = claimNext(db, events, "w2")!;
    expect(resumed.id).toBe(run.id);
    expect(await executeRun(deps, resumed)).toBe("succeeded");
    expect(getRun(db, run.id)?.status).toBe("succeeded");
  });

  test("rejecting an approval continues the run with the denial as a tool result", async () => {
    const { db, events, deps } = setup([
      [{ type: "tool_call", id: "c1", name: "external_action", arguments: JSON.stringify({ summary: "게시" }) }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", text: "게시하지 않았습니다." }, { type: "done", finishReason: "stop" }],
    ]);
    const run = enqueueRun(db, events, { goal: "게시해줘" });
    await executeRun(deps, claimNext(db, events, "w1")!);
    const approval = db.query("SELECT id FROM approvals WHERE run_id = ?").get(run.id) as { id: string };
    decideApproval({ db, events }, { runId: run.id, approvalId: approval.id, decision: "reject" });

    const resumed = claimNext(db, events, "w2")!;
    expect(await executeRun(deps, resumed)).toBe("succeeded");
    const state = JSON.parse(getRun(db, run.id)?.stateJson ?? "{}") as { messages: { role: string; content: string }[] };
    expect(state.messages.some((message) => message.role === "tool" && message.content.includes("거부"))).toBe(true);
    expect(events.after(0).map((event) => event.kind)).toContain("tool.denied");
  });

  test("a paused run keeps no lease and the lease reconciler leaves it alone", async () => {
    const { db, events, deps } = setup([
      [{ type: "tool_call", id: "c1", name: "external_action", arguments: JSON.stringify({ summary: "게시" }) }, { type: "done", finishReason: "tool_calls" }],
    ]);
    const run = enqueueRun(db, events, { goal: "게시해줘" });
    await executeRun(deps, claimNext(db, events, "w1")!);

    const paused = getRun(db, run.id);
    expect(paused?.status).toBe("awaiting_approval");
    expect(paused?.leaseExpiresAt).toBeNull();
    expect(paused?.leaseOwner).toBeNull();

    const later = Date.now() + 10 * 60_000;
    expect(reconcileWork(db, events, later).interrupted).toBe(0);
    expect(getRun(db, run.id)?.status).toBe("awaiting_approval");
  });

  test("a dead worker's run is settled as interrupted once its lease expires", () => {
    const { db, events } = setup([[]]);
    const run = enqueueRun(db, events, { goal: "오래 걸리는 일" });
    claimNext(db, events, "w1", 2, Date.parse("2026-11-24T05:00:00Z"));
    const later = Date.parse("2026-11-24T06:00:00Z");
    const result = reconcileWork(db, events, later);
    expect(result.interrupted).toBe(1);
    const settled = getRun(db, run.id);
    expect(settled?.status).toBe("interrupted");
    expect(settled?.cancelIntent).toBe("host_restart");
  });

  test("the concurrency cap refuses to claim more runs", () => {
    const { db, events } = setup([[]]);
    enqueueRun(db, events, { goal: "첫 작업" });
    enqueueRun(db, events, { goal: "둘째 작업" });
    expect(claimNext(db, events, "w1", 1)).not.toBeNull();
    expect(claimNext(db, events, "w1", 1)).toBeNull();
  });

  test("delegation requires all five fields", () => {
    expect(validateDelegation({ goal: "조사" }).sort()).toEqual(["budget", "completionCondition", "inputRefs", "permissionProfile"]);
    expect(
      validateDelegation({
        goal: "조사",
        inputRefs: ["mail:1"],
        permissionProfile: "read-only",
        budget: { maxMicroUsd: 1_000, maxToolCalls: 5 },
        completionCondition: "출처가 붙은 요약",
      }),
    ).toEqual([]);
  });

  test("a delegated child reports progress to its parent run without touching the parent's own state", async () => {
    const { db, events, deps } = setup([[{ type: "text_delta", text: "조사 끝" }, { type: "done", finishReason: "stop" }]]);
    const parent = enqueueRun(db, events, { goal: "상위 작업" });
    const child = enqueueRun(db, events, { goal: "하위 조사", origin: "delegation", parentRunId: parent.id });
    expect(child.parentRunId).toBe(parent.id);
    db.query("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(parent.id);

    const claimed = claimNext(db, events, "w1", 2);
    expect(claimed?.id).toBe(child.id);
    expect(await executeRun(deps, claimed!)).toBe("succeeded");

    const progress = events.after(0).filter((event) => event.kind === "run.progress");
    expect(progress).toHaveLength(1);
    const payload = progress[0]?.payload as { childRunId: string; status: string; summary: string };
    expect(payload.childRunId).toBe(child.id);
    expect(payload.status).toBe("succeeded");
    expect(payload.summary).toBe("조사 끝");
    expect(getRun(db, parent.id)?.status).toBe("succeeded");
  });
});
