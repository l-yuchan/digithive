import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { getJson, postJson } from "../api";

const BriefingSchema = z.union([
  z.object({
    slot: z.string(),
    createdAt: z.string(),
    content: z.object({ text: z.string(), generatedAt: z.string() }),
  }),
  z.null(),
]);

/** The briefings part of the settings tab: the last one, and a button to make one now. */
export function BriefingsSection() {
  const [briefing, setBriefing] = useState<z.infer<typeof BriefingSchema>>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    () =>
      getJson("/api/briefings/latest", BriefingSchema).then((latest) => {
        setBriefing(latest);
        setLoadError(null);
      }),
    [],
  );

  useEffect(() => {
    void load().catch((error: unknown) =>
      setLoadError(error instanceof Error ? error.message : String(error)),
    );
  }, [load]);

  const runBriefing = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await postJson(
        "/api/briefings/run",
        {},
        z.object({
          run: z.object({ id: z.string() }),
          workflow: z.object({ id: z.string(), title: z.string() }),
        }),
      );
      setMessage(
        `브리핑 실행을 시작했습니다 (실행 ${result.run.id}). 완료되면 실행 로그에서 확인할 수 있습니다.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-part" data-testid="settings-briefings">
      {loadError !== null ? (
        <p className="error" role="alert">
          브리핑을 불러오지 못했습니다: {loadError}
        </p>
      ) : null}
      <div className="card">
        <div className="card-head">
          <h3>최근 브리핑</h3>
          <button
            className="ghost"
            type="button"
            data-testid="briefing-run"
            disabled={busy}
            onClick={() => void runBriefing()}
          >
            {busy ? "시작 중…" : "지금 만들기"}
          </button>
        </div>
        {briefing ? (
          <>
            <p className="run-meta">
              {briefing.slot} ·{" "}
              {new Date(briefing.createdAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
            </p>
            <pre className="briefing" data-testid="briefing-text">
              {briefing.content.text}
            </pre>
          </>
        ) : (
          <p className="run-meta">아직 브리핑이 없습니다. “지금 만들기”로 하나 생성해 보세요.</p>
        )}
      </div>
      {message ? (
        <p className="run-meta" role="status" data-testid="briefing-message">
          {message}
        </p>
      ) : null}
    </div>
  );
}
