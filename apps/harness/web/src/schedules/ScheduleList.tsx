import { useState } from "react";
import { formatDateTime, runStatusLabel } from "../format";
import type { Schedule, Trigger } from "./scheduleTypes";

function triggerLabel(trigger: Trigger): string {
  switch (trigger.kind) {
    case "once":
      return `한 번 · ${formatDateTime(trigger.at)}`;
    case "interval":
      return `매 ${trigger.everySeconds}초 · 기준 ${formatDateTime(trigger.anchorAt)}`;
    case "daily":
      return `매일 ${trigger.time} · ${trigger.timeZone}`;
    default:
      throw new Error("알 수 없는 반복 방식입니다.");
  }
}

function executorLabel(schedule: Schedule): string {
  switch (schedule.executor.kind) {
    case "agent":
      return "에이전트";
    case "builtin":
      return schedule.executor.name === "sync_sources" ? "내장 · 연결 자료 수집" : "내장 · 브리핑 생성";
    case "script":
      return `스크립트 · ${schedule.executor.path}`;
    default:
      throw new Error("알 수 없는 실행 방식입니다.");
  }
}

export function ScheduleList({
  schedules,
  selectedId,
  busyKey,
  onEdit,
  onHistory,
  onToggle,
  onRun,
  onDelete,
}: {
  readonly schedules: readonly Schedule[];
  readonly selectedId: string | null;
  readonly busyKey: string | null;
  readonly onEdit: (schedule: Schedule) => void;
  readonly onHistory: (id: string) => void;
  readonly onToggle: (schedule: Schedule) => void;
  readonly onRun: (schedule: Schedule) => void;
  readonly onDelete: (schedule: Schedule) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const busy = busyKey !== null;

  return (
    <ul className="schedule-list" data-testid="schedule-list">
      {schedules.map((schedule) => (
        <li className={`card schedule-card${selectedId === schedule.id ? " selected" : ""}`} key={schedule.id} data-testid="schedule-item" data-schedule-id={schedule.id}>
          <div className="card-head">
            <h3>{schedule.title}</h3>
            <span className={`badge ${schedule.enabled ? "succeeded" : ""}`}>{schedule.enabled ? "사용 중" : "일시정지됨"}</span>
          </div>
          <p className="schedule-instruction">{schedule.instruction}</p>
          <p className="run-meta">{triggerLabel(schedule.trigger)}</p>
          <p className="run-meta">{executorLabel(schedule)} · 제한 {schedule.timeoutSeconds}초</p>
          <p className="run-meta">
            다음 실행: {schedule.enabled ? (schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : "없음") : "자동 실행 일시정지"}
          </p>
          <p className="run-meta">
            마지막 실행: {schedule.lastRun ? runStatusLabel(schedule.lastRun.status) : "기록 없음"}
            {schedule.lastRun?.settledAt ? ` · ${formatDateTime(schedule.lastRun.settledAt)}` : ""}
          </p>
          <div className="run-actions">
            <button className="ghost" type="button" disabled={busy} onClick={() => onEdit(schedule)}>수정</button>
            <button className="ghost" type="button" disabled={busy} aria-pressed={selectedId === schedule.id} onClick={() => onHistory(schedule.id)}>실행 기록</button>
            <button className="primary" type="button" disabled={busy} onClick={() => onRun(schedule)} data-testid="schedule-run-now">
              {busyKey === `run:${schedule.id}` ? "실행 요청 중…" : "지금 실행"}
            </button>
            <button className="ghost" type="button" disabled={busy} onClick={() => onToggle(schedule)}>
              {schedule.enabled ? "일시정지" : "다시 사용"}
            </button>
            {confirmDelete === schedule.id ? (
              <>
                <button className="ghost danger-button" type="button" disabled={busy} onClick={() => { setConfirmDelete(null); onDelete(schedule); }} data-testid="schedule-delete-confirm">삭제 확인</button>
                <button className="ghost" type="button" disabled={busy} onClick={() => setConfirmDelete(null)}>삭제 취소</button>
              </>
            ) : (
              <button className="ghost danger-button" type="button" disabled={busy} onClick={() => setConfirmDelete(schedule.id)} data-testid="schedule-delete">삭제</button>
            )}
          </div>
          {confirmDelete === schedule.id ? <p className="run-meta">스케줄 정의만 삭제하며 기존 실행 기록은 보존합니다.</p> : null}
        </li>
      ))}
    </ul>
  );
}
