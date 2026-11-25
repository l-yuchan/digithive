import { z } from "zod";
import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "../api";
import { PushPanel } from "./PushPanel";
import { AccountsPanel } from "./AccountsPanel";

const ConnectionsSchema = z.object({
  googleConnected: z.boolean(),
  canvasConfigured: z.boolean(),
  pushConfigured: z.boolean(),
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
