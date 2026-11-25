import { useState } from "react";
import { z } from "zod";
import { apiUrl, getJson, postJson } from "../api";
import {
  describeBrowserInfo,
  describeError,
  describeWorkers,
  resolvePushSubscription,
  waitForActiveWorker,
  type BrowserInfo,
  type PushErrorDetails,
  type WorkerSnapshot,
} from "./pushDiagnostics";

type PushDetails = {
  phase: string;
  error: PushErrorDetails | null;
  permission: NotificationPermission | "unsupported";
  subscription: "reused" | "created" | null;
  subscriptionEndpoint: string | null;
  worker: WorkerSnapshot;
  browser: BrowserInfo;
};

function applicationKey(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export function PushPanel({
  configured,
  busy,
  onBusy,
  onMessage,
}: {
  readonly configured: boolean | null;
  readonly busy: boolean;
  readonly onBusy: (busy: boolean) => void;
  readonly onMessage: (message: string | null) => void;
}) {
  const [pushState, setPushState] = useState("확인 전");
  const [pushDetails, setPushDetails] = useState<PushDetails | null>(null);

  const enablePush = async () => {
    onBusy(true);
    onMessage(null);
    let registration: ServiceWorkerRegistration | null = null;
    const details: PushDetails = {
      phase: "지원 확인",
      error: null,
      permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
      subscription: null,
      subscriptionEndpoint: null,
      worker: describeWorkers(null, null),
      browser: describeBrowserInfo(),
    };
    const commit = (patch: Partial<PushDetails>) => {
      Object.assign(details, patch);
      setPushDetails({ ...details });
      if (patch.phase !== undefined) setPushState(patch.phase);
    };
    try {
      commit({ phase: "지원 확인" });
      if (
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        typeof Notification === "undefined"
      ) {
        setPushState("이 브라우저는 푸시를 지원하지 않습니다");
        return;
      }
      commit({ phase: "알림 권한 요청" });
      const permission = await Notification.requestPermission();
      commit({ permission });
      if (permission !== "granted") {
        setPushState(
          permission === "denied"
            ? "알림 권한이 거부되었습니다"
            : "알림 권한이 허용되지 않았습니다",
        );
        return;
      }
      commit({ phase: "서비스 워커 등록" });
      registration = await navigator.serviceWorker.register(apiUrl("/sw.js"));
      commit({
        phase: "서비스 워커 활성화 대기",
        worker: describeWorkers(registration, navigator.serviceWorker.controller),
      });
      registration = await waitForActiveWorker(registration);
      commit({ worker: describeWorkers(registration, navigator.serviceWorker.controller) });
      commit({ phase: "기존 구독 확인" });
      const { publicKey } = await getJson("/api/push/key", z.object({ publicKey: z.string() }));
      commit({ phase: "푸시 구독 확인/생성" });
      const { subscription, reused } = await resolvePushSubscription(registration.pushManager, {
        userVisibleOnly: true,
        applicationServerKey: applicationKey(publicKey),
      });
      commit({
        subscription: reused ? "reused" : "created",
        subscriptionEndpoint: subscription.endpoint,
      });
      commit({ phase: "서버에 구독 저장" });
      await postJson("/api/push/subscribe", { subscription: subscription.toJSON() });
      commit({ phase: "완료" });
      setPushState("이 기기로 알림을 받습니다");
      onMessage("알림 구독을 저장했습니다.");
    } catch (error) {
      commit({
        error: describeError(error),
        worker: describeWorkers(registration, navigator.serviceWorker.controller),
      });
      setPushState(`구독 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      onBusy(false);
    }
  };

  const testPush = async () => {
    onBusy(true);
    try {
      const outcome = await postJson(
        "/api/push/test",
        {},
        z.object({
          sent: z.number(),
          failed: z.number(),
          errors: z.array(z.string()),
        }),
      );
      onMessage(
        outcome.sent > 0
          ? `테스트 알림 전송(${outcome.sent}대)`
          : `전송 실패: ${outcome.errors.join(", ")}`,
      );
    } catch (error) {
      onMessage(String(error));
    } finally {
      onBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>알림</h2>
        <span className="badge" data-testid="push-state">
          {pushState}
        </span>
      </div>
      <p className="run-meta">
        브리핑이 만들어지면 이 기기로 알립니다. (VAPID:{" "}
        {configured === null ? "확인 중" : configured ? "설정됨" : "미설정"})
      </p>
      <div className="run-actions">
        <button
          className="primary"
          type="button"
          data-testid="push-enable"
          disabled={busy}
          onClick={() => void enablePush()}
        >
          이 기기에서 알림 받기
        </button>
        <button
          className="ghost"
          type="button"
          data-testid="push-test"
          disabled={busy}
          onClick={() => void testPush()}
        >
          테스트 알림
        </button>
      </div>
      {pushDetails ? (
        <details className="push-details" data-testid="push-details">
          <summary>
            진단 정보 · {pushDetails.phase}
            {pushDetails.error ? ` · ${pushDetails.error.name}: ${pushDetails.error.message}` : ""}
          </summary>
          <pre className="briefing">{JSON.stringify(pushDetails, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}
