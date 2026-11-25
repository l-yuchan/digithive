import { z } from "zod";
import { useCallback, useEffect, useState } from "react";
import { apiUrl, getJson, postJson } from "../api";
import { PushPanel } from "./PushPanel";

const SyncStateSchema = z.object({
  source: z.string(),
  ok: z.boolean(),
  lastSyncAt: z.union([z.string(), z.null()]),
  error: z.union([z.string(), z.null()]),
});
const ConnectionsSchema = z.object({
  googleConnected: z.boolean(),
  canvasConfigured: z.boolean(),
  pushConfigured: z.boolean(),
  states: z.array(SyncStateSchema),
});
type Connections = z.infer<typeof ConnectionsSchema>;
const BriefingSchema = z.union([
  z.object({
    slot: z.string(),
    createdAt: z.string(),
    content: z.object({ text: z.string(), generatedAt: z.string() }),
  }),
  z.null(),
]);
type Briefing = z.infer<typeof BriefingSchema>;

const LABELS: Record<string, string> = { calendar: "캘린더", gmail: "메일", canvas: "한양 LMS" };

export function ConnectionsPanel() {
  const [state, setState] = useState<Connections | null>(null);
  const [briefing, setBriefing] = useState<Briefing>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([
        getJson("/api/connections", ConnectionsSchema),
        getJson("/api/briefings/latest", BriefingSchema),
      ]).then(([connections, latest]) => {
        setState(connections);
        setBriefing(latest);
      }),
    [],
  );

  useEffect(() => {
    const refresh = () => {
      void load()
        .then(() => setLoadError(null))
        .catch((error: unknown) => setLoadError(String(error)));
    };
    refresh();
    const timer = setInterval(refresh, 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const sync = async () => {
    setBusy("sync");
    setMessage(null);
    try {
      const result = await postJson(
        "/api/connections/sync",
        {},
        z.object({
          results: z.array(
            z.object({
              source: z.string(),
              ok: z.boolean(),
              count: z.number(),
              error: z.union([z.string(), z.null()]),
            }),
          ),
        }),
      );
      setMessage(
        result.results
          .map(
            (row) =>
              `${LABELS[row.source] ?? row.source} ${row.ok ? `${row.count}건` : `실패: ${row.error ?? ""}`}`,
          )
          .join(" · "),
      );
      await load();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(null);
    }
  };

  const runBriefing = async () => {
    setBusy("briefing");
    setMessage(null);
    try {
      const result = await postJson(
        "/api/briefings/run",
        {},
        z.object({
          slot: z.string(),
          stored: z.boolean(),
          pushed: z.boolean(),
          error: z.union([z.string(), z.null()]),
        }),
      );
      setMessage(
        result.stored
          ? `브리핑 ${result.slot} 생성${result.pushed ? " · 알림 전송" : ` · 알림 없음(${result.error ?? "no_device"})`}`
          : `브리핑 없음(${result.error ?? "이미 생성됨"})`,
      );
      await load();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="connections" aria-label="연결">
      {loadError ? (
        <p className="error" role="alert" data-testid="connections-load-error">
          연결 상태를 불러오지 못했습니다: {loadError}
        </p>
      ) : null}
      <div className="card">
        <div className="card-head">
          <h2>Google (캘린더·메일)</h2>
          <span
            className={`badge ${state === null ? "" : state.googleConnected ? "succeeded" : "failed"}`}
            data-testid="google-state"
          >
            {state === null ? "확인 중" : state.googleConnected ? "연결됨" : "미연결"}
          </span>
        </div>
        <p className="run-meta">
          {state === null
            ? "연결 상태를 확인 중입니다."
            : state.googleConnected
              ? "증분 수집이 켜져 있습니다. 캘린더는 syncToken, 메일은 historyId로 이어받습니다."
              : "연결하면 캘린더와 메일을 읽어 일정·메일 브리핑에 넣습니다."}
        </p>
        <div className="run-actions">
          <a
            className="primary button-link"
            href={apiUrl("/api/oauth/google/start")}
            data-testid="google-connect"
          >
            {state?.googleConnected ? "다시 연결" : "Google 연결"}
          </a>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>한양 LMS</h2>
          <span
            className={`badge ${state === null ? "" : state.canvasConfigured ? "succeeded" : "failed"}`}
            data-testid="canvas-state"
          >
            {state === null ? "확인 중" : state.canvasConfigured ? "설정됨" : "미설정"}
          </span>
        </div>
        <p className="run-meta">과제·퀴즈 마감을 가져와 브리핑에 넣습니다.</p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>수집 상태</h2>
          <button
            className="ghost"
            type="button"
            data-testid="sync-now"
            disabled={busy !== null}
            onClick={() => void sync()}
          >
            지금 동기화
          </button>
        </div>
        <ul className="state-list" data-testid="sync-states">
          {state === null ? (
            <li className="run-meta">연결 상태를 불러오는 중입니다.</li>
          ) : state.states.length === 0 ? (
            <li className="run-meta">아직 수집 기록이 없습니다.</li>
          ) : null}
          {(state?.states ?? []).map((row) => (
            <li key={row.source}>
              <span className={`badge ${row.ok ? "succeeded" : "failed"}`}>
                {row.ok ? "정상" : "오류"}
              </span>{" "}
              {LABELS[row.source] ?? row.source}
              {row.error ? <span className="run-meta"> · {row.error}</span> : null}
              {row.lastSyncAt ? (
                <span className="run-meta">
                  {" "}
                  · {new Date(row.lastSyncAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <PushPanel
        configured={state?.pushConfigured ?? null}
        busy={busy !== null}
        onBusy={(pending) => setBusy(pending ? "push" : null)}
        onMessage={setMessage}
      />

      <div className="card">
        <div className="card-head">
          <h2>최근 브리핑</h2>
          <button
            className="ghost"
            type="button"
            data-testid="briefing-run"
            disabled={busy !== null}
            onClick={() => void runBriefing()}
          >
            지금 만들기
          </button>
        </div>
        {briefing ? (
          <pre className="briefing" data-testid="briefing-text">
            {briefing.content.text}
          </pre>
        ) : (
          <p className="run-meta">아직 브리핑이 없습니다. “지금 만들기”로 하나 생성해 보세요.</p>
        )}
      </div>

      {message ? (
        <p className="run-meta" role="status" data-testid="connections-message">
          {message}
        </p>
      ) : null}
    </section>
  );
}
