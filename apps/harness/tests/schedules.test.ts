import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { enqueueRun, getRun } from "../src/surfaces/work/runner";
import { cancelRun } from "../src/surfaces/work/cancel";
import {
  CreateScheduleSchema,
  createSchedule,
  deleteSchedule,
  dispatchDueSchedules,
  getSchedule,
  listSchedules,
  runScheduleNow,
  scheduleRuns,
  updateSchedule,
} from "../src/scheduler/schedules";
import { ScheduleTriggerSchema, nextDueAfter, wallToInstant } from "../src/scheduler/triggers";
import { scheduleTools } from "../src/tools/schedules";
import { handleScheduleRequest } from "../src/server/schedule-routes";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(options: { readonly seeds?: boolean } = {}) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  if (!options.seeds) db.query("DELETE FROM schedules").run();
  const events = new EventLog(db);
  return { db, events, deps: { db, events } };
}

function count(db: Database, sql: string, ...bindings: SQLQueryBindings[]): number {
  const row = db.query<{ n: number }, SQLQueryBindings[]>(sql).get(...bindings);
  return row?.n ?? 0;
}

const BASE = Date.parse("2026-01-01T00:00:00.000Z");

function intervalInput(now = BASE) {
  return {
    title: "15분 수집",
    instruction: "자료를 수집한다",
    enabled: true,
    trigger: { kind: "interval" as const, everySeconds: 60, anchorAt: new Date(now).toISOString() },
    executor: { kind: "builtin" as const, name: "sync_sources" as const },
    timeoutSeconds: 120,
  };
}

function request(method: string, path: string, payload?: unknown): Request {
  return new Request(`http://harness.local${path}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  });
}

async function jsonOf(response: Response | null): Promise<unknown> {
  if (!response) throw new Error("missing_response");
  const value: unknown = await response.json();
  return value;
}

const CreatedView = z.object({ id: z.string(), timeoutSeconds: z.number() });
const ListView = z.object({
  schedules: z.array(z.object({ id: z.string(), lastRun: z.unknown() })),
});
const PatchView = z.object({
  title: z.string(),
  instruction: z.string(),
  enabled: z.boolean(),
  timeoutSeconds: z.number(),
});
const ManualView = z.object({
  run: z.object({ id: z.string(), status: z.string() }),
  occurrence: z.object({ manual: z.boolean(), scheduledFor: z.string() }),
});
const HistoryView = z.object({
  runs: z.array(z.object({ id: z.string(), scheduledFor: z.string(), manual: z.boolean() })),
});
const CancelView = z.object({
  run: z.object({
    status: z.string(),
    cancelIntent: z.string().nullable(),
    settledAt: z.string().nullable(),
  }),
  cancelled: z.boolean(),
});
const ToolCreate = z.object({ schedule: z.object({ id: z.string(), title: z.string() }) });
const ToolList = z.object({
  schedules: z.array(z.object({ id: z.string(), title: z.string() })),
});
const ToolUpdate = z.object({ schedule: z.object({ title: z.string() }) });
const ToolRun = z.object({ run: z.object({ status: z.string() }) });
const ToolDelete = z.object({ deleted: z.boolean() });

describe("schedule definitions", () => {
  test("seeded system schedules exist and dispatch initializes daily deadlines without firing", () => {
    const { db, deps } = setup({ seeds: true });
    const before = listSchedules(db);
    expect(before).toHaveLength(3);
    const sync = before.find((row) => row.id === "system-sync");
    const morning = before.find((row) => row.id === "system-briefing-morning");
    expect(sync?.nextRunAt).not.toBeNull();
    expect(morning?.nextRunAt).toBeNull();

    const stats = dispatchDueSchedules(deps, Date.parse("2020-01-01T00:00:00.000Z"));
    expect(stats.enqueued).toBe(0);
    const after = listSchedules(db);
    for (const id of ["system-briefing-morning", "system-briefing-evening"]) {
      expect(after.find((row) => row.id === id)?.nextRunAt).not.toBeNull();
    }
    expect(count(db, "SELECT count(*) AS n FROM runs")).toBe(0);
  });

  test("interval catch-up enqueues the latest missed slot only once", () => {
    const { db, deps } = setup();
    const schedule = createSchedule(db, intervalInput(), BASE);
    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(BASE).toISOString(),
      schedule.id,
    );
    const now = BASE + 330_000;
    expect(dispatchDueSchedules(deps, now).enqueued).toBe(1);
    expect(dispatchDueSchedules(deps, now).enqueued).toBe(0);
    const rows = db
      .query<{ scheduled_for: string; manual: number }, SQLQueryBindings[]>(
        "SELECT scheduled_for, manual FROM schedule_occurrences WHERE schedule_id = ?",
      )
      .all(schedule.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scheduled_for).toBe(new Date(BASE + 300_000).toISOString());
    expect(rows[0]?.manual).toBe(0);
    const run = getRun(db, db.query<{ run_id: string }, SQLQueryBindings[]>(
      "SELECT run_id FROM schedule_occurrences WHERE schedule_id = ?",
    ).get(schedule.id)?.run_id ?? "");
    expect(run?.origin).toBe("work");
    expect(run?.goal).toBe("자료를 수집한다");
    expect(run?.executorJson).toBe('{"kind":"builtin","name":"sync_sources"}');
    expect(run?.timeoutSeconds).toBe(120);
    expect(getSchedule(db, schedule.id)?.nextRunAt).toBe(new Date(BASE + 360_000).toISOString());
  });

  test("the occurrence unique key is the only owner of a slot", () => {
    const { db, deps } = setup();
    const schedule = createSchedule(db, intervalInput(), BASE);
    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(BASE).toISOString(),
      schedule.id,
    );
    dispatchDueSchedules(deps, BASE + 60_000);
    const occurrence = db
      .query<{ scheduled_for: string }, SQLQueryBindings[]>(
        "SELECT scheduled_for FROM schedule_occurrences WHERE schedule_id = ?",
      )
      .get(schedule.id);
    if (!occurrence) throw new Error("fixture");
    const other = enqueueRun(db, deps.events, { goal: "다른 실행" });
    expect(() =>
      db
        .query(
          "INSERT INTO schedule_occurrences (id,schedule_id,schedule_title,scheduled_for,run_id,manual,created_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          crypto.randomUUID(),
          schedule.id,
          schedule.title,
          occurrence.scheduled_for,
          other.id,
          0,
          new Date().toISOString(),
        ),
    ).toThrow();
  });

  test("a one-shot runs at most once and then keeps no deadline", () => {
    const { db, deps } = setup();
    const at = BASE + 60_000;
    const schedule = createSchedule(
      db,
      {
        title: "한 번",
        instruction: "한 번 실행",
        enabled: true,
        trigger: { kind: "once", at: new Date(at).toISOString() },
        executor: { kind: "agent" },
        timeoutSeconds: 60,
      },
      BASE,
    );
    expect(dispatchDueSchedules(deps, at + 1).enqueued).toBe(1);
    expect(getSchedule(db, schedule.id)?.nextRunAt).toBeNull();
    expect(dispatchDueSchedules(deps, at + 86_400_000).enqueued).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM schedule_occurrences WHERE schedule_id = ?", schedule.id)).toBe(1);
  });

  test("daily DST fall-back fires once for the repeated local time", () => {
    const { db, deps } = setup();
    const schedule = createSchedule(
      db,
      {
        title: "DST",
        instruction: "뉴욕 01:30",
        enabled: true,
        trigger: { kind: "daily", time: "01:30", timeZone: "America/New_York" },
        executor: { kind: "agent" },
        timeoutSeconds: 60,
      },
      Date.parse("2026-10-31T00:00:00.000Z"),
    );
    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      "2026-11-01T05:30:00.000Z",
      schedule.id,
    );
    const first = wallToInstant(2026, 11, 1, 1, 30, "America/New_York");
    if (first === null) throw new Error("ambiguous time must resolve");
    expect(new Date(first).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(dispatchDueSchedules(deps, Date.parse("2026-11-01T05:45:00.000Z")).enqueued).toBe(1);
    expect(dispatchDueSchedules(deps, Date.parse("2026-11-01T07:30:00.000Z")).enqueued).toBe(0);
    const slots = db
      .query<{ scheduled_for: string }, SQLQueryBindings[]>(
        "SELECT scheduled_for FROM schedule_occurrences WHERE schedule_id = ? ORDER BY scheduled_for",
      )
      .all(schedule.id)
      .map((row) => row.scheduled_for);
    expect(slots).toEqual(["2026-11-01T01:30:00"]);
    expect(getSchedule(db, schedule.id)?.nextRunAt).toBe("2026-11-02T06:30:00.000Z");

    db.query("UPDATE runs SET status='succeeded', settled_at=? WHERE id IN (SELECT run_id FROM schedule_occurrences WHERE schedule_id=?)").run(
      new Date(Date.parse("2026-11-01T07:00:00.000Z")).toISOString(),
      schedule.id,
    );
    expect(dispatchDueSchedules(deps, Date.parse("2026-11-02T06:30:01.000Z")).enqueued).toBe(1);
    expect(
      db
        .query<{ scheduled_for: string }, SQLQueryBindings[]>(
          "SELECT scheduled_for FROM schedule_occurrences WHERE schedule_id = ? ORDER BY scheduled_for",
        )
        .all(schedule.id)
        .map((row) => row.scheduled_for),
    ).toEqual(["2026-11-01T01:30:00", "2026-11-02T01:30:00"]);
  });

  test("daily coalesces several missed local days into the latest slot", () => {
    const { db, deps } = setup();
    const schedule = createSchedule(
      db,
      {
        title: "missed days",
        instruction: "뉴욕 01:30",
        enabled: true,
        trigger: { kind: "daily", time: "01:30", timeZone: "America/New_York" },
        executor: { kind: "agent" },
        timeoutSeconds: 60,
      },
      Date.parse("2026-10-28T00:00:00.000Z"),
    );
    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      "2026-10-29T05:30:00.000Z",
      schedule.id,
    );
    expect(dispatchDueSchedules(deps, Date.parse("2026-11-01T05:45:00.000Z")).enqueued).toBe(1);
    const slots = db
      .query<{ scheduled_for: string }, SQLQueryBindings[]>(
        "SELECT scheduled_for FROM schedule_occurrences WHERE schedule_id = ?",
      )
      .all(schedule.id);
    expect(slots.map((row) => row.scheduled_for)).toEqual(["2026-11-01T01:30:00"]);
  });

  test("daily DST spring-forward skips a nonexistent wall time", () => {
    const { db } = setup();
    const schedule = createSchedule(
      db,
      {
        title: "spring",
        instruction: "뉴욕 02:30",
        enabled: true,
        trigger: { kind: "daily", time: "02:30", timeZone: "America/New_York" },
        executor: { kind: "agent" },
        timeoutSeconds: 60,
      },
      Date.parse("2026-03-08T04:00:00.000Z"),
    );
    expect(schedule.nextRunAt).toBe("2026-03-09T06:30:00.000Z");
    expect(wallToInstant(2026, 3, 8, 2, 30, "America/New_York")).toBeNull();
  });

  test("pause, edit and delete preserve occurrence and run history", () => {
    const { db, deps } = setup();
    const schedule = createSchedule(db, intervalInput(), BASE);
    const first = runScheduleNow(deps, schedule.id, BASE + 1_000);
    const second = runScheduleNow(deps, schedule.id, BASE + 2_000);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const paused = updateSchedule(db, schedule.id, { enabled: false }, BASE + 3_000);
    expect(paused?.enabled).toBe(false);
    expect(paused?.nextRunAt).toBeNull();
    expect(dispatchDueSchedules(deps, BASE + 86_400_000).enqueued).toBe(0);

    const edited = updateSchedule(
      db,
      schedule.id,
      { title: "새 제목", instruction: "새 지시" },
      BASE + 4_000,
    );
    expect(edited?.title).toBe("새 제목");
    const snapshots = db
      .query<{ schedule_title: string }, SQLQueryBindings[]>(
        "SELECT schedule_title FROM schedule_occurrences WHERE schedule_id = ? ORDER BY created_at",
      )
      .all(schedule.id);
    expect(snapshots.map((row) => row.schedule_title)).toEqual(["15분 수집", "15분 수집"]);
    expect(getRun(db, first?.run.id ?? "")?.goal).toBe("자료를 수집한다");

    expect(deleteSchedule(db, schedule.id)).toBe(true);
    expect(getSchedule(db, schedule.id)).toBeNull();
    const orphaned = db
      .query<{ schedule_id: string | null }, SQLQueryBindings[]>(
        "SELECT schedule_id FROM schedule_occurrences",
      )
      .all();
    expect(orphaned).toHaveLength(2);
    expect(orphaned.every((row) => row.schedule_id === null)).toBe(true);
    expect(scheduleRuns(db, schedule.id)).toBeNull();
    expect(getRun(db, second?.run.id ?? "")?.status).toBe("queued");
  });

  test("manual run is explicit, records manual, and never moves the automatic deadline", () => {
    const { db, deps } = setup();
    const schedule = createSchedule(db, { ...intervalInput(), enabled: false }, BASE);
    expect(schedule.nextRunAt).toBeNull();
    const queued = runScheduleNow(deps, schedule.id, BASE + 5_000);
    expect(queued).not.toBeNull();
    expect(getSchedule(db, schedule.id)?.nextRunAt).toBeNull();
    const occurrence = db
      .query<{ manual: number; scheduled_for: string }, SQLQueryBindings[]>(
        "SELECT manual, scheduled_for FROM schedule_occurrences WHERE schedule_id = ?",
      )
      .get(schedule.id);
    expect(occurrence?.manual).toBe(1);
    expect(occurrence?.scheduled_for).toBe(new Date(BASE + 5_000).toISOString());
  });

  test("invalid triggers, time zones, deadlines and executors are rejected", () => {
    const { db } = setup();
    const base = intervalInput();
    expect(() =>
      createSchedule(db, { ...base, timeoutSeconds: 0 }),
    ).toThrow();
    expect(() =>
      createSchedule(db, {
        ...base,
        trigger: { kind: "daily", time: "25:00", timeZone: "UTC" },
      }),
    ).toThrow();
    expect(() =>
      createSchedule(db, {
        ...base,
        trigger: { kind: "daily", time: "07:30", timeZone: "Mars/Olympus" },
      }),
    ).toThrow();
    expect(() =>
      createSchedule(db, {
        ...base,
        trigger: { kind: "interval", everySeconds: 0, anchorAt: new Date(BASE).toISOString() },
      }),
    ).toThrow();
    expect(
      CreateScheduleSchema.safeParse({
        ...base,
        executor: { kind: "builtin", name: "not_a_builtin" },
      }).success,
    ).toBe(false);
    expect(ScheduleTriggerSchema.safeParse({ kind: "once", at: "nope" }).success).toBe(false);
    expect(nextDueAfter(intervalInput().trigger, BASE)).toBe(BASE + 60_000);
  });
});

describe("schedule management routes", () => {
  test("CRUD, manual run, history and cancellation keep one run state", async () => {
    const { db, deps } = setup();
    const created = await handleScheduleRequest(
      request("POST", "/api/schedules", {
        title: "정리",
        instruction: "메일을 정리한다",
        enabled: true,
        trigger: { kind: "once", at: new Date(BASE + 60_000).toISOString() },
        executor: { kind: "agent" },
        timeoutSeconds: 300,
      }),
      deps,
    );
    expect(created?.status).toBe(201);
    const schedule = CreatedView.parse(await jsonOf(created));
    expect(schedule.timeoutSeconds).toBe(300);

    const listed = await handleScheduleRequest(request("GET", "/api/schedules"), deps);
    const view = ListView.parse(await jsonOf(listed));
    expect(view.schedules).toHaveLength(1);
    expect(view.schedules[0]?.id).toBe(schedule.id);
    expect(view.schedules[0]?.lastRun).toBeNull();

    const patched = await handleScheduleRequest(
      request("PATCH", `/api/schedules/${schedule.id}`, { title: "정리2", enabled: false }),
      deps,
    );
    expect(patched?.status).toBe(200);
    const patchedBody = PatchView.parse(await jsonOf(patched));
    expect(patchedBody.title).toBe("정리2");
    expect(patchedBody.enabled).toBe(false);
    expect(patchedBody.instruction).toBe("메일을 정리한다");
    expect(patchedBody.timeoutSeconds).toBe(300);

    const manual = await handleScheduleRequest(
      request("POST", `/api/schedules/${schedule.id}/run`),
      deps,
    );
    expect(manual?.status).toBe(201);
    const manualBody = ManualView.parse(await jsonOf(manual));
    expect(manualBody.run.status).toBe("queued");
    expect(manualBody.occurrence.manual).toBe(true);

    const history = await handleScheduleRequest(
      request("GET", `/api/schedules/${schedule.id}/runs`),
      deps,
    );
    expect(history?.status).toBe(200);
    const historyBody = HistoryView.parse(await jsonOf(history));
    expect(historyBody.runs).toHaveLength(1);
    expect(historyBody.runs[0]?.id).toBe(manualBody.run.id);
    expect(historyBody.runs[0]?.scheduledFor).toBe(manualBody.occurrence.scheduledFor);

    const cancel = await handleScheduleRequest(
      request("POST", `/api/runs/${manualBody.run.id}/cancel`),
      deps,
    );
    expect(cancel?.status).toBe(200);
    const cancelledBody = CancelView.parse(await jsonOf(cancel));
    expect(cancelledBody.cancelled).toBe(true);
    expect(cancelledBody.run.status).toBe("cancelled");
    expect(cancelledBody.run.cancelIntent).toBe("user");
    expect(cancelledBody.run.settledAt).not.toBeNull();

    const deleted = await handleScheduleRequest(
      request("DELETE", `/api/schedules/${schedule.id}`),
      deps,
    );
    expect(deleted?.status).toBe(200);
    expect(count(db, "SELECT count(*) AS n FROM schedule_occurrences")).toBe(1);
    const missing = await handleScheduleRequest(
      request("GET", `/api/schedules/${schedule.id}/runs`),
      deps,
    );
    expect(missing?.status).toBe(404);

    const unrelated = await handleScheduleRequest(request("GET", "/api/runs"), deps);
    expect(unrelated).toBeNull();
    const kinds = deps.events.after(0).map((event) => event.kind);
    for (const kind of [
      "schedule.created",
      "schedule.updated",
      "schedule.run",
      "schedule.deleted",
    ])
      expect(kinds).toContain(kind);
  });

  test("cancelling an awaiting-approval run closes its pending approval and tool call", () => {
    const { db, deps } = setup();
    const run = enqueueRun(db, deps.events, { goal: "승인 대기" });
    const iso = new Date(BASE).toISOString();
    db.query(
      "INSERT INTO tool_calls (id,run_id,name,arguments_json,status,started_at) VALUES (?,?,?,?,?,?)",
    ).run("tc-1", run.id, "external_action", "{}", "pending", iso);
    db.query(
      "INSERT INTO approvals (id,run_id,tool_call_id,status,requested_at) VALUES (?,?,?,?,?)",
    ).run("ap-1", run.id, "tc-1", "pending", iso);
    db.query("UPDATE runs SET status='awaiting_approval' WHERE id=?").run(run.id);

    const result = cancelRun(deps, run.id, BASE + 1_000);
    expect(result?.status).toBe("cancelled");
    expect(getRun(db, run.id)?.status).toBe("cancelled");
    expect(getRun(db, run.id)?.cancelIntent).toBe("user");
    expect(
      db.query<{ status: string }, []>("SELECT status FROM approvals WHERE id='ap-1'").get()?.status,
    ).toBe("expired");
    expect(
      db.query<{ status: string }, []>("SELECT status FROM tool_calls WHERE id='tc-1'").get()
        ?.status,
    ).toBe("interrupted");
    expect(deps.events.after(0).filter((event) => event.kind === "run.cancelled")).toHaveLength(1);
    expect(cancelRun(deps, run.id, BASE + 2_000)?.changed).toBe(false);
  });
});

describe("schedule tools", () => {
  test("tools are conversation-safe and definition mutations never enqueue work", async () => {
    const { db, deps } = setup();
    const tools = scheduleTools(deps);
    expect(tools.map((tool) => tool.name)).toEqual(["schedules_list", "schedules_edit"]);
    expect(tools.every((tool) => tool.conversation === true)).toBe(true);
    expect(tools[0]?.action).toBe("read");
    expect(tools[1]?.action).toBe("edit");
    const list = tools[0];
    const edit = tools[1];
    if (!list || !edit) throw new Error("fixture");
    const context = { runId: "conversation" };

    const createResult = await edit.execute(
      {
        action: "create",
        ...intervalInput(),
      },
      context,
    );
    expect(ToolCreate.parse(JSON.parse(createResult)).schedule.title).toBe("15분 수집");
    expect(count(db, "SELECT count(*) AS n FROM runs")).toBe(0);

    const listed = ToolList.parse(JSON.parse(await list.execute({}, context)));
    expect(listed.schedules).toHaveLength(1);
    const id = listed.schedules[0]?.id ?? "";

    const updated = ToolUpdate.parse(
      JSON.parse(await edit.execute({ action: "update", id, title: "바뀐 제목" }, context)),
    );
    expect(updated.schedule.title).toBe("바뀐 제목");
    expect(count(db, "SELECT count(*) AS n FROM runs")).toBe(0);

    const ran = ToolRun.parse(JSON.parse(await edit.execute({ action: "run", id }, context)));
    expect(ran.run.status).toBe("queued");
    expect(count(db, "SELECT count(*) AS n FROM runs")).toBe(1);

    expect(
      ToolDelete.parse(JSON.parse(await edit.execute({ action: "delete", id }, context))).deleted,
    ).toBe(true);
    expect(count(db, "SELECT count(*) AS n FROM schedules")).toBe(0);
    const kinds = deps.events.after(0).map((event) => event.kind);
    for (const kind of [
      "schedule.created",
      "schedule.updated",
      "schedule.run",
      "schedule.deleted",
    ])
      expect(kinds).toContain(kind);
  });

  test("create defaults missing fields and a partial edit never resets them", async () => {
    const { db, deps } = setup();
    const edit = scheduleTools(deps).find((tool) => tool.name === "schedules_edit");
    if (!edit) throw new Error("fixture");
    const context = { runId: "conversation" };
    const ToolCreated = z.object({ schedule: z.object({ id: z.string() }) });
    const anchorAt = new Date(BASE).toISOString();
    const created = ToolCreated.parse(
      JSON.parse(
        await edit.execute(
          {
            action: "create",
            title: "제목",
            instruction: "지시",
            trigger: { kind: "interval", everySeconds: 60, anchorAt },
            executor: { kind: "agent" },
            timeoutSeconds: 600,
          },
          context,
        ),
      ),
    );
    const id = created.schedule.id;
    const before = getSchedule(db, id);
    expect(before?.enabled).toBe(true);
    expect(before?.timeoutSeconds).toBe(600);

    const defaults = ToolCreated.parse(
      JSON.parse(
        await edit.execute(
          {
            action: "create",
            title: "기본값",
            instruction: "지시",
            trigger: { kind: "interval", everySeconds: 60, anchorAt },
            executor: { kind: "agent" },
          },
          context,
        ),
      ),
    );
    const defaulted = getSchedule(db, defaults.schedule.id);
    expect(defaulted?.enabled).toBe(true);
    expect(defaulted?.timeoutSeconds).toBe(1_800);

    await edit.execute({ action: "update", id, enabled: false }, context);
    const disabled = getSchedule(db, id);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.title).toBe("제목");
    expect(disabled?.instruction).toBe("지시");
    expect(disabled?.timeoutSeconds).toBe(600);
    expect(disabled?.trigger).toEqual({ kind: "interval", everySeconds: 60, anchorAt });

    await edit.execute({ action: "update", id, title: "새 제목" }, context);
    const titled = getSchedule(db, id);
    expect(titled?.title).toBe("새 제목");
    expect(titled?.enabled).toBe(false);
    expect(titled?.instruction).toBe("지시");
    expect(titled?.timeoutSeconds).toBe(600);
  });
});

describe("dispatch concurrency", () => {
  test("two dispatcher processes racing one SQLite file produce exactly one occurrence", async () => {
    const root = mkdtempSync(join(tmpdir(), "schedule-race-"));
    const path = join(root, "schedules.db");
    const gate = join(root, "go");
    const seed = openDatabase(path);
    seed.query("DELETE FROM schedules").run();
    const schedule = createSchedule(seed, intervalInput(), BASE);
    seed
      .query("UPDATE schedules SET next_run_at = ? WHERE id = ?")
      .run(new Date(BASE).toISOString(), schedule.id);
    seed.close();

    const code = `
      import { existsSync } from "node:fs";
      import { openDatabase } from "./src/store/db";
      import { EventLog } from "./src/events/log";
      import { dispatchDueSchedules } from "./src/scheduler/schedule-dispatch";
      const db = openDatabase(process.env.TEST_DB);
      console.log("ready");
      while (!existsSync(process.env.TEST_GATE)) await Bun.sleep(1);
      const stats = dispatchDueSchedules(
        { db, events: new EventLog(db) },
        Number(process.env.TEST_NOW),
      );
      console.log(JSON.stringify(stats));
      db.close();
    `;
    const spawnOne = () =>
      Bun.spawn([process.execPath, "-e", code], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          TEST_DB: path,
          TEST_GATE: gate,
          TEST_NOW: String(BASE + 60_000),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    const workers = [spawnOne(), spawnOne()];
    try {
      const readers = workers.map((worker) => worker.stdout.getReader());
      await Promise.all(
        readers.map(async (reader) => {
          const first = await reader.read();
          expect(new TextDecoder().decode(first.value).trim()).toBe("ready");
        }),
      );
      await Bun.write(gate, "go");
      const outputs = await Promise.all(
        readers.map(async (reader) => {
          let text = "";
          while (true) {
            const next = await reader.read();
            if (next.done) return text;
            text += new TextDecoder().decode(next.value);
          }
        }),
      );
      expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual([0, 0]);
      const stats = outputs.map((text) =>
        z.object({ enqueued: z.number(), skipped: z.number() }).parse(JSON.parse(text.trim())),
      );
      expect(stats.reduce((total, row) => total + row.enqueued, 0)).toBe(1);

      const db = openDatabase(path);
      try {
        expect(
          count(
            db,
            "SELECT count(*) AS n FROM schedule_occurrences WHERE schedule_id = ?",
            schedule.id,
          ),
        ).toBe(1);
        expect(count(db, "SELECT count(*) AS n FROM runs")).toBe(1);
        const link = db
          .query<{ run_id: string }, SQLQueryBindings[]>(
            "SELECT run_id FROM schedule_occurrences WHERE schedule_id = ?",
          )
          .get(schedule.id);
        expect(getRun(db, link?.run_id ?? "")?.goal).toBe("자료를 수집한다");
      } finally {
        db.close();
      }
    } finally {
      for (const worker of workers) worker.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
