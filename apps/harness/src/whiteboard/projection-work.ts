import type { Database } from "bun:sqlite";
import { isRecord, type WhiteboardDraft } from "./document";
import { documentIdForOrigin } from "./document";
import { clean, datedPath, draft, iso, parseJson, stringField } from "./projection-format";

type WorkflowRow = {
  id: string;
  title: string;
  instruction: string;
  executor_json: string;
  params_json: string;
  timeout_seconds: number;
  created_at: string;
  updated_at: string;
};

export function workflowDrafts(db: Database, nowIso: string): WhiteboardDraft[] {
  return db
    .query<WorkflowRow, []>(
      `SELECT id,title,instruction,executor_json,params_json,timeout_seconds,created_at,updated_at
         FROM workflows ORDER BY created_at, id`,
    )
    .all()
    .map((row) =>
      draft({
        originKey: `workflow:${row.id}`,
        directory: "workspaces",
        leaf: `workspaces/${documentIdForOrigin(`workflow:${row.id}`)}.md`,
        kind: "commitment",
        title: row.title,
        source: { type: "workflow", workflowId: row.id },
        status: "active",
        createdAt: iso(row.created_at, nowIso),
        updatedAt: iso(row.updated_at, nowIso),
        text: [
          row.instruction,
          "",
          `- 실행기: ${row.executor_json}`,
          `- 파라미터: ${row.params_json}`,
          `- 타임아웃: ${row.timeout_seconds}s`,
        ].join("\n"),
      }),
    );
}

type RunRow = {
  id: string;
  goal: string;
  status: string;
  result_json: string | null;
  state_json: string | null;
  workflow_id: string | null;
  workflow_title: string | null;
  schedule_id: string | null;
  trigger_kind: string | null;
  params_json: string;
  created_at: string;
  settled_at: string | null;
};

export function runDrafts(db: Database, nowIso: string): WhiteboardDraft[] {
  return db
    .query<RunRow, []>(
      `SELECT id,goal,status,result_json,state_json,workflow_id,workflow_title,schedule_id,trigger_kind,params_json,created_at,settled_at
         FROM runs ORDER BY created_at DESC, id`,
    )
    .all()
    .map((row) =>
      draft({
        originKey: `run:${row.id}`,
        directory: "runs",
        leaf: datedPath({
          group: "runs",
          title: row.workflow_title ?? clean(row.goal, row.id),
          at: row.created_at,
          id: documentIdForOrigin(`run:${row.id}`),
        }),
        kind: "commitment",
        title: row.workflow_title ?? clean(row.goal, row.id),
        source: {
          type: "run",
          runId: row.id,
          workflowId: row.workflow_id,
          scheduleId: row.schedule_id,
          triggerKind: row.trigger_kind,
        },
        status: row.status,
        createdAt: iso(row.created_at, nowIso),
        updatedAt: iso(row.settled_at ?? row.created_at, nowIso),
        text: [
          `- 실행 id: ${row.id}`,
          `- 목표: ${row.goal}`,
          `- 상태: ${row.status}`,
          ...(row.workflow_id === null ? [] : [`- 워크플로: ${row.workflow_id}`]),
          ...(row.schedule_id === null ? [] : [`- 스케줄: ${row.schedule_id}`]),
          ...(row.trigger_kind === null ? [] : [`- 트리거: ${row.trigger_kind}`]),
          `- 파라미터: ${row.params_json}`,
          "",
          row.result_json === null ? "" : `결과\n${row.result_json}`,
          row.state_json === null ? "" : `상태\n${row.state_json}`,
        ].join("\n"),
      }),
    );
}

type ScheduleRow = {
  id: string;
  enabled: number;
  trigger_json: string;
  next_run_at: string | null;
  args_json: string;
  created_at: string;
  updated_at: string;
  workflow_id: string | null;
  workflow_title: string | null;
};

export function scheduleDrafts(db: Database, nowIso: string): WhiteboardDraft[] {
  return db
    .query<ScheduleRow, []>(
      `SELECT s.id,s.enabled,s.trigger_json,s.next_run_at,s.args_json,s.created_at,s.updated_at,
              s.workflow_id,w.title AS workflow_title
         FROM schedules s LEFT JOIN workflows w ON w.id = s.workflow_id
        ORDER BY s.created_at, s.id`,
    )
    .all()
    .map((row) =>
      draft({
        originKey: `schedule:${row.id}`,
        directory: "schedules",
        leaf: `schedules/${documentIdForOrigin(`schedule:${row.id}`)}.md`,
        kind: "watch",
        title: clean(row.workflow_title, `스케줄 ${row.id}`),
        source: { type: "schedule", scheduleId: row.id, workflowId: row.workflow_id },
        status: row.enabled === 1 ? "enabled" : "disabled",
        createdAt: iso(row.created_at, nowIso),
        updatedAt: iso(row.updated_at, nowIso),
        text: [
          `- 트리거: ${row.trigger_json}`,
          `- 다음 실행: ${row.next_run_at ?? "없음"}`,
          `- 인자: ${row.args_json}`,
          ...(row.workflow_id === null ? [] : [`- 워크플로: ${row.workflow_id}`]),
        ].join("\n"),
      }),
    );
}

type BriefingRow = {
  id: string;
  slot: string;
  content_json: string;
  created_at: string;
  run_id: string | null;
};

/** Briefings are Interpretation documents; their cited source ids stay visible. */
export function briefingDrafts(db: Database, nowIso: string): WhiteboardDraft[] {
  return db
    .query<BriefingRow, []>(
      "SELECT id,slot,content_json,created_at,run_id FROM briefings ORDER BY created_at DESC, id",
    )
    .all()
    .map((row) => {
      const content = parseJson(row.content_json);
      const text = stringField(content, "text");
      const references = isRecord(content) ? (content["references"] ?? null) : null;
      return draft({
        originKey: `briefing:${row.id}`,
        directory: "briefings",
        leaf: `briefings/${row.created_at.slice(0, 10)}-${row.slot.replace(":", "")}.md`,
        kind: "thread",
        title: `브리핑 ${row.slot}`,
        source: { type: "briefing", briefingId: row.id, slot: row.slot, runId: row.run_id },
        status: "published",
        createdAt: iso(row.created_at, nowIso),
        updatedAt: iso(row.created_at, nowIso),
        text: [
          text.length > 0 ? text : row.content_json,
          ...(references === null ? [] : ["", `참조\n${JSON.stringify(references)}`]),
        ].join("\n"),
      });
    });
}
