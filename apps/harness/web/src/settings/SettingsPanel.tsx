import { useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import { getJson } from "../api";

/**
 * What one part of the settings tab is: the parts that used to be the 연결 tab beside it,
 * and the model providers. Each part has its own address, so it can be linked and reloaded
 * on its own; the overview answers "what is set up" without opening any of them.
 */
export type SettingsChild = "providers" | "accounts" | "push" | "briefings";

export const SETTINGS_CHILD_LABELS: readonly {
  readonly id: SettingsChild;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    id: "providers",
    label: "모델 공급자",
    description: "공급자를 추가하고 어떤 모델을 어떤 순서로 쓸지 정합니다.",
  },
  {
    id: "accounts",
    label: "계정",
    description: "Google, Canvas 계정을 연결하고 어떤 자료를 모을지 정합니다.",
  },
  {
    id: "push",
    label: "알림",
    description: "이 기기로 오는 브리핑 알림을 켜거나 상태를 확인합니다.",
  },
  {
    id: "briefings",
    label: "브리핑",
    description: "최근 브리핑을 보고 지금 하나 만들어 봅니다.",
  },
];

export function SettingsPanel({
  child,
  onChild,
}: {
  readonly child: SettingsChild | null;
  readonly onChild: (child: SettingsChild) => void;
}) {
  return (
    <section className="settings" aria-label="설정">
      <header className="card card-head">
        <h2>설정</h2>
      </header>
      <p className="panel-intro">
        모델 공급자, 계정 연결, 알림, 브리핑이 한 곳에 모여 있습니다. 옆 항목을 고르면 그 화면의
        주소로 이동합니다.
      </p>
      <nav className="settings-menu" aria-label="설정 항목">
        {SETTINGS_CHILD_LABELS.map((entry) => (
          <a
            key={entry.id}
            href={`/settings/${entry.id}`}
            aria-current={child === entry.id ? "page" : undefined}
            data-testid={`settings-child-${entry.id}`}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              onChild(entry.id);
            }}
          >
            {entry.label}
          </a>
        ))}
      </nav>
      {child === null ? (
        <SettingsOverview onChild={onChild} />
      ) : child === "providers" ? (
        <Lazy
          importPanel={() => import("./ProvidersPanel")}
          pick={(module) => module.ProvidersPanel}
        />
      ) : child === "accounts" ? (
        <Lazy
          importPanel={() => import("./AccountsSection")}
          pick={(module) => module.AccountsSection}
        />
      ) : child === "push" ? (
        <Lazy importPanel={() => import("./PushSection")} pick={(module) => module.PushSection} />
      ) : (
        <Lazy
          importPanel={() => import("./BriefingsSection")}
          pick={(module) => module.BriefingsSection}
        />
      )}
    </section>
  );
}

/**
 * A part is fetched when its address is opened, so reloading one part does not load the
 * others. A failed chunk (a new build replaced it) is said plainly instead of a blank.
 */
function Lazy<T>({
  importPanel,
  pick,
}: {
  readonly importPanel: () => Promise<T>;
  readonly pick: (module: T) => () => ReactNode;
}) {
  const [part, setPart] = useState<{ Panel: () => ReactNode } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    importPanel()
      .then((module) => {
        if (!cancelled) setPart({ Panel: pick(module) });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [importPanel, pick]);
  if (error !== null)
    return (
      <p className="error" role="alert">
        화면을 불러오지 못했습니다: {error}. 페이지를 새로고침해 주세요.
      </p>
    );
  if (part === null)
    return (
      <p className="run-meta" role="status">
        불러오는 중…
      </p>
    );
  const Panel = part.Panel;
  return <Panel />;
}

const ConnectionsSchema = z.object({
  googleConnected: z.boolean(),
  canvasConfigured: z.boolean(),
  pushConfigured: z.boolean(),
});
const ChainSchema = z.object({
  routes: z.array(z.object({ providerLabel: z.string(), modelId: z.string() })),
});

/**
 * The overview answers what is set up and which model would answer, without opening any
 * part; each line is a link to the part that changes it.
 */
function SettingsOverview({ onChild }: { readonly onChild: (child: SettingsChild) => void }) {
  const [loading, setLoading] = useState(true);
  const [routes, setRoutes] = useState<{ providerLabel: string; modelId: string }[]>([]);
  const [connections, setConnections] = useState<z.infer<typeof ConnectionsSchema> | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Every outcome is handled: a failed read is shown beside the others, never thrown away.
    Promise.allSettled([
      getJson("/api/settings/models", ChainSchema),
      getJson("/api/connections", ConnectionsSchema),
    ])
      .then(([chain, connected]) => {
        if (cancelled) return;
        const failures: string[] = [];
        if (chain.status === "fulfilled") setRoutes(chain.value.routes);
        else
          failures.push(
            `모델 경로를 불러오지 못했습니다: ${chain.reason instanceof Error ? chain.reason.message : String(chain.reason)}`,
          );
        if (connected.status === "fulfilled") setConnections(connected.value);
        else
          failures.push(
            `연결 상태를 불러오지 못했습니다: ${connected.reason instanceof Error ? connected.reason.message : String(connected.reason)}`,
          );
        setErrors(failures);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="card" data-testid="settings-overview">
      <div className="card-head">
        <h3>상태 요약</h3>
        <button
          className="ghost"
          type="button"
          data-testid="overview-refresh"
          onClick={() => {
            setLoading(true);
            window.location.reload();
          }}
        >
          새로고침
        </button>
      </div>
      {errors.map((error) => (
        <p key={error} className="error" role="alert">
          {error}
        </p>
      ))}
      <h3>모델 경로</h3>
      {loading ? (
        <p className="run-meta">불러오는 중…</p>
      ) : routes.length === 0 ? (
        <p className="run-meta" data-testid="overview-routes-empty">
          아직 모델 경로가 없습니다. 아래 “모델 공급자”에서 하나 추가하세요.
        </p>
      ) : (
        <ol className="settings-list" data-testid="overview-routes">
          {routes.map((route, index) => (
            <li key={`${index}:${route.providerLabel}:${route.modelId}`} className="settings-route">
              <span className="settings-position" aria-hidden="true">
                {index + 1}
              </span>
              <div className="settings-route-body">
                <span className="settings-route-name">{route.modelId}</span>
                <span className="settings-route-meta">{route.providerLabel}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
      <ul className="settings-links" data-testid="overview-links">
        <li>
          <button className="link" type="button" onClick={() => onChild("providers")}>
            모델 공급자
          </button>
          <span className="run-meta"> 공급자·모델·사용량을 관리합니다.</span>
        </li>
        <li>
          <button className="link" type="button" onClick={() => onChild("accounts")}>
            계정
          </button>
          <span className="run-meta">
            {" "}
            {connections === null
              ? "확인 중/확인 불가"
              : connections.googleConnected
                ? "Google 연결됨"
                : "Google 미연결"}
            {connections === null
              ? ""
              : connections.canvasConfigured
                ? " · Canvas 설정됨"
                : " · Canvas 미설정"}
          </span>
        </li>
        <li>
          <button className="link" type="button" onClick={() => onChild("push")}>
            알림
          </button>
          <span className="run-meta">
            {" "}
            {connections === null
              ? "확인 중/확인 불가"
              : connections.pushConfigured
                ? "푸시 설정됨"
                : "푸시 미설정"}
          </span>
        </li>
        <li>
          <button className="link" type="button" onClick={() => onChild("briefings")}>
            브리핑
          </button>
          <span className="run-meta"> 최근 브리핑 보기</span>
        </li>
      </ul>
    </div>
  );
}
