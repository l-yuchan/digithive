import { useState } from "react";
import {
  formatReset,
  offerSummary,
  type ChainEntry,
  type ModelOffer,
  type Provider,
} from "./providerTypes";
import { ProviderForm } from "./ProviderForm";

function shortTime(iso: string | null): string {
  if (iso === null) return "아직";
  const at = Date.parse(iso);
  return Number.isFinite(at)
    ? new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(at))
    : iso;
}

/**
 * One provider: what it is, what its own API said the last time it was read, and every
 * model it offers with the action that matters for it (add to the routing chain, or send
 * one small request to prove it answers). Errors are shown verbatim, each beside the read
 * that produced it.
 */
export function ProviderCard({
  provider,
  chain,
  busy,
  tested,
  onProbe,
  onAddToChain,
  onTest,
  onSave,
  onDelete,
}: {
  readonly provider: Provider;
  readonly chain: readonly ChainEntry[];
  readonly busy: string | null;
  readonly tested: Record<string, string>;
  readonly onProbe: () => void;
  readonly onAddToChain: (model: ModelOffer) => void;
  readonly onTest: (modelId: string) => void;
  readonly onSave: (body: Record<string, unknown>) => void;
  readonly onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [filter, setFilter] = useState("");
  const [showOther, setShowOther] = useState(false);

  const chained = new Set(
    chain.filter((entry) => entry.providerId === provider.id).map((entry) => entry.modelId),
  );
  const needle = filter.trim().toLowerCase();
  const matching = provider.models.filter(
    (model) =>
      needle.length === 0 ||
      model.id.toLowerCase().includes(needle) ||
      model.label.toLowerCase().includes(needle),
  );
  const chat = matching.filter((model) => model.kind === "chat");
  const other = matching.filter((model) => model.kind !== "chat");
  const shown = showOther ? [...chat, ...other] : chat;
  const probing = busy === `probe:${provider.id}`;

  return (
    <article
      className="card provider-card"
      data-testid="provider-card"
      data-provider-id={provider.id}
    >
      <div className="card-head">
        <div className="account-title">
          <h3>
            {provider.label} <span className="badge">{provider.catalog.label}</span>
          </h3>
          <p className="run-meta">{provider.baseUrl}</p>
          <p className="run-meta">
            키 {provider.keyHint ?? "없음"} ·{" "}
            {provider.enabled ? (
              <span className="badge succeeded">사용</span>
            ) : (
              <span className="badge failed">꺼짐</span>
            )}
          </p>
        </div>
        <div className="run-actions compact-actions">
          <button
            className="ghost"
            type="button"
            data-testid={`provider-probe-${provider.id}`}
            disabled={busy !== null}
            onClick={onProbe}
          >
            {probing ? "읽는 중…" : "모델·사용량 다시 읽기"}
          </button>
          <button
            className="ghost"
            type="button"
            data-testid={`provider-toggle-${provider.id}`}
            disabled={busy !== null}
            onClick={() => onSave({ enabled: !provider.enabled })}
          >
            {provider.enabled ? "끄기" : "켜기"}
          </button>
          <button
            className="ghost"
            type="button"
            data-testid={`provider-edit-${provider.id}`}
            disabled={busy !== null}
            onClick={() => setEditing((open) => !open)}
          >
            {editing ? "수정 취소" : "수정"}
          </button>
          {confirmDelete ? (
            <>
              <button
                className="primary"
                type="button"
                data-testid={`provider-delete-confirm-${provider.id}`}
                disabled={busy !== null}
                onClick={onDelete}
              >
                정말 삭제
              </button>
              <button className="ghost" type="button" onClick={() => setConfirmDelete(false)}>
                취소
              </button>
            </>
          ) : (
            <button
              className="ghost danger-button"
              type="button"
              data-testid={`provider-delete-${provider.id}`}
              disabled={busy !== null}
              onClick={() => setConfirmDelete(true)}
            >
              삭제
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <ProviderForm
          catalogs={[]}
          busy={busy === "save"}
          initial={{
            catalogId: provider.catalogId,
            label: provider.label,
            baseUrl: provider.baseUrl,
            headers: provider.headers,
            keyHint: provider.keyHint,
          }}
          onCancel={() => setEditing(false)}
          onSave={(body) => {
            setEditing(false);
            onSave(body);
          }}
        />
      ) : null}

      <section className="provider-section" aria-label="사용량">
        <h4>사용량·한도</h4>
        <p className="run-meta">마지막 확인 {shortTime(provider.usageFetchedAt)}</p>
        {provider.usage !== null ? (
          <ul className="usage-meters" data-testid={`provider-usage-${provider.id}`}>
            {provider.usage.meters.map((meter) => (
              <li key={meter.id} className="usage-meter">
                <span className="usage-meter-label">{meter.label}</span>
                {meter.percent !== null ? (
                  <span className="usage-bar" aria-label={`${meter.label} ${meter.percent}%`}>
                    <span
                      className={`usage-bar-fill ${meter.percent >= 100 ? "spent" : meter.percent >= 80 ? "warn" : ""}`}
                      style={{ width: `${Math.min(100, meter.percent)}%` }}
                    />
                  </span>
                ) : null}
                <span className="usage-meter-value">
                  {meter.percent !== null ? `${meter.percent}%` : (meter.text ?? "")}
                  {meter.resetsAt !== null ? ` · ${formatReset(meter.resetsAt)} 초기화` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="run-meta">
            {provider.catalog.capabilities.includes("usage")
              ? "아직 사용량을 읽지 않았습니다."
              : "이 종류의 공급자는 사용량 API를 제공하지 않습니다."}
          </p>
        )}
        {provider.usageError !== null ? (
          <p className="error" role="alert" data-testid={`provider-usage-error-${provider.id}`}>
            사용량을 읽지 못했습니다: {provider.usageError}
          </p>
        ) : null}
      </section>

      <section className="provider-section" aria-label="모델">
        <div className="card-head">
          <h4>모델 {provider.models.length > 0 ? `(${provider.models.length})` : ""}</h4>
          <input
            className="provider-filter"
            value={filter}
            placeholder="모델 이름으로 찾기"
            aria-label="모델 이름으로 찾기"
            data-testid={`provider-filter-${provider.id}`}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <p className="run-meta">
          마지막 읽기 {shortTime(provider.modelsFetchedAt)}
          {other.length > 0 ? ` · 채팅 외 ${other.length}개` : ""}
          {other.length > 0 ? (
            <label className="enabled-toggle">
              <input
                type="checkbox"
                checked={showOther}
                data-testid={`provider-show-other-${provider.id}`}
                onChange={(event) => setShowOther(event.target.checked)}
              />
              채팅 외 모델도 보기
            </label>
          ) : null}
        </p>
        {provider.modelsError !== null ? (
          <p className="error" role="alert" data-testid={`provider-models-error-${provider.id}`}>
            모델 목록을 읽지 못했습니다: {provider.modelsError}
          </p>
        ) : null}
        {provider.models.length === 0 && provider.modelsError === null ? (
          <p className="run-meta" data-testid={`provider-models-empty-${provider.id}`}>
            읽어 온 모델이 없습니다. “모델·사용량 다시 읽기”를 눌러보세요.
          </p>
        ) : null}
        {shown.length > 0 ? (
          <ul className="model-list" data-testid={`provider-models-${provider.id}`}>
            {shown.map((model) => {
              const inChain = chained.has(model.id);
              const testKey = `${provider.id}:${model.id}`;
              return (
                <li
                  key={model.id}
                  className="model-row"
                  data-testid="model-row"
                  data-model-id={model.id}
                >
                  <div className="model-body">
                    <span className="model-id">{model.id}</span>
                    <span className="run-meta">{offerSummary(model)}</span>
                    {model.kind !== "chat" ? <span className="badge">{model.kind}</span> : null}
                    {tested[testKey] !== undefined ? (
                      <span className="run-meta" data-testid={`model-test-result-${model.id}`}>
                        {tested[testKey]}
                      </span>
                    ) : null}
                  </div>
                  <div className="model-actions">
                    {inChain ? (
                      <span className="badge succeeded">경로에 있음</span>
                    ) : (
                      <button
                        className="ghost"
                        type="button"
                        data-testid={`model-chain-add-${model.id}`}
                        disabled={busy !== null || model.kind !== "chat"}
                        onClick={() => onAddToChain(model)}
                      >
                        경로에 추가
                      </button>
                    )}
                    <button
                      className="ghost"
                      type="button"
                      data-testid={`model-test-${model.id}`}
                      disabled={busy !== null || model.kind !== "chat"}
                      onClick={() => onTest(model.id)}
                    >
                      응답 확인
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </article>
  );
}
