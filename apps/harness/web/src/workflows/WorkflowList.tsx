import { formatDateTime, runStatusLabel } from "../format";
import type { ScheduleBinding, WorkflowView } from "./workflowTypes";

const EXECUTOR_LABELS = { agent: "에이전트", builtin: "내장", script: "스크립트" } as const;

function nextRun(schedules: readonly ScheduleBinding[]): string | null {
  const upcoming = schedules
    .filter((schedule) => schedule.enabled && schedule.nextRunAt !== null)
    .map((schedule) => schedule.nextRunAt)
    .filter((value): value is string => value !== null)
    .toSorted((left, right) => Date.parse(left) - Date.parse(right));
  return upcoming[0] ?? null;
}

export function WorkflowList({
  workflows,
  selectedId,
  onSelect,
}: {
  readonly workflows: readonly WorkflowView[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  if (workflows.length === 0) {
    return (
      <div className="card empty-state">
        <p className="run-meta">조건에 맞는 워크플로가 없습니다. 새 워크플로를 만들어보세요.</p>
      </div>
    );
  }
  return (
    <ul className="workflow-list" data-testid="workflow-list">
      {workflows.map((workflow) => {
        const upcoming = nextRun(workflow.schedules);
        return (
          <li
            className={`card workflow-item${selectedId === workflow.id ? " selected" : ""}`}
            key={workflow.id}
            data-testid="workflow-item"
            data-workflow-id={workflow.id}
          >
            <button
              className="workflow-select"
              type="button"
              aria-pressed={selectedId === workflow.id}
              onClick={() => onSelect(workflow.id)}
            >
              <span className="card-head">
                <strong>{workflow.title}</strong>
                <span className="badge">{EXECUTOR_LABELS[workflow.executor.kind]}</span>
              </span>
              <span className="workflow-item-instruction">{workflow.instruction}</span>
              <span className="run-meta">
                스케줄 {workflow.schedules.length}개 · 다음 실행{" "}
                {upcoming ? formatDateTime(upcoming) : "없음"}
              </span>
              <span className="run-meta">
                마지막 실행:{" "}
                {workflow.lastRun ? runStatusLabel(workflow.lastRun.status) : "기록 없음"}
                {workflow.lastRun?.settledAt
                  ? ` · ${formatDateTime(workflow.lastRun.settledAt)}`
                  : ""}
              </span>
              {workflow.score === undefined || workflow.score === null ? null : (
                <span className="run-meta">BM25 관련도: {workflow.score.toFixed(4)}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
