import { z } from "zod";
import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "../api";

const RunSchema = z.object({
  id: z.string(),
  origin: z.string(),
  goal: z.string(),
  status: z.string(),
  parentRunId: z.union([z.string(), z.null()]),
  resultJson: z.union([z.string(), z.null()]),
  createdAt: z.string(),
  pendingApprovalId: z.union([z.string(), z.null()]).optional(),
  pendingTool: z.union([z.string(), z.null()]).optional(),
});
export type Run = z.infer<typeof RunSchema>;

const EventSchema = z.object({
  seq: z.number(),
  run_id: z.union([z.string(), z.null()]),
  session_id: z.union([z.string(), z.null()]),
  kind: z.string(),
  payload_json: z.string(),
  created_at: z.string(),
});
type RunEvent = z.infer<typeof EventSchema>;

const CANCELLABLE = new Set(["queued", "running", "awaiting_approval"]);

const STATUS_LABELS: Record<string, string> = {
  queued: "대기",
  running: "진행 중",
  awaiting_approval: "승인 대기",
  succeeded: "완료",
  failed: "실패",
  cancelled: "취소됨",
  interrupted: "중단됨",
};

const ORIGIN_LABELS: Record<string, string> = {
  work: "직접 요청",
  conversation: "대화",
  delegation: "위임",
  schedule: "스케줄",
};

/** Events a reader needs to understand a run without opening the raw log. */
const EVENT_LABELS: Record<string, string> = {
  "run.started": "실행 시작",
  "run.settled": "실행 완료",
  "run.failed": "실행 실패",
  "run.interrupted": "실행 중단",
  "run.cancelled": "실행 취소",
  "run.progress": "하위 실행 진행",
  "message.started": "응답 시작",
  "message.delta": "응답 조각",
  "message.completed": "응답 완료",
  "message.aborted": "응답 중단",
  "tool.started": "도구 실행",
  "tool.result": "도구 결과",
  "tool.denied": "도구 거부",
  "tool.timeout": "도구 시간 초과",
  "approval.requested": "승인 요청",
  "approval.decided": "승인 결정",
  "approval.expired": "승인 만료",
  "provider.retry": "공급자 재시도",
  "provider.fallback": "공급자 전환",
  "provider.exhausted": "공급자 모두 소진",
  "provider.recovered": "공급자 회복",
  "usage.recorded": "사용량",
};

/** Enough of each payload to diagnose without collapsing the whole body. */
function payloadSummary(raw: string): string {
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // A non-JSON payload is shown as received.
  }
  if (parsed === null || typeof parsed !== "object") return String(parsed);
  const record = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!record.success) return raw.slice(0, 400);
  const payload = record.data;
  const ordered = [
    "level",
    "message",
    "reason",
    "error",
    "error_detail",
    "detail",
    "provider",
    "failedProvider",
    "model",
    "decision",
    "status",
    "text",
    "output",
    "name",
    "id",
    "retryInMs",
  ];
  const picked: Record<string, unknown> = {};
  for (const key of ordered) if (payload[key] !== undefined) picked[key] = payload[key];
  for (const [key, value] of Object.entries(payload)) {
    if (!(key in picked)) picked[key] = value;
  }
  return JSON.stringify(picked);
}

function eventLevel(kind: string, raw: string): "error" | "warning" | "info" {
  if (kind === "run.failed" || kind === "run.interrupted" || kind === "provider.exhausted")
    return "error";
  if (kind === "provider.fallback" || kind === "tool.denied" || kind === "tool.timeout")
    return "warning";
  if (raw.includes('"level":"error"')) return "error";
  if (raw.includes('"level":"warning"')) return "warning";
  return "info";
}

export function WorkPanel() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [origin, setOrigin] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (status) params.set("status", status);
    if (origin) params.set("origin", origin);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return getJson(`/api/runs${suffix}`, z.object({ runs: z.array(RunSchema) }))
      .then((body) => {
        setRuns(body.runs);
      })
      .catch((failure: unknown) => {
        setError(String(failure));
      });
  }, [query, status, origin]);

  useEffect(() => {
    load().catch((failure: unknown) => setError(String(failure)));
    const timer = setInterval(() => {
      load().catch((failure: unknown) => setError(String(failure)));
    }, 2_000);
    return () => clearInterval(timer);
  }, [load]);

  const openRun = async (runId: string) => {
    if (openId === runId) {
      setOpenId(null);
      return;
    }
    setOpenId(runId);
    setEvents([]);
    setEventsError(null);
    setEventsLoading(true);
    try {
      const body = await getJson(
        `/api/runs/${runId}/events`,
        z.object({ events: z.array(EventSchema) }),
      );
      setEvents(body.events);
    } catch (failure) {
      setEventsError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setEventsLoading(false);
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

  const cancel = async (run: Run) => {
    try {
      await postJson(`/api/runs/${run.id}/cancel`, {}, z.unknown());
      await load();
    } catch (failure) {
      setError(String(failure));
    }
  };

  return (
    <section className="work" aria-label="실행 로그">
      <p className="panel-intro">
        실행 중이거나 끝난 모든 작업의 기록입니다. 새 작업은 <strong>대화</strong> 탭에서
        요청하세요.
      </p>
      <form
        className="run-filters"
        data-testid="run-filters"
        onSubmit={(event) => {
          event.preventDefault();
          load().catch((failure: unknown) => setError(String(failure)));
        }}
      >
        <input
          data-testid="run-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="목표, 실행 ID, 결과 내용 검색"
        />
        <select
          data-testid="run-filter-status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label="상태 필터"
        >
          <option value="">모든 상태</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          data-testid="run-filter-origin"
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          aria-label="출처 필터"
        >
          <option value="">모든 출처</option>
          {["conversation", "work", "delegation", "schedule"].map((value) => (
            <option key={value} value={value}>
              {ORIGIN_LABELS[value] ?? value}
            </option>
          ))}
        </select>
      </form>
      {error ? (
        <p className="error" role="alert" data-testid="run-error">
          {error}
        </p>
      ) : null}
      {runs.length === 0 ? (
        <p className="run-meta" data-testid="run-empty">
          조건에 맞는 실행이 없습니다.
        </p>
      ) : null}
      <ul className="run-list" data-testid="run-list">
        {runs.map((run) => (
          <li key={run.id} className={`run ${run.status}`} data-testid="run-item">
            <button type="button" className="run-toggle" onClick={() => void openRun(run.id)}>
              <span className={`badge ${run.status}`} data-testid="run-status">
                {STATUS_LABELS[run.status] ?? run.status}
              </span>
              <span className="run-goal">{run.goal}</span>
              <span className="run-meta">
                {ORIGIN_LABELS[run.origin] ?? run.origin} · {formatTime(run.createdAt)} ·{" "}
                {run.id.slice(0, 8)}
              </span>
            </button>
            {run.parentRunId ? <p className="run-meta">상위 작업에서 위임됨</p> : null}
            {run.resultJson ? (
              <p className="run-summary">{summarizeResult(run.resultJson)}</p>
            ) : null}
            {run.status === "awaiting_approval" && run.pendingApprovalId ? (
              <div className="run-actions">
                <span className="run-meta">승인 필요 · {run.pendingTool ?? "도구 호출"}</span>
                <button
                  className="primary"
                  type="button"
                  data-testid="approve"
                  onClick={() => void decide(run, "approve")}
                >
                  승인
                </button>
                <button
                  className="ghost"
                  type="button"
                  data-testid="reject"
                  onClick={() => void decide(run, "reject")}
                >
                  거부
                </button>
              </div>
            ) : null}
            {CANCELLABLE.has(run.status) ? (
              <div className="run-actions">
                <button
                  className="ghost"
                  type="button"
                  data-testid="run-cancel"
                  onClick={() => void cancel(run)}
                >
                  취소
                </button>
              </div>
            ) : null}
            {openId === run.id ? (
              <div className="run-detail" data-testid="run-detail">
                <p className="run-meta">실행 ID {run.id}</p>
                {run.resultJson ? (
                  <pre data-testid="run-result-json">{prettify(run.resultJson)}</pre>
                ) : null}
                {eventsLoading ? <p className="run-meta">로그 불러오는 중…</p> : null}
                {eventsError ? (
                  <p className="error" role="alert">
                    실행 로그를 불러오지 못했습니다{": "}
                    {eventsError}
                  </p>
                ) : null}
                {!eventsLoading && !eventsError && events.length === 0 ? (
                  <p className="run-meta">기록된 이벤트가 없습니다.</p>
                ) : null}
                {events.length > 0 ? (
                  <ol className="run-events" data-testid="run-events">
                    {events.map((event) => (
                      <li
                        key={event.seq}
                        className={`run-event ${eventLevel(event.kind, event.payload_json)}`}
                      >
                        <span className="run-event-kind">
                          {EVENT_LABELS[event.kind] ?? event.kind}
                          <span className="run-meta">
                            {" "}
                            #{event.seq} · {formatTime(event.created_at)}
                          </span>
                        </span>
                        <pre>{payloadSummary(event.payload_json)}</pre>
                      </li>
                    ))}
                  </ol>
                ) : null}
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
    const parsed = z
      .object({
        text: z.unknown().optional(),
        error: z.unknown().optional(),
        detail: z.unknown().optional(),
      })
      .parse(JSON.parse(resultJson));
    if (typeof parsed.text === "string") return parsed.text.slice(0, 300);
    if (typeof parsed.error === "string")
      return `오류: ${parsed.error}${typeof parsed.detail === "string" ? `\n업스트림 응답: ${parsed.detail.slice(0, 600)}` : ""}`;
  } catch {
    // A non-object result is shown as text.
  }
  return resultJson.slice(0, 300);
}

function prettify(resultJson: string): string {
  try {
    return JSON.stringify(JSON.parse(resultJson), null, 2);
  } catch {
    return resultJson;
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ko-KR", { hour12: false });
}
