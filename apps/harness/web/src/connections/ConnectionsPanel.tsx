import { z } from "zod";
import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "../api";
import { PushPanel } from "./PushPanel";
import { AccountsPanel } from "./AccountsPanel";

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

  const refresh = useCallback(() => {
    void load()
      .then(() => setLoadError(null))
      .catch((error: unknown) => setLoadError(String(error)));
  }, [load]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 20_000);
    return () => clearInterval(timer);
  }, [refresh]);

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
      <AccountsPanel onChanged={refresh} />

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
