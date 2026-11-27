import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { getJson, sendJson } from "../api";

const ModelRouteSchema = z.object({
  name: z.string().min(1),
  model: z.string(),
  baseUrl: z.string(),
});
const ModelsSchema = z.object({
  routes: z.array(ModelRouteSchema),
  priority: z.array(z.string()),
});
type ModelRoute = z.infer<typeof ModelRouteSchema>;
type ModelSettings = z.infer<typeof ModelsSchema>;

/**
 * The server accepts only an exact permutation: every route named once, nothing
 * else. Rejecting a mismatch here keeps a bad answer from being edited and saved
 * back as a list the server would have to refuse anyway.
 */
function isPermutation(priority: readonly string[], routes: readonly ModelRoute[]): boolean {
  if (priority.length !== routes.length) return false;
  const names = new Set(routes.map((route) => route.name));
  if (names.size !== routes.length) return false;
  const seen = new Set<string>();
  for (const name of priority) {
    if (!names.has(name) || seen.has(name)) return false;
    seen.add(name);
  }
  return true;
}

/** The routes in the order they are tried, keyed by the draft order the list edits. */
function orderedRoutes(routes: readonly ModelRoute[], priority: readonly string[]): ModelRoute[] {
  const byName = new Map(routes.map((route) => [route.name, route]));
  const ordered: ModelRoute[] = [];
  for (const name of priority) {
    const route = byName.get(name);
    if (route !== undefined && !ordered.includes(route)) ordered.push(route);
  }
  for (const route of routes) if (!ordered.includes(route)) ordered.push(route);
  return ordered;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Model priority settings. The list is the order routes are tried in: the first one
 * answers while healthy, and a suspended route hands the context to the next one.
 */
export function SettingsPanel() {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const accept = useCallback((body: ModelSettings) => {
    if (!isPermutation(body.priority, body.routes)) {
      throw new Error("경로 우선순위가 경로 목록과 일치하지 않습니다.");
    }
    setSettings(body);
    setOrder(body.priority);
  }, []);

  const refresh = () => {
    setLoading(true);
    setLoadError(null);
    getJson("/api/settings/models", ModelsSchema)
      .then((body) => {
        accept(body);
        setLoadError(null);
        setLoading(false);
      })
      .catch((error: unknown) => {
        setLoadError(messageOf(error));
        setLoading(false);
      });
  };

  useEffect(() => {
    let cancelled = false;
    getJson("/api/settings/models", ModelsSchema)
      .then((body) => {
        if (cancelled) return;
        accept(body);
        setLoadError(null);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(messageOf(error));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accept]);

  const move = (name: string, direction: -1 | 1) => {
    setMessage(null);
    setSaveError(null);
    setOrder((current) => {
      const index = current.indexOf(name);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved === undefined) return current;
      next.splice(target, 0, moved);
      return next;
    });
  };

  const save = async () => {
    if (settings === null || saving) return;
    setSaving(true);
    setSaveError(null);
    setMessage(null);
    try {
      // The server answers with what it stored, so the list shows the saved order
      // without a second request.
      accept(await sendJson("PUT", "/api/settings/models", { priority: order }, ModelsSchema));
      setMessage("저장했습니다.");
    } catch (error) {
      setSaveError(messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  const shown = settings === null ? [] : orderedRoutes(settings.routes, order);

  return (
    <section className="settings" aria-labelledby="settings-title">
      <header className="card card-head">
        <h2 id="settings-title">모델 우선순위</h2>
        <button
          className="ghost"
          type="button"
          data-testid="settings-refresh"
          disabled={loading || saving}
          onClick={refresh}
        >
          새로고침
        </button>
      </header>
      <p className="panel-intro">
        위에 있는 경로를 먼저 사용합니다. 할당량이 소진된 경로는 잠시 건너뛰고 다음 경로로
        넘어갑니다.
      </p>

      {loading ? (
        <p className="run-meta" role="status" data-testid="settings-loading">
          불러오는 중…
        </p>
      ) : null}
      {loadError !== null ? (
        <p className="error" role="alert" data-testid="settings-load-error">
          설정을 불러오지 못했습니다: {loadError}
        </p>
      ) : null}

      {settings !== null && !loading ? (
        <div className="card">
          {shown.length === 0 ? (
            <p className="run-meta" data-testid="settings-empty">
              등록된 모델 경로가 없습니다.
            </p>
          ) : (
            <ol className="settings-list" data-testid="settings-priority">
              {shown.map((route, index) => (
                <li
                  key={route.name}
                  className="settings-route"
                  data-testid={`settings-route-${route.name}`}
                >
                  <span className="settings-position" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className="settings-route-body">
                    <span className="settings-route-name">{route.name}</span>
                    <span className="settings-route-meta">
                      {route.model} · {route.baseUrl}
                    </span>
                  </div>
                  <div className="settings-route-actions">
                    <button
                      className="ghost"
                      type="button"
                      aria-label={`${route.name} 위로 이동`}
                      data-testid={`settings-up-${route.name}`}
                      disabled={saving || index === 0}
                      onClick={() => move(route.name, -1)}
                    >
                      위로
                    </button>
                    <button
                      className="ghost"
                      type="button"
                      aria-label={`${route.name} 아래로 이동`}
                      data-testid={`settings-down-${route.name}`}
                      disabled={saving || index === shown.length - 1}
                      onClick={() => move(route.name, 1)}
                    >
                      아래로
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <div className="settings-save">
            <button
              className="primary"
              type="button"
              data-testid="settings-save"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "저장 중…" : "저장"}
            </button>
          </div>
        </div>
      ) : null}

      {saveError !== null ? (
        <p className="error" role="alert" data-testid="settings-save-error">
          저장하지 못했습니다: {saveError}
        </p>
      ) : null}
      {message !== null ? (
        <p className="run-meta" role="status" data-testid="settings-message">
          {message}
        </p>
      ) : null}
    </section>
  );
}
