import { reportAsync } from "../async";
import { CreateForm } from "./CreateForm";
import { DocumentDetail } from "./DocumentDetail";
import { DocumentList } from "./DocumentList";
import { useWhiteboard } from "./useWhiteboard";
import { WhiteboardKindSchema } from "./whiteboardApi";

export function WhiteboardPanel() {
  const state = useWhiteboard();
  const selectedDocument = state.detail;
  const errors = [
    !state.online ? "오프라인입니다. 저장과 수정은 연결 후에 다시 시도하세요." : null,
    state.listError
      ? `${state.documents === null ? "문서 목록" : "마지막으로 불러온 목록의 새로고침"} 오류: ${state.listError}`
      : null,
    state.detailError ? `선택 문서 읽기 오류: ${state.detailError}` : null,
    state.actionError ? `요청 오류: ${state.actionError}` : null,
  ].filter((message): message is string => message !== null);
  const loading = state.busy
    ? state.busy === "create"
      ? "새 문서를 저장하는 중…"
      : "선택 문서를 수정하는 중…"
    : state.listLoading
      ? state.documents === null
        ? "문서 목록을 불러오는 중…"
        : "문서 목록을 새로고치는 중…"
      : state.detailLoading
        ? "선택 문서를 불러오는 중…"
        : null;

  return (
    <section
      className="whiteboard-panel"
      data-testid="whiteboard-panel"
      aria-labelledby="whiteboard-heading"
    >
      <header className="whiteboard-head">
        <h2 id="whiteboard-heading">화이트보드</h2>
        <p className="panel-intro">파일로 저장된 기록, 노트, 할 일, 주시 문서를 찾고 수정합니다.</p>
      </header>
      <form
        className="card whiteboard-filters"
        onSubmit={(event) => {
          event.preventDefault();
          state.search();
        }}
      >
        <label className="field whiteboard-query">
          문서 검색
          <input
            data-testid="whiteboard-search-input"
            value={state.filter.query}
            placeholder="제목과 내용 검색"
            onChange={(event) =>
              state.setFilter((current) => ({ ...current, query: event.target.value }))
            }
          />
        </label>
        <label className="field">
          종류 필터
          <select
            data-testid="whiteboard-kind-filter"
            value={state.filter.kind}
            onChange={(event) => {
              const value = event.target.value;
              state.setFilter((current) => ({
                ...current,
                kind: value === "" ? "" : WhiteboardKindSchema.parse(value),
              }));
            }}
          >
            <option value="">모든 종류</option>
            <option value="record">기록</option>
            <option value="thread">노트</option>
            <option value="commitment">할 일</option>
            <option value="watch">주시</option>
          </select>
        </label>
        <div className="whiteboard-filter-actions">
          <button
            className="ghost"
            type="submit"
            data-testid="whiteboard-search-submit"
            disabled={state.listLoading || !state.online}
          >
            검색
          </button>
          <button
            className="ghost"
            type="button"
            disabled={state.listLoading || state.detailLoading || !state.online}
            onClick={() => reportAsync(state.refresh(), state.reportError)}
          >
            새로고침
          </button>
        </div>
      </form>
      {errors.length > 0 ? (
        <div className="error-card whiteboard-error" data-testid="whiteboard-error" role="alert">
          {errors.map((message) => (
            <p className="error" key={message}>
              {message}
            </p>
          ))}
        </div>
      ) : null}
      {loading ? (
        <p className="run-meta" data-testid="whiteboard-loading" role="status">
          {loading}
        </p>
      ) : null}
      {state.notice ? (
        <p className="whiteboard-notice" role="status">
          {state.notice}
        </p>
      ) : null}
      <div className="whiteboard-workspace">
        <section className="whiteboard-list-section" aria-labelledby="whiteboard-list-heading">
          <h3 id="whiteboard-list-heading">문서 목록</h3>
          <DocumentList
            documents={state.documents}
            selectedId={state.selectedId}
            loading={state.listLoading}
            loadError={state.listError}
            onSelect={state.select}
          />
        </section>
        {selectedDocument ? (
          <DocumentDetail
            key={`${selectedDocument.id}:${selectedDocument.hash}`}
            document={selectedDocument}
            busy={state.busy !== null}
            loading={state.detailLoading}
            offline={!state.online}
            onUpdate={(input) => state.update(selectedDocument, input)}
            onReload={state.reloadSelected}
          />
        ) : (
          <div className="card empty-state whiteboard-detail-empty">
            <p className="run-meta">
              {state.selectedId
                ? state.detailError
                  ? "선택 문서를 확인할 수 없습니다. 새로고침으로 다시 시도하세요."
                  : "선택 문서를 불러오는 중입니다."
                : "문서를 선택하면 내용과 상태를 수정할 수 있습니다."}
            </p>
            {state.selectedId && state.detailError ? (
              <button
                className="ghost"
                type="button"
                disabled={!state.online}
                onClick={() => reportAsync(state.reloadSelected(), state.reportError)}
              >
                다시 읽기
              </button>
            ) : null}
          </div>
        )}
      </div>
      <CreateForm busy={state.busy !== null} offline={!state.online} onCreate={state.create} />
    </section>
  );
}
