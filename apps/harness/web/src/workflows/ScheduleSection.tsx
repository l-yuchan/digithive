import { useState } from "react";
import { formatDateTime, runStatusLabel } from "../format";
import type { ScheduleBindingView, Trigger } from "./workflowTypes";

export function triggerLabel(trigger: Trigger): string {
  if (trigger.kind === "once") return `한 번 · ${formatDateTime(trigger.at)}`;
  if (trigger.kind === "interval")
    return `매 ${trigger.everySeconds}초 · 기준 ${formatDateTime(trigger.anchorAt)}`;
  return `매일 ${trigger.time} · ${trigger.timeZone}`;
}

export function ScheduleSection({
  schedules,
  busyKey,
  onAdd,
  onEdit,
  onToggle,
  onRun,
  onDelete,
}: {
  readonly schedules: readonly ScheduleBindingView[];
  readonly busyKey: string | null;
  readonly onAdd: () => void;
  readonly onEdit: (schedule: ScheduleBindingView) => void;
  readonly onToggle: (schedule: ScheduleBindingView) => void;
  readonly onRun: (schedule: ScheduleBindingView) => void;
  readonly onDelete: (schedule: ScheduleBindingView) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const busy = busyKey !== null;
  return (
    <section className="card workflow-schedules" aria-label="워크플로 스케줄">
      <div className="card-head">
        <div>
          <h3>스케줄</h3>
          <p className="run-meta">이 정의를 자동 실행하는 트리거 연결입니다.</p>
        </div>
        <button
          className="primary"
          type="button"
          disabled={busy}
          onClick={onAdd}
          data-testid="schedule-create"
        >
          스케줄 추가
        </button>
      </div>
      {schedules.length === 0 ? (
        <p className="run-meta">
          연결된 스케줄이 없습니다. 지금 실행만으로도 워크플로를 사용할 수 있습니다.
        </p>
      ) : null}
      <ul className="schedule-binding-list">
        {schedules.map((schedule) => (
          <li className="schedule-binding" key={schedule.id} data-schedule-id={schedule.id}>
            <div className="card-head">
              <strong>{triggerLabel(schedule.trigger)}</strong>
              <label className="enabled-toggle">
                <input
                  type="checkbox"
                  checked={schedule.enabled}
                  disabled={busy}
                  onChange={() => onToggle(schedule)}
                />
                {schedule.enabled ? "자동 실행 사용" : "일시정지됨"}
              </label>
            </div>
            <p className="run-meta">
              다음 실행:{" "}
              {schedule.enabled && schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : "없음"}
            </p>
            <p className="run-meta">
              마지막 실행:{" "}
              {schedule.lastRun ? runStatusLabel(schedule.lastRun.status) : "기록 없음"}
            </p>
            <details className="bound-args">
              <summary>연결된 인자</summary>
              <pre className="result-output">{JSON.stringify(schedule.args, null, 2)}</pre>
            </details>
            <div className="run-actions">
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={() => onRun(schedule)}
                data-testid="schedule-run-now"
              >
                {busyKey === `run:${schedule.id}` ? "큐에 넣는 중…" : "지금 실행"}
              </button>
              <button
                className="ghost"
                type="button"
                disabled={busy}
                onClick={() => onEdit(schedule)}
              >
                수정
              </button>
              {confirmDelete === schedule.id ? (
                <>
                  <button
                    className="ghost danger-button"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setConfirmDelete(null);
                      onDelete(schedule);
                    }}
                    data-testid="schedule-delete-confirm"
                  >
                    삭제 확인
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmDelete(null)}
                  >
                    삭제 취소
                  </button>
                </>
              ) : (
                <button
                  className="ghost danger-button"
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmDelete(schedule.id)}
                  data-testid="schedule-delete"
                >
                  삭제
                </button>
              )}
            </div>
            {confirmDelete === schedule.id ? (
              <p className="run-meta">트리거 연결만 삭제하며 워크플로와 실행 기록은 남습니다.</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
