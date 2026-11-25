import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { getJson, postJson } from "../api";
import { formatDateTime, runStatusLabel } from "../format";
import { reportAsync } from "../async";
import { RunResult } from "./RunResult";
import { ScheduleRunSchema, type Schedule, type ScheduleRun } from "./scheduleTypes";

const ACTIVE_STATUSES = new Set(["queued", "running", "awaiting_approval"]);
const WorkRunSchema = z.object({
  id: z.string(),
  pendingApprovalId: z.union([z.string(), z.null()]).optional(),
  pendingTool: z.union([z.string(), z.null()]).optional(),
});
type WorkRun = z.infer<typeof WorkRunSchema>;

function scheduledLabel(value: string, schedule: Schedule): string {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (schedule.trigger.kind === "daily" && !hasZone)
    return `${value.replace("T", " ")} · ${schedule.trigger.timeZone}`;
  return formatDateTime(value);
}

function mergeApprovals(runs: ScheduleRun[], workRuns: WorkRun[]): ScheduleRun[] {
  const workById = new Map(workRuns.map((run) => [run.id, run]));
  return runs.map((run) => {
    const work = workById.get(run.id);
    return {
      ...run,
      pendingApprovalId: run.pendingApprovalId ?? work?.pendingApprovalId ?? null,
      pendingTool: run.pendingTool ?? work?.pendingTool ?? null,
    };
  });
}

export function ScheduleHistory({
  schedule,
  onChanged,
}: {
  readonly schedule: Schedule;
  readonly onChanged: () => void;
}) {
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([
        getJson(
          `/api/schedules/${encodeURIComponent(schedule.id)}/runs`,
          z.object({ runs: z.array(ScheduleRunSchema) }),
        ),
        getJson("/api/runs", z.object({ runs: z.array(WorkRunSchema) })),
      ])
        .then(([history, work]) => {
          setRuns(mergeApprovals(history.runs, work.runs));
          setLoadError(null);
        })
        .catch((error: unknown) => setLoadError(String(error))),
    [schedule.id],
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load().catch((error: unknown) => setLoadError(String(error)));
  }, [load]);

  const active = runs?.some((run) => ACTIVE_STATUSES.has(run.status)) ?? false;
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => reportAsync(load(), (error) => setLoadError(String(error))), 2_000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const runAction = async (key: string, request: () => Promise<unknown>) => {
    setBusyKey(key);
    setActionError(null);
    try {
      await request();
      await load();
      onChanged();
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusyKey(null);
    }
  };

  const decide = (run: ScheduleRun, decision: "approve" | "reject") => {
    if (!run.pendingApprovalId) return;
    reportAsync(
      runAction(`${decision}:${run.id}`, () =>
        postJson(`/api/runs/${encodeURIComponent(run.id)}/approvals/${encodeURIComponent(run.pendingApprovalId ?? "")}`, { decision }, z.unknown()),
      ),
      (error) => setActionError(String(error)),
    );
  };

  return (
    <section className="schedule-history" aria-label={`${schedule.title} 실행 기록`}>
      <div className="card">
        <div className="card-head">
          <h2>실행 기록 · {schedule.title}</h2>
          <button className="ghost" type="button" disabled={refreshing} onClick={() => reportAsync(refresh(), (error) => setLoadError(String(error)))} data-testid="schedule-history-refresh">
            {refreshing ? "새로고침 중…" : "새로고침"}
          </button>
        </div>
        <p className="run-meta">예약 실행과 수동 실행을 모두 보여줍니다.</p>
      </div>
      {loadError ? (
        <div className="error-card" role="alert">
          <p className="error">실행 기록을 불러오지 못했습니다: {loadError}</p>
          <button className="ghost" type="button" disabled={refreshing} onClick={() => reportAsync(refresh(), (error) => setLoadError(String(error)))}>다시 시도</button>
        </div>
      ) : null}
      {actionError ? <p className="error" role="alert">{actionError}</p> : null}
      {runs === null ? (
        <div className="card empty-state"><p className="run-meta">{loadError ? "실행 기록을 확인할 수 없습니다." : "실행 기록을 불러오는 중입니다."}</p></div>
      ) : runs.length === 0 ? (
        <div className="card empty-state"><p className="run-meta">아직 실행 기록이 없습니다.</p></div>
      ) : (
        <ol className="history-list" data-testid="schedule-run-history">
          {runs.map((run) => (
            <li className={`card history-item ${run.status}`} key={run.id} data-run-id={run.id}>
              <div className="card-head">
                <span className={`badge ${run.status}`}>{runStatusLabel(run.status)}</span>
                <span className="run-meta">{run.manual === undefined ? "실행 구분 기록 없음" : run.manual ? "수동 실행" : "예약 실행"}</span>
              </div>
              <p className="history-goal">{run.goal}</p>
              <p className="run-meta">실행 ID: {run.id}</p>
              {run.scheduledFor ? <p className="run-meta">예정 시각: {scheduledLabel(run.scheduledFor, schedule)}</p> : null}
              {run.createdAt ? <p className="run-meta">생성 시각: {formatDateTime(run.createdAt)}</p> : null}
              <p className="run-meta">종료 시각: {run.settledAt ? formatDateTime(run.settledAt) : "아직 종료되지 않음"}</p>
              {ACTIVE_STATUSES.has(run.status) ? (
                <div className="run-actions">
                  <button className="ghost danger-button" type="button" disabled={busyKey !== null} onClick={() => reportAsync(runAction(`cancel:${run.id}`, () => postJson(`/api/runs/${encodeURIComponent(run.id)}/cancel`, {}, z.unknown())), (error) => setActionError(String(error)))} data-testid="schedule-run-cancel">
                    {busyKey === `cancel:${run.id}` ? "취소 요청 중…" : "실행 취소"}
                  </button>
                </div>
              ) : null}
              {run.status === "awaiting_approval" && run.pendingApprovalId ? (
                <div className="run-actions approval-actions">
                  <span className="run-meta">승인 필요 · {run.pendingTool ?? "도구 호출"}</span>
                  <button className="primary" type="button" disabled={busyKey !== null} onClick={() => decide(run, "approve")} data-testid="schedule-approve">승인</button>
                  <button className="ghost" type="button" disabled={busyKey !== null} onClick={() => decide(run, "reject")} data-testid="schedule-reject">거부</button>
                </div>
              ) : null}
              <RunResult resultJson={run.resultJson} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
