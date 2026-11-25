import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { getRun } from "../src/surfaces/work/runner";
import {
  bindingRuns,
  createBinding,
  deleteBinding,
  getBinding,
  listBindingViews,
  runBindingNow,
  updateBinding,
} from "../src/scheduler/schedule-store";
import { dispatchDueSchedules } from "../src/scheduler/schedule-dispatch";
import { createWorkflow } from "../src/workflows/workflow-store";

const databases: Database[] = [];
const BASE = Date.parse("2026-01-01T00:00:00.000Z");

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  db.query("DELETE FROM schedules").run();
  db.query("DELETE FROM workflows").run();
  db.query("DELETE FROM workflows_fts").run();
  return { db, events: new EventLog(db), deps: { db, events: new EventLog(db) } };
}

function count(db: Database, sql: string, ...bindings: SQLQueryBindings[]): number {
  return db.query<{ n: number }, SQLQueryBindings[]>(sql).get(...bindings)?.n ?? 0;
}

function definition(db: Database, events: EventLog, now = BASE) {
  return createWorkflow(
    db,
    {
      title: "15분 수집",
      instruction: "자료를 수집한다",
      executor: { kind: "builtin", name: "sync_sources", accountId: "acct-a" },
      params: [{ name: "source", type: "string", default: "gmail" }],
    },
    now,
    events,
  );
}

function intervalBinding(db: Database, events: EventLog, workflowId: string, now = BASE) {
  return createBinding(
    db,
    {
      workflowId,
      trigger: { kind: "interval", everySeconds: 60, anchorAt: new Date(now).toISOString() },
      args: { source: "gmail" },
    },
    now,
    events,
  );
}

describe("schedule bindings", () => {
  test("a binding is validated against the definition's parameters before it is stored", () => {
    const { db, events } = setup();
    const workflow = definition(db, events);
    expect(() =>
      createBinding(
        db,
        {
          workflowId: workflow.id,
          trigger: { kind: "interval", everySeconds: 60, anchorAt: new Date(BASE).toISOString() },
          args: { nope: 1 },
        },
        BASE,
        events,
      ),
    ).toThrow("invalid_params");
    expect(count(db, "SELECT count(*) AS n FROM schedules")).toBe(0);
  });

  test("editing the trigger recomputes the deadline, disabling clears it", () => {
    const { db, events } = setup();
    const workflow = definition(db, events);
    const binding = intervalBinding(db, events, workflow.id);
    expect(binding.nextRunAt).toBe(new Date(BASE + 60_000).toISOString());

    const daily = updateBinding(
      db,
      binding.id,
      { trigger: { kind: "daily", time: "07:30", timeZone: "Asia/Seoul" } },
      BASE,
      events,
    );
    expect(daily?.nextRunAt).toBe("2026-01-01T22:30:00.000Z");

    const paused = updateBinding(db, binding.id, { enabled: false }, BASE + 1, events);
    expect(paused?.enabled).toBe(false);
    expect(paused?.nextRunAt).toBeNull();

    const resumed = updateBinding(db, binding.id, { enabled: true }, BASE + 1, events);
    expect(resumed?.nextRunAt).not.toBeNull();
  });

  test("a manual run uses the binding's values, records itself, and leaves the deadline alone", () => {
    const { db, events } = setup();
    const workflow = definition(db, events);
    const binding = intervalBinding(db, events, workflow.id);
    const queued = runBindingNow({ db, events }, binding.id, { now: BASE });
    expect(queued).not.toBeNull();
    const run = getRun(db, queued?.run.id ?? "");
    expect(run?.workflowId).toBe(workflow.id);
    expect(run?.scheduleId).toBe(binding.id);
    expect(run?.triggerKind).toBe("manual");
    expect(JSON.parse(run?.paramsJson ?? "{}")).toEqual({ source: "gmail" });
    expect(getBinding(db, binding.id)?.nextRunAt).toBe(binding.nextRunAt);
    expect(bindingRuns(db, binding.id)?.[0]?.manual).toBe(true);
  });

  test("deleting a binding keeps its run history", () => {
    const { db, events } = setup();
    const workflow = definition(db, events);
    const binding = intervalBinding(db, events, workflow.id);
    const queued = runBindingNow({ db, events }, binding.id, { now: BASE });
    expect(deleteBinding(db, binding.id, events)).toBe(true);
    expect(getBinding(db, binding.id)).toBeNull();
    expect(getRun(db, queued?.run.id ?? "")?.scheduleId).toBe(binding.id);
    expect(
      count(db, "SELECT count(*) AS n FROM schedule_occurrences WHERE schedule_id IS NULL"),
    ).toBe(1);
  });
});

describe("dispatch", () => {
  test("a due binding enqueues exactly one run per slot and advances its deadline", () => {
    const { db, events, deps } = setup();
    const workflow = definition(db, events);
    const binding = intervalBinding(db, events, workflow.id);
    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(BASE).toISOString(),
      binding.id,
    );

    expect(dispatchDueSchedules(deps, BASE + 1_000).enqueued).toBe(1);
    expect(count(db, "SELECT count(*) AS n FROM runs")).toBe(1);
    const run = db
      .query<{ workflow_id: string; trigger_kind: string; params_json: string }, []>(
        "SELECT workflow_id,trigger_kind,params_json FROM runs",
      )
      .get();
    expect(run).toEqual({
      workflow_id: workflow.id,
      trigger_kind: "schedule",
      params_json: JSON.stringify({ source: "gmail" }),
    });
    expect(
      db
        .query<{ scheduled_for: string; manual: number }, []>(
          "SELECT scheduled_for,manual FROM schedule_occurrences",
        )
        .get(),
    ).toEqual({ scheduled_for: new Date(BASE).toISOString(), manual: 0 });

    expect(dispatchDueSchedules(deps, BASE + 1_100).enqueued).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM runs")).toBe(1);
  });

  test("an active run of the same binding suppresses the next slot instead of stacking", () => {
    const { db, events, deps } = setup();
    const workflow = definition(db, events);
    const binding = intervalBinding(db, events, workflow.id);
    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(BASE).toISOString(),
      binding.id,
    );
    expect(dispatchDueSchedules(deps, BASE + 1_000).enqueued).toBe(1);

    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(BASE + 60_000).toISOString(),
      binding.id,
    );
    const second = dispatchDueSchedules(deps, BASE + 61_000);
    expect(second.enqueued).toBe(0);
    expect(second.skipped).toBe(1);
    expect(count(db, "SELECT count(*) AS n FROM runs")).toBe(1);
  });

  test("a disabled binding never runs", () => {
    const { db, events, deps } = setup();
    const workflow = definition(db, events);
    const binding = intervalBinding(db, events, workflow.id);
    updateBinding(db, binding.id, { enabled: false }, BASE, events);
    expect(dispatchDueSchedules(deps, BASE + 120_000).enqueued).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM runs")).toBe(0);
  });

  test("a binding whose definition vanished is paused with the reason recorded", () => {
    const { db, events, deps } = setup();
    const workflow = definition(db, events);
    const binding = intervalBinding(db, events, workflow.id);
    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(BASE).toISOString(),
      binding.id,
    );
    // Simulate a row that escaped the foreign key (a restored backup, for example).
    db.exec("PRAGMA foreign_keys=OFF");
    db.query("DELETE FROM workflows WHERE id = ?").run(workflow.id);
    db.exec("PRAGMA foreign_keys=ON");

    const stats = dispatchDueSchedules(deps, BASE + 1_000);
    expect(stats.disabled).toBe(1);
    expect(getBinding(db, binding.id)?.enabled).toBe(false);
    const event = db
      .query<{ payload_json: string }, []>(
        "SELECT payload_json FROM events WHERE kind='schedule.updated' ORDER BY seq DESC LIMIT 1",
      )
      .get();
    expect(JSON.parse(event?.payload_json ?? "{}")).toMatchObject({ reason: "workflow_missing" });
  });

  test("a daily slot fires at its configured zone, not the server's clock", () => {
    const { db, events, deps } = setup();
    const workflow = definition(db, events);
    const binding = createBinding(
      db,
      {
        workflowId: workflow.id,
        trigger: { kind: "daily", time: "07:30", timeZone: "Asia/Seoul" },
      },
      BASE,
      events,
    );
    const slot = Date.parse("2025-12-31T22:30:00.000Z");
    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(slot).toISOString(),
      binding.id,
    );
    expect(dispatchDueSchedules(deps, slot + 1_000).enqueued).toBe(1);
    expect(listBindingViews(db, workflow.id)[0]?.nextRunAt).toBe("2026-01-01T22:30:00.000Z");
  });
});
