import type { ChainEntry } from "./providerTypes";

/**
 * The routing chain: which model answers, in order. The first enabled entry answers while
 * it is healthy; when it is suspended (quota, authentication) or fails, the next one is
 * tried. A model is used because it is here, not because its provider listed it.
 */
export function ModelChain({
  chain,
  busy,
  onReorder,
  onToggle,
  onRemove,
}: {
  readonly chain: readonly ChainEntry[];
  readonly busy: string | null;
  readonly onReorder: (entries: readonly ChainEntry[]) => void;
  readonly onToggle: (entry: ChainEntry, enabled: boolean) => void;
  readonly onRemove: (entry: ChainEntry) => void;
}) {
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= chain.length) return;
    const next = [...chain];
    const moved = next[index];
    const other = next[target];
    if (moved === undefined || other === undefined) return;
    next[index] = other;
    next[target] = moved;
    onReorder(next);
  };

  const routeKey = (entry: ChainEntry) => `${entry.providerId}:${entry.modelId}`;

  return (
    <div className="card" data-testid="model-chain">
      <div className="card-head">
        <h3>모델 경로 (답변 순서)</h3>
      </div>
      <p className="panel-intro">
        위에 있는 모델이 먼저 답합니다. 할당량이 소진된 모델은 잠시 건너뛰고 다음 모델로 넘어갑니다.
        꺼진 모델은 건너뜁니다.
      </p>
      {chain.length === 0 ? (
        <p className="run-meta" data-testid="model-chain-empty">
          아직 모델 경로가 없습니다. 아래 공급자의 모델에서 “경로에 추가”를 누르세요.
        </p>
      ) : (
        <ol className="settings-list" data-testid="model-chain-list">
          {chain.map((entry, index) => (
            <li
              key={routeKey(entry)}
              className="settings-route"
              data-testid="chain-row"
              data-model-id={entry.modelId}
            >
              <span className="settings-position" aria-hidden="true">
                {index + 1}
              </span>
              <div className="settings-route-body">
                <span className="settings-route-name">
                  <span className="route-model">{entry.modelId}</span>
                  {entry.enabled && entry.providerEnabled ? (
                    <span className="badge succeeded"> 사용</span>
                  ) : (
                    <span className="badge"> {entry.providerEnabled ? "꺼짐" : "공급자 꺼짐"}</span>
                  )}
                </span>
                <span className="settings-route-meta">
                  {entry.providerLabel} ·{" "}
                  {entry.modelLabel === entry.modelId ? entry.catalogId : entry.modelLabel}
                </span>
              </div>
              <div className="settings-route-actions">
                <button
                  className="ghost"
                  type="button"
                  aria-label={`${entry.modelId} 위로 이동`}
                  data-testid={`chain-up-${entry.modelId}`}
                  disabled={busy !== null || index === 0}
                  onClick={() => move(index, -1)}
                >
                  위로
                </button>
                <button
                  className="ghost"
                  type="button"
                  aria-label={`${entry.modelId} 아래로 이동`}
                  data-testid={`chain-down-${entry.modelId}`}
                  disabled={busy !== null || index === chain.length - 1}
                  onClick={() => move(index, 1)}
                >
                  아래로
                </button>
                <button
                  className="ghost"
                  type="button"
                  data-testid={`chain-toggle-${entry.modelId}`}
                  disabled={busy !== null}
                  onClick={() => onToggle(entry, !entry.enabled)}
                >
                  {entry.enabled ? "사용 끄기" : "사용 켜기"}
                </button>
                <button
                  className="ghost danger-button"
                  type="button"
                  data-testid={`chain-remove-${entry.modelId}`}
                  disabled={busy !== null}
                  onClick={() => onRemove(entry)}
                >
                  경로에서 제거
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
