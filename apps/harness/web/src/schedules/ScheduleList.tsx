import { useState } from "react";
import { formatDateTime, runStatusLabel } from "../format";
import type { Account } from "../connections/accounts";
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

const SOURCE_TEXT: Record<string, string> = {
  calendar: "캘린더",
  gmail: "메일",
  canvas: "한양 LMS",
};

/**
 * What this schedule runs, step by step: the agent instruction, the builtin steps
 * with the exact account and sources, or the script path with each argument.
 */
function workflow(
  schedule: Schedule,
  accounts: readonly Account[],
): { title: string; steps: string[] } {
  switch (schedule.executor.kind) {
    case "agent":
      return {
        title: "에이전트 실행",
        steps: [
          "1. 아래 프롬프트로 에이전트를 호출합니다.",
          `2. 프롬프트: "${schedule.instruction}"`,
        ],
      };
    case "script":
      return {
        title: "스크립트 실행",
        steps: [
          `1. ${schedule.executor.path} 를 실행합니다.`,
          ...(schedule.executor.args.length === 0
            ? ["2. 인자 없음"]
            : schedule.executor.args.map(
                (arg, index) => `2-${index + 1}. 인자 ${index + 1}: ${JSON.stringify(arg)}`,
              )),
          "3. 산출물과 종료 코드를 실행 기록에 남깁니다.",
        ],
      };
    case "builtin": {
      if (schedule.executor.name === "sync_sources") {
        const id = schedule.executor.accountId;
        // An internal id means nothing to the reader; the account label does.
        const account = id
          ? (accounts.find((candidate) => candidate.id === id)?.label ?? `${id} (계정 목록에 없음)`)
          : "(지정 안 됨, 실행하면 계정 오류)";
        const sources = (schedule.executor.sources ?? []).map(
          (source) => SOURCE_TEXT[source] ?? source,
        );
        return {
          title: "수집 스케줄",
          steps: [
            `1. 계정 ${account} 의 연결 정보로 접근 권한을 확인합니다.`,
            `2. ${sources.length > 0 ? sources.join(", ") : "계정에서 사용 중인 모든 정보"} 를 증분 수집합니다.`,
            `3. 수집 결과(건수, 다음 커서, 오류)를 실행 기록에 남깁니다.`,
          ],
        };
      }
      const scopeId = schedule.executor.accountId;
      const scopeName = scopeId
        ? (accounts.find((candidate) => candidate.id === scopeId)?.label ?? scopeId)
        : null;
      return {
        title: "브리핑 생성",
        steps: [
          `1. ${scopeName ? `${scopeName} 의` : "수집된"} 일정·메일·과제를 읽습니다.`,
          "2. 오늘의 브리핑 문장을 만듭니다.",
          "3. 등록된 기기로 알림을 보냅니다.",
        ],
      };
    }
    default:
      throw new Error("알 수 없는 실행 방식입니다.");
  }
}

export function ScheduleList({
  schedules,
  accounts,
  selectedId,
  busyKey,
  onEdit,
  onHistory,
  onToggle,
  onRun,
  onDelete,
}: {
  readonly schedules: readonly Schedule[];
  readonly accounts: readonly Account[];
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
        <li
          className={`card schedule-card${selectedId === schedule.id ? " selected" : ""}`}
          key={schedule.id}
          data-testid="schedule-item"
          data-schedule-id={schedule.id}
        >
          <div className="card-head">
            <h3>{schedule.title}</h3>
            <span className={`badge ${schedule.enabled ? "succeeded" : ""}`}>
              {schedule.enabled ? "사용 중" : "일시정지됨"}
            </span>
          </div>
          <p className="schedule-instruction">{schedule.instruction}</p>
          <p className="run-meta">{triggerLabel(schedule.trigger)}</p>
          <div className="schedule-workflow" data-testid="schedule-workflow">
            <strong>{workflow(schedule, accounts).title}</strong>
            <ul className="workflow-steps">
              {workflow(schedule, accounts).steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          </div>
          <p className="run-meta">제한 {schedule.timeoutSeconds}초</p>
          <p className="run-meta">
            다음 실행:{" "}
            {schedule.enabled
              ? schedule.nextRunAt
                ? formatDateTime(schedule.nextRunAt)
                : "없음"
              : "자동 실행 일시정지"}
          </p>
          <p className="run-meta">
            마지막 실행: {schedule.lastRun ? runStatusLabel(schedule.lastRun.status) : "기록 없음"}
            {schedule.lastRun?.settledAt ? ` · ${formatDateTime(schedule.lastRun.settledAt)}` : ""}
          </p>
          <div className="run-actions">
            <button
              className="ghost"
              type="button"
              disabled={busy}
              onClick={() => onEdit(schedule)}
            >
              수정
            </button>
            <button
              className="ghost"
              type="button"
              disabled={busy}
              aria-pressed={selectedId === schedule.id}
              onClick={() => onHistory(schedule.id)}
            >
              실행 기록
            </button>
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() => onRun(schedule)}
              data-testid="schedule-run-now"
            >
              {busyKey === `run:${schedule.id}` ? "실행 요청 중…" : "지금 실행"}
            </button>
            <button
              className="ghost"
              type="button"
              disabled={busy}
              onClick={() => onToggle(schedule)}
            >
              {schedule.enabled ? "일시정지" : "다시 사용"}
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
            <p className="run-meta">스케줄 정의만 삭제하며 기존 실행 기록은 보존합니다.</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
