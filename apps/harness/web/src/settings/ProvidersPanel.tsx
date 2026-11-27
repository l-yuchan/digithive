import { useEffect, useMemo, useState } from "react";
import { getJson, sendJson } from "../api";
import {
  ChainResponseSchema,
  ModelTestSchema,
  ProvidersOverviewSchema,
  type Catalog,
  type ChainEntry,
  type ModelOffer,
  type Provider,
  type ProvidersOverview,
} from "./providerTypes";
import { ModelChain } from "./ModelChain";
import { ProviderCard } from "./ProviderCard";
import { ProviderForm } from "./ProviderForm";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The model providers part of the settings tab.
 *
 * It answers three questions on one screen: which providers are connected (and what each
 * one says about its own models and limits), which model on which provider answers first,
 * and whether a model really works. A probe never hides a failure: each upstream read keeps
 * its own error, so a missing usage endpoint does not read as a missing catalog.
 */
export function ProvidersPanel() {
  const [overview, setOverview] = useState<ProvidersOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [tested, setTested] = useState<Record<string, string>>({});

  const acceptProviders = (body: unknown, busyKey: string | null) => {
    setOverview((current) => {
      const parsed = ProvidersOverviewSchema.safeParse(body);
      if (parsed.success) return parsed.data;
      // A chain-only answer updates the chain and leaves the providers as they are.
      const chainOnly = ChainResponseSchema.safeParse(body);
      if (chainOnly.success && current !== null) {
        setLoadError(parsed.error.message);
        return { ...current, chain: chainOnly.data.chain, routes: chainOnly.data.routes };
      }
      return current;
    });
    if (busyKey !== null) setBusy(null);
  };

  const load = () =>
    getJson("/api/providers", ProvidersOverviewSchema)
      .then((body) => {
        setOverview(body);
        setLoadError(null);
      })
      .catch((error: unknown) => setLoadError(messageOf(error)));

  useEffect(() => {
    let cancelled = false;
    getJson("/api/providers", ProvidersOverviewSchema)
      .then((body) => {
        if (!cancelled) {
          setOverview(body);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(messageOf(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runAction = async (key: string, request: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try {
      acceptProviders(await request(), key);
    } catch (error) {
      setActionError(messageOf(error));
      setBusy(null);
    }
  };

  const probe = (provider: Provider) =>
    void runAction(`probe:${provider.id}`, () =>
      sendJson("POST", `/api/providers/${encodeURIComponent(provider.id)}/probe`, {}),
    );

  const addToChain = (provider: Provider, model: ModelOffer) =>
    void runAction(`chain-add:${provider.id}:${model.id}`, () =>
      sendJson("POST", "/api/settings/models", { providerId: provider.id, modelId: model.id }).then(
        async (result) => {
          // The chain answer carries the new order; the provider list is unchanged.
          const chain = ChainResponseSchema.parse(result);
          return { ...overview, chain: chain.chain, routes: chain.routes };
        },
      ),
    );

  const test = (provider: Provider, modelId: string) =>
    void runAction(`test:${provider.id}:${modelId}`, async () => {
      const result = ModelTestSchema.parse(
        await sendJson("POST", "/api/settings/models/test", { providerId: provider.id, modelId }),
      );
      setTested((current) => ({
        ...current,
        [`${provider.id}:${modelId}`]: result.ok
          ? `응답 ${result.latencyMs ?? "?"}ms · “${(result.answer ?? "").trim() || "빈 응답"}”`
          : `실패${result.status === undefined ? "" : ` (HTTP ${result.status})`} · ${result.error ?? ""}`,
      }));
      return overview;
    });

  const saveProvider = (body: Record<string, unknown>, providerId: string | null) =>
    void runAction("save", () => {
      if (providerId === null)
        return sendJson("POST", "/api/providers", body).then((result) => {
          setAdding(false);
          return result;
        });
      return sendJson("PATCH", `/api/providers/${encodeURIComponent(providerId)}`, body);
    });

  const removeProvider = (provider: Provider) =>
    void runAction(`delete:${provider.id}`, () =>
      sendJson("DELETE", `/api/providers/${encodeURIComponent(provider.id)}`),
    );

  const reorder = (entries: readonly ChainEntry[]) =>
    void runAction("chain-reorder", () =>
      sendJson("PUT", "/api/settings/models", {
        entries: entries.map((entry) => ({ providerId: entry.providerId, modelId: entry.modelId })),
      }).then((result) => {
        const chain = ChainResponseSchema.parse(result);
        return { ...overview, chain: chain.chain, routes: chain.routes };
      }),
    );

  const toggleEntry = (entry: ChainEntry, enabled: boolean) =>
    void runAction(`chain-toggle:${entry.providerId}:${entry.modelId}`, () =>
      sendJson("PATCH", "/api/settings/models", {
        providerId: entry.providerId,
        modelId: entry.modelId,
        enabled,
      }).then((result) => {
        const chain = ChainResponseSchema.parse(result);
        return { ...overview, chain: chain.chain, routes: chain.routes };
      }),
    );

  const removeEntry = (entry: ChainEntry) =>
    void runAction(`chain-remove:${entry.providerId}:${entry.modelId}`, () =>
      sendJson(
        "DELETE",
        `/api/settings/models?providerId=${encodeURIComponent(entry.providerId)}&modelId=${encodeURIComponent(entry.modelId)}`,
      ).then((result) => {
        const chain = ChainResponseSchema.parse(result);
        return { ...overview, chain: chain.chain, routes: chain.routes };
      }),
    );

  const catalogs = useMemo<readonly Catalog[]>(() => overview?.catalogs ?? [], [overview]);
  const providers = overview?.providers ?? [];
  const chain: readonly ChainEntry[] = overview?.chain ?? [];

  return (
    <div className="settings-part providers" data-testid="settings-providers">
      <div className="card">
        <div className="card-head">
          <h3>모델 공급자</h3>
          <div className="run-actions compact-actions">
            <button
              className="ghost"
              type="button"
              data-testid="providers-refresh"
              disabled={busy !== null}
              onClick={() =>
                void runAction("refresh", async () => {
                  await load();
                  return overview;
                })
              }
            >
              새로고침
            </button>
            <button
              className="primary"
              type="button"
              data-testid="provider-add-open"
              disabled={busy !== null}
              onClick={() => setAdding((open) => !open)}
            >
              {adding ? "추가 취소" : "공급자 추가"}
            </button>
          </div>
        </div>
        <p className="panel-intro">
          OpenAI 호환 서버는 base URL과 키만 있으면 추가됩니다. OpenCode Go와 DeepInfra는 모델
          목록과 사용량 한도를 각자의 API에서 직접 읽어 보여줍니다.
        </p>
        {loading ? (
          <p className="run-meta" role="status">
            불러오는 중…
          </p>
        ) : null}
        {loadError !== null ? (
          <p className="error" role="alert" data-testid="providers-load-error">
            공급자 정보에 문제가 있습니다: {loadError}
          </p>
        ) : null}
        {actionError !== null ? (
          <p className="error" role="alert" data-testid="providers-action-error">
            {actionError}
          </p>
        ) : null}
      </div>

      {adding ? (
        <ProviderForm
          catalogs={catalogs}
          busy={busy === "save"}
          onCancel={() => setAdding(false)}
          onSave={(body) => saveProvider(body, null)}
        />
      ) : null}

      {providers.length === 0 && !loading ? (
        <div className="card empty-state" data-testid="providers-empty">
          <p className="run-meta">등록된 공급자가 없습니다. “공급자 추가”로 하나 추가하세요.</p>
        </div>
      ) : null}

      <ModelChain
        chain={chain}
        busy={busy}
        onReorder={reorder}
        onToggle={toggleEntry}
        onRemove={removeEntry}
      />

      {providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          chain={chain}
          busy={busy}
          tested={tested}
          onProbe={() => probe(provider)}
          onAddToChain={(model) => addToChain(provider, model)}
          onTest={(modelId) => test(provider, modelId)}
          onSave={(body) => saveProvider(body, provider.id)}
          onDelete={() => removeProvider(provider)}
        />
      ))}
    </div>
  );
}
