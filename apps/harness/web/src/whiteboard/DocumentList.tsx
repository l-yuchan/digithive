import { formatDateTime } from "../format";
import type { WhiteboardSummary } from "./whiteboardApi";
import { KIND_LABELS, statusLabel } from "./whiteboardText";

export function DocumentList({
  documents,
  selectedId,
  loading,
  loadError,
  onSelect,
}: {
  readonly documents: readonly WhiteboardSummary[] | null;
  readonly selectedId: string | null;
  readonly loading: boolean;
  readonly loadError: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const empty = documents !== null && documents.length === 0 && !loading && !loadError;
  return (
    <>
      {empty ? (
        <p className="card run-meta whiteboard-empty">
          조건에 맞는 문서가 없습니다. 아래에서 새 노트나 할 일을 저장하세요.
        </p>
      ) : null}
      <ul
        className="whiteboard-document-list"
        data-testid="whiteboard-document-list"
        aria-busy={loading}
      >
        {documents?.map((document) => {
          const selected = document.id === selectedId;
          return (
            <li
              className={`whiteboard-document-item${selected ? " selected" : ""}`}
              data-testid="whiteboard-document"
              data-document-id={document.id}
              key={document.id}
            >
              <button
                className="whiteboard-document-select"
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(document.id)}
              >
                <span className="whiteboard-document-head">
                  <strong>{document.title}</strong>
                  <span className="badge">{KIND_LABELS[document.kind]}</span>
                </span>
                <code className="whiteboard-document-path">{document.path}</code>
                <span className="whiteboard-document-meta run-meta">
                  <span>{statusLabel(document.status)}</span>
                  <time dateTime={document.updatedAt}>{formatDateTime(document.updatedAt)}</time>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
