import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { handleWorkflowRequest } from "../src/server/workflow-routes";
import { handleScheduleRequest } from "../src/server/schedule-routes";
import { dispatchDueSchedules } from "../src/scheduler/schedule-dispatch";
import { ensureTitleWorkflow } from "../src/workflows/title-run";

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
  const events = new EventLog(db);
  return { db, events, deps: { db, events } };
}

function request(method: string, path: string, payload?: unknown): Request {
  return new Request(`http://harness.local${path}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  });
}

const WorkflowBody = z.object({
  id: z.string(),
  title: z.string(),
  params: z.array(z.object({ name: z.string(), type: z.string() })),
});

describe("workflow API", () => {
  test("the title workflow is accessible through its encoded client URL", async () => {
    const { deps } = setup();
    ensureTitleWorkflow(deps);
    const response = await handleWorkflowRequest(
      request("GET", "/api/workflows/system%3Atitle"),
      deps,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      workflow: { id: "system:title", title: "대화 이름 짓기" },
    });
  });

  test("a definition is created, searched, read, patched and deleted with its binding", async () => {
    const { deps } = setup();
    const created = await handleWorkflowRequest(
      request("POST", "/api/workflows", {
        title: "아침 정리",
        instruction: "받은 편지를 정리한다",
        executor: { kind: "agent" },
        params: [{ name: "days", type: "number", default: 3 }],
      }),
      deps,
    );
    expect(created?.status).toBe(201);
    const workflow = WorkflowBody.parse(await created?.json());
    expect(workflow.title).toBe("아침 정리");
    expect(workflow.params).toEqual([{ name: "days", type: "number" }]);

    const searched = await handleWorkflowRequest(
      request("GET", "/api/workflows?keyword=편지"),
      deps,
    );
    const found = z
      .object({ workflows: z.array(z.object({ id: z.string() })) })
      .parse(await searched?.json());
    expect(found.workflows.map((row) => row.id)).toEqual([workflow.id]);

    const conflict = await handleWorkflowRequest(
      request("GET", "/api/workflows?keyword=편지&bm25=편지"),
      deps,
    );
    expect(conflict?.status).toBe(422);

    for (const query of ["bm25=편", "regex=("]) {
      const misuse = await handleWorkflowRequest(request("GET", `/api/workflows?${query}`), deps);
      expect(misuse?.status).toBe(422);
      const body = z.object({ error: z.string(), detail: z.unknown() }).parse(await misuse?.json());
      expect(body.error.startsWith("search_")).toBe(true);
    }

    const patched = await handleWorkflowRequest(
      request("PATCH", `/api/workflows/${workflow.id}`, { title: "저녁 정리" }),
      deps,
    );
    expect(patched?.status).toBe(200);
    const patchedBody = z
      .object({ workflow: z.object({ title: z.string() }) })
      .parse(await patched?.json());
    expect(patchedBody.workflow.title).toBe("저녁 정리");

    const binding = await handleScheduleRequest(
      request("POST", "/api/schedules", {
        workflowId: workflow.id,
        trigger: { kind: "interval", everySeconds: 900, anchorAt: new Date(BASE).toISOString() },
      }),
      deps,
    );
    expect(binding?.status).toBe(201);

    const refused = await handleWorkflowRequest(
      request("DELETE", `/api/workflows/${workflow.id}`),
      deps,
    );
    expect(refused?.status).toBe(409);
    expect(await refused?.json()).toMatchObject({ error: "schedules_present" });

    const removed = await handleWorkflowRequest(
      request("DELETE", `/api/workflows/${workflow.id}?cascade=1`),
      deps,
    );
    expect(removed?.status).toBe(200);
    expect(await removed?.json()).toMatchObject({
      deleted: true,
      removedSchedules: [expect.any(String)],
    });
  });

  test("an invalid parameter value is refused when the schedule is saved", async () => {
    const { deps } = setup();
    const created = await handleWorkflowRequest(
      request("POST", "/api/workflows", {
        title: "수집",
        instruction: "수집한다",
        executor: { kind: "agent" },
        params: [{ name: "days", type: "number", required: true }],
      }),
      deps,
    );
    const workflow = WorkflowBody.parse(await created?.json());
    const refused = await handleScheduleRequest(
      request("POST", "/api/schedules", {
        workflowId: workflow.id,
        trigger: { kind: "interval", everySeconds: 60, anchorAt: new Date(BASE).toISOString() },
        args: { days: "셋" },
      }),
      deps,
    );
    expect(refused?.status).toBe(422);
    expect(await refused?.json()).toMatchObject({ error: "invalid_params" });
  });

  test("run queues immediately and a manual schedule run records itself", async () => {
    const { db, deps } = setup();
    const created = await handleWorkflowRequest(
      request("POST", "/api/workflows", {
        title: "실행",
        instruction: "무언가 한다",
        executor: { kind: "agent" },
      }),
      deps,
    );
    const workflow = WorkflowBody.parse(await created?.json());

    const queued = await handleWorkflowRequest(
      request("POST", `/api/workflows/${workflow.id}/run`, { args: {} }),
      deps,
    );
    expect(queued?.status).toBe(201);

    const inline = await handleWorkflowRequest(
      request("POST", `/api/workflows/${workflow.id}/run`, { args: {}, async: false }),
      deps,
    );
    expect(inline?.status).toBe(422);
    expect(await inline?.json()).toMatchObject({ error: "run_not_inline" });
    const queuedBody = z
      .object({
        run: z.object({ id: z.string(), status: z.string() }),
        params: z.record(z.string(), z.unknown()),
      })
      .parse(await queued?.json());
    expect(queuedBody.run.status).toBe("queued");
    expect(queuedBody.params).toEqual({});

    const binding = await handleScheduleRequest(
      request("POST", "/api/schedules", {
        workflowId: workflow.id,
        trigger: { kind: "interval", everySeconds: 60, anchorAt: new Date(BASE).toISOString() },
      }),
      deps,
    );
    const schedule = z.object({ id: z.string() }).parse(await binding?.json());
    const listed = await handleScheduleRequest(
      request("GET", `/api/schedules?workflowId=${workflow.id}`),
      deps,
    );
    expect(
      z
        .object({ schedules: z.array(z.object({ workflowTitle: z.string() })) })
        .parse(await listed?.json()).schedules,
    ).toEqual([{ workflowTitle: "실행" }]);

    const manual = await handleScheduleRequest(
      request("POST", `/api/schedules/${schedule.id}/run`, {}),
      deps,
    );
    expect(manual?.status).toBe(201);
    const runs = await handleScheduleRequest(
      request("GET", `/api/schedules/${schedule.id}/runs`),
      deps,
    );
    const runsBody = z
      .object({ runs: z.array(z.object({ id: z.string(), manual: z.boolean() })) })
      .parse(await runs?.json());
    expect(runsBody.runs[0]?.manual).toBe(true);

    // The dispatch path uses the same workflow and records an automatic slot; the
    // manual run has to settle first, because an active run suppresses the slot.
    db.query("UPDATE runs SET status='succeeded', settled_at=? WHERE status='queued'").run(
      new Date(BASE).toISOString(),
    );
    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(BASE).toISOString(),
      schedule.id,
    );
    expect(dispatchDueSchedules(deps, BASE + 1_000).enqueued).toBe(1);
    expect(
      z
        .object({ runs: z.array(z.object({ manual: z.boolean() })) })
        .parse(
          await (
            await handleScheduleRequest(request("GET", `/api/schedules/${schedule.id}/runs`), deps)
          )?.json(),
        ).runs.length,
    ).toBe(2);
  });

  test("unknown ids answer 404", async () => {
    const { deps } = setup();
    expect((await handleWorkflowRequest(request("GET", "/api/workflows/nope"), deps))?.status).toBe(
      404,
    );
    expect((await handleScheduleRequest(request("GET", "/api/schedules/nope"), deps))?.status).toBe(
      404,
    );
    expect(
      (await handleWorkflowRequest(request("POST", "/api/workflows/nope/run", { args: {} }), deps))
        ?.status,
    ).toBe(404);
  });

  test("a malformed escaped workflow id answers 400", async () => {
    const { deps } = setup();
    const response = await handleWorkflowRequest(request("GET", "/api/workflows/%ZZ"), deps);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "invalid_workflow_id" });
  });
});
