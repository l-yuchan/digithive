import { useState } from "react";
import { postJson } from "../api";
import { reportAsync } from "../async";
import { formatDateTime, runStatusLabel } from "../format";
import { ACTIVE_RUN_STATUSES, CancelRunResponseSchema, type RunSummary } from "./workflowTypes";
import { ErrorMessage } from "./ErrorMessage";
import { RunResult } from "./RunResult";

const TRIGGER_LABELS: Record<string, string> = {
  manual: "수동 실행",
  once: "한 번 예약",
  interval: "간격 예약",
  daily: "매일 예약",
};

export function WorkflowHistory({
  runs,
  onChanged,
}: {
  readonly runs: readonly RunSummary[];
  readonly onChanged: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await postJson(`/api/runs/${encodeURIComponent(id)}/cancel`, {}, CancelRunResponseSchema);
      await onChanged();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="card workflow-history" aria-label="워크플로 실행 기록">
      <div className="card-head">
        <div>
          <h3>실행 기록</h3>
          <p className="run-meta">
            최근 실행의 요청 인자와 결과입니다. 진행 중인 항목은 자동 새로고침됩니다.
          </p>
        </div>
        <span className="badge">{runs.length}건</span>
      </div>
      {error ? (
        <ErrorMessage
          title="실행을 취소하지 못했습니다. 서버 응답을 그대로 표시합니다."
          error={error}
        />
      ) : null}
      {runs.length === 0 ? <p className="run-meta">아직 실행 기록이 없습니다.</p> : null}
      <ol className="workflow-run-list" data-testid="workflow-run-history">
        {runs.map((run) => (
          <li className={`workflow-run ${run.status}`} key={run.id} data-run-id={run.id}>
            <div className="card-head">
              <span className={`badge ${run.status}`}>{runStatusLabel(run.status)}</span>
              <span className="run-meta">
                {run.triggerKind
                  ? (TRIGGER_LABELS[run.triggerKind] ?? run.triggerKind)
                  : "실행 구분 기록 없음"}
              </span>
            </div>
            <p className="run-meta">
              실행 ID: <code>{run.id}</code>
            </p>
            <p className="run-meta">
              생성 {formatDateTime(run.createdAt)} · 종료{" "}
              {run.settledAt ? formatDateTime(run.settledAt) : "아직 종료되지 않음"}
            </p>
            <details className="run-params">
              <summary>실행 인자</summary>
              <pre className="result-output">
                {JSON.stringify(run.params, null, 2) ?? String(run.params)}
              </pre>
            </details>
            {ACTIVE_RUN_STATUSES.has(run.status) ? (
              <div className="run-actions">
                <button
                  className="ghost danger-button"
                  type="button"
                  disabled={busyId !== null}
                  onClick={() =>
                    reportAsync(cancel(run.id), (failure) => setError(String(failure)))
                  }
                  data-testid="workflow-run-cancel"
                >
                  {busyId === run.id ? "취소 요청 중…" : "실행 취소"}
                </button>
              </div>
            ) : null}
            <RunResult resultJson={run.resultJson} />
          </li>
        ))}
      </ol>
    </section>
  );
}
