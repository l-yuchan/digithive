import { useEffect, useState } from "react";
import { getJson, postJson } from "../api";

export type Run = {
  id: string;
  origin: string;
  goal: string;
  status: string;
  parentRunId: string | null;
  resultJson: string | null;
  createdAt: string;
  pendingApprovalId?: string | null;
  pendingTool?: string | null;
};

const LABELS: Record<string, string> = {
  queued: "대기",
  running: "진행 중",
  awaiting_approval: "승인 대기",
  succeeded: "완료",
  failed: "실패",
  cancelled: "취소됨",
  interrupted: "중단됨",
};

export function WorkPanel() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const body = await getJson<{ runs: Run[] }>("/api/runs");
      setRuns(body.runs);
    } catch (failure) {
      setError(String(failure));
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 1_500);
    return () => clearInterval(timer);
  }, []);

  const start = async () => {
    const value = goal.trim();
    if (value.length === 0) return;
    setBusy(true);
    try {
      await postJson("/api/runs", { goal: value });
      setGoal("");
      await load();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (run: Run, decision: "approve" | "reject") => {
    if (!run.pendingApprovalId) return;
    try {
      await postJson(`/api/runs/${run.id}/approvals/${run.pendingApprovalId}`, { decision });
      await load();
    } catch (failure) {
      setError(String(failure));
    }
  };

  return (
    <section className="work" aria-label="작업">
      <form
        className="run-form"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <input
          data-testid="run-goal"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="맡길 작업을 적어주세요 (예: 회의 준비물 목록을 파일로 정리)"
        />
        <button className="primary" type="submit" data-testid="run-start" disabled={busy}>
          시작
        </button>
      </form>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="run-list" data-testid="run-list">
        {runs.map((run) => (
          <li key={run.id} className={`run ${run.status}`} data-testid="run-item">
            <div className="run-head">
              <span className={`badge ${run.status}`} data-testid="run-status">
                {LABELS[run.status] ?? run.status}
              </span>
              <span className="run-goal">{run.goal}</span>
            </div>
            {run.parentRunId ? <p className="run-meta">상위 작업에서 위임됨</p> : null}
            {run.resultJson ? <p className="run-meta">{summarizeResult(run.resultJson)}</p> : null}
            {run.status === "awaiting_approval" && run.pendingApprovalId ? (
              <div className="run-actions">
                <span className="run-meta">승인 필요 · {run.pendingTool ?? "도구 호출"}</span>
                <button className="primary" type="button" data-testid="approve" onClick={() => void decide(run, "approve")}>
                  승인
                </button>
                <button className="ghost" type="button" data-testid="reject" onClick={() => void decide(run, "reject")}>
                  거부
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function summarizeResult(resultJson: string): string {
  try {
    const parsed = JSON.parse(resultJson) as { text?: unknown; error?: unknown };
    if (typeof parsed.text === "string") return parsed.text.slice(0, 200);
    if (typeof parsed.error === "string") return `오류: ${parsed.error}`;
  } catch {
    // fall through
  }
  return resultJson.slice(0, 200);
}
