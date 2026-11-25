import { useState } from "react";
import { postJson } from "../api";
import { formatDateTime } from "../format";
import { kindLabels, MemoryKindSchema, MemorySchema, type Memory } from "./knowledgeApi";
import type { Collection } from "./useCollection";

export function MemorySection({
  collection,
  history,
  onHistory,
}: {
  readonly collection: Collection<Memory>;
  readonly history: boolean;
  readonly onHistory: (value: boolean) => void;
}) {
  const { rows, loading, loadError, pending, mutate } = collection;
  const [kind, setKind] = useState<Memory["kind"]>("fact");
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const visible = rows?.filter((row) => history || row.supersededBy === null);
  const busy = pending !== null;
  const stale =
    draft !== null && !visible?.some((row) => row.id === draft.id && row.supersededBy === null);
  const correction = draft ? (
    <form
      className="form-fields"
      data-testid={`memory-correct-${draft.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (stale) return;
        mutate("기억 정정", async () => {
          await postJson(
            `/api/memories/${encodeURIComponent(draft.id)}/correct`,
            { text: draft.text.trim() },
            MemorySchema,
          );
          setDraft(null);
        });
      }}
    >
      <label className="field">
        정정할 내용
        <textarea
          autoFocus
          required
          maxLength={4000}
          rows={3}
          disabled={busy}
          readOnly={stale}
          value={draft.text}
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        />
      </label>
      <div className="run-actions">
        <button type="submit" className="primary" disabled={stale || busy || !draft.text.trim()}>
          정정 저장
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => setDraft(null)}>
          취소
        </button>
      </div>
    </form>
  ) : null;

  return (
    <section className="card knowledge-section" aria-labelledby="knowledge-memories">
      <h3 className="section-title" id="knowledge-memories">
        기억
      </h3>
      <form
        data-testid="memory-form"
        className="form-fields"
        onSubmit={(event) => {
          event.preventDefault();
          mutate("기억 추가", async () => {
            await postJson("/api/memories", { kind, text: text.trim() }, MemorySchema);
            setText("");
          });
        }}
      >
        <label className="field">
          종류
          <select
            value={kind}
            disabled={busy}
            onChange={(event) => setKind(MemoryKindSchema.parse(event.target.value))}
          >
            {MemoryKindSchema.options.map((value) => (
              <option key={value} value={value}>
                {kindLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          내용
          <textarea
            required
            rows={2}
            maxLength={4000}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button className="primary" type="submit" disabled={busy || !text.trim()}>
          기억 추가
        </button>
      </form>
      <div className="knowledge-list-head">
        <h4 className="section-title">기억 목록</h4>
        <label className="enabled-toggle">
          <input
            type="checkbox"
            checked={history}
            onChange={(event) => onHistory(event.target.checked)}
          />
          정정 이력 보기
        </label>
      </div>
      {pending || loading ? (
        <p role="status" className="run-meta">
          {pending ? `${pending} 중…` : "기억을 불러오는 중…"}
        </p>
      ) : null}
      {!loading && !loadError && visible?.length === 0 ? (
        <p className="run-meta">아직 등록된 기억이 없습니다.</p>
      ) : null}
      {stale ? (
        <>
          <p className="run-meta">
            이 기억은 이미 정정되었습니다. 작성 중이던 내용은 아래에서 복사할 수 있습니다.
          </p>
          {correction}
        </>
      ) : null}
      <ul className="knowledge-list" data-testid="memory-list" aria-busy={loading}>
        {visible?.map((row) => (
          <li key={row.id} data-testid={`memory-${row.id}`}>
            <div className="source-head">
              <span className="badge">{kindLabels[row.kind]}</span>
              {row.supersededBy ? <span className="badge awaiting_approval">정정됨</span> : null}
              <time className="run-meta" dateTime={row.createdAt}>
                {formatDateTime(row.createdAt)}
              </time>
            </div>
            <p className="knowledge-text">{row.text}</p>
            {row.supersededBy === null &&
              (draft?.id === row.id ? (
                correction
              ) : (
                <button
                  className="ghost"
                  type="button"
                  disabled={busy || draft !== null}
                  onClick={() => setDraft({ id: row.id, text: row.text })}
                >
                  정정
                </button>
              ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
