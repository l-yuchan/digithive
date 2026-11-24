import { useEffect, useState } from "react";
import { apiUrl, getJson, postJson } from "../api";

type SyncState = { source: string; ok: boolean; lastSyncAt: string | null; error: string | null };
type Connections = {
  googleConnected: boolean;
  canvasConfigured: boolean;
  pushConfigured: boolean;
  states: SyncState[];
};
type Briefing = {
  slot: string;
  createdAt: string;
  content: { text: string; generatedAt: string };
} | null;

const LABELS: Record<string, string> = { calendar: "캘린더", gmail: "메일", canvas: "한양 LMS" };

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export function ConnectionsPanel() {
  const [state, setState] = useState<Connections | null>(null);
  const [briefing, setBriefing] = useState<Briefing>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pushState, setPushState] = useState<string>("확인 전");

  const load = async () => {
    const [connections, latest] = await Promise.all([
      getJson<Connections>("/api/connections"),
      getJson<Briefing>("/api/briefings/latest"),
    ]);
    setState(connections);
    setBriefing(latest);
  };

  useEffect(() => {
    void load().catch((error: unknown) => setMessage(String(error)));
    const timer = setInterval(() => void load().catch(() => undefined), 20_000);
    return () => clearInterval(timer);
  }, []);

  const sync = async () => {
    setBusy("sync");
    setMessage(null);
    try {
      const result = await postJson<{ results: { source: string; ok: boolean; count: number; error: string | null }[] }>("/api/connections/sync", {});
      setMessage(result.results.map((row) => `${LABELS[row.source] ?? row.source} ${row.ok ? `${row.count}건` : `실패: ${row.error ?? ""}`}`).join(" · "));
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
      const result = await postJson<{ slot: string; stored: boolean; pushed: boolean; error: string | null }>("/api/briefings/run", {});
      setMessage(result.stored ? `브리핑 ${result.slot} 생성${result.pushed ? " · 알림 전송" : ` · 알림 없음(${result.error ?? "no_device"})`}` : `브리핑 없음(${result.error ?? "이미 생성됨"})`);
      await load();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(null);
    }
  };

  const enablePush = async () => {
    setBusy("push");
    setMessage(null);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushState("이 브라우저는 푸시를 지원하지 않습니다");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState("알림 권한이 거부되었습니다");
        return;
      }
      const registration = await navigator.serviceWorker.register(apiUrl("/sw.js"));
      const { publicKey } = await getJson<{ publicKey: string }>("/api/push/key");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await postJson("/api/push/subscribe", { subscription: subscription.toJSON() });
      setPushState("이 기기로 알림을 받습니다");
      setMessage("알림 구독을 저장했습니다.");
    } catch (error) {
      setPushState(`구독 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const testPush = async () => {
    setBusy("test");
    try {
      const outcome = await postJson<{ sent: number; failed: number; errors: string[] }>("/api/push/test", {});
      setMessage(outcome.sent > 0 ? `테스트 알림 전송(${outcome.sent}대)` : `전송 실패: ${outcome.errors.join(", ")}`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="connections" aria-label="연결">
      <div className="card">
        <div className="card-head">
          <h2>Google (캘린더·메일)</h2>
          <span className={`badge ${state?.googleConnected ? "succeeded" : "failed"}`} data-testid="google-state">
            {state?.googleConnected ? "연결됨" : "미연결"}
          </span>
        </div>
        <p className="run-meta">
          {state?.googleConnected
            ? "증분 수집이 켜져 있습니다. 캘린더는 syncToken, 메일은 historyId로 이어받습니다."
            : "연결하면 캘린더와 메일을 읽어 일정·메일 브리핑에 넣습니다."}
        </p>
        <div className="run-actions">
          <a className="primary button-link" href={apiUrl("/api/oauth/google/start")} data-testid="google-connect">
            {state?.googleConnected ? "다시 연결" : "Google 연결"}
          </a>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>한양 LMS</h2>
          <span className={`badge ${state?.canvasConfigured ? "succeeded" : "failed"}`} data-testid="canvas-state">
            {state?.canvasConfigured ? "설정됨" : "미설정"}
          </span>
        </div>
        <p className="run-meta">과제·퀴즈 마감을 가져와 브리핑에 넣습니다.</p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>수집 상태</h2>
          <button className="ghost" type="button" data-testid="sync-now" disabled={busy !== null} onClick={() => void sync()}>
            지금 동기화
          </button>
        </div>
        <ul className="state-list" data-testid="sync-states">
          {(state?.states ?? []).length === 0 ? <li className="run-meta">아직 수집 기록이 없습니다.</li> : null}
          {(state?.states ?? []).map((row) => (
            <li key={row.source}>
              <span className={`badge ${row.ok ? "succeeded" : "failed"}`}>{row.ok ? "정상" : "오류"}</span>{" "}
              {LABELS[row.source] ?? row.source}
              {row.error ? <span className="run-meta"> · {row.error}</span> : null}
              {row.lastSyncAt ? <span className="run-meta"> · {new Date(row.lastSyncAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</span> : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>알림</h2>
          <span className="badge" data-testid="push-state">
            {pushState}
          </span>
        </div>
        <p className="run-meta">브리핑이 만들어지면 이 기기로 알립니다. (VAPID: {state?.pushConfigured ? "설정됨" : "미설정"})</p>
        <div className="run-actions">
          <button className="primary" type="button" data-testid="push-enable" disabled={busy !== null} onClick={() => void enablePush()}>
            이 기기에서 알림 받기
          </button>
          <button className="ghost" type="button" data-testid="push-test" disabled={busy !== null} onClick={() => void testPush()}>
            테스트 알림
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>최근 브리핑</h2>
          <button className="ghost" type="button" data-testid="briefing-run" disabled={busy !== null} onClick={() => void runBriefing()}>
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
