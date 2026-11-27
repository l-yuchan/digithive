import { useState } from "react";
import { reportAsync } from "../async";
import { formatDateTime } from "../format";
import type { UpdateDocumentInput, WhiteboardDocument } from "./whiteboardApi";
import { KIND_LABELS, sourceLabel, statusLabel } from "./whiteboardText";

export type UpdateResult = "saved" | "conflict" | "failed";

function statusOptions(document: WhiteboardDocument): readonly string[] {
  const values =
    document.kind === "commitment"
      ? ["open", "in_progress", "done", "cancelled"]
      : document.kind === "thread"
        ? ["active", "archived"]
        : document.kind === "watch"
          ? ["enabled", "disabled"]
          : ["current", "superseded"];
  return values.includes(document.status) ? values : [document.status, ...values];
}

export function DocumentDetail({
  document,
  busy,
  loading,
  offline,
  onUpdate,
  onReload,
}: {
  readonly document: WhiteboardDocument;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly offline: boolean;
  readonly onUpdate: (input: UpdateDocumentInput) => Promise<UpdateResult>;
  readonly onReload: () => Promise<boolean>;
}) {
  const [text, setText] = useState(document.text);
  const [status, setStatus] = useState(document.status);
  const [conflict, setConflict] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const dirty = text !== document.text || status !== document.status;
  const owner = document.source["type"];
  const writable = owner === "user" || owner === "agent";
  const locked = busy || offline;

  return (
    <article
      className="card whiteboard-selected"
      data-testid="whiteboard-selected"
      aria-labelledby="whiteboard-selected-heading"
      aria-busy={busy || loading}
    >
      <header className="whiteboard-selected-head">
        <div>
          <h3 id="whiteboard-selected-heading" data-testid="whiteboard-selected-title">
            {document.title}
          </h3>
          <p className="run-meta">
            <span className="badge" data-testid="whiteboard-selected-kind">
              {KIND_LABELS[document.kind]}
            </span>
          </p>
        </div>
        <button
          className="ghost"
          type="button"
          data-testid="whiteboard-reload"
          disabled={busy || loading || offline}
          onClick={() => {
            setLocalError(null);
            reportAsync(
              onReload().then((loaded) => {
                if (loaded) setConflict(false);
              }),
              (error) => setLocalError(String(error)),
            );
          }}
        >
          최신 내용 읽기
        </button>
      </header>
      <div className="whiteboard-path-block">
        <span>파일 경로</span>
        <code data-testid="whiteboard-selected-path">{document.path}</code>
      </div>
      <div className="whiteboard-document-facts">
        <p className="run-meta">
          생성 <time dateTime={document.createdAt}>{formatDateTime(document.createdAt)}</time>
        </p>
        <p className="run-meta">
          수정 <time dateTime={document.updatedAt}>{formatDateTime(document.updatedAt)}</time>
        </p>
        <p className="run-meta">출처 {sourceLabel(document.source)}</p>
      </div>
      <form
        className="form-fields whiteboard-update-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (locked || !dirty || !writable) return;
          setConflict(false);
          setLocalError(null);
          reportAsync(
            onUpdate({ text, status, expectedHash: document.hash }).then((result) => {
              setConflict(result === "conflict");
            }),
            (error) => setLocalError(String(error)),
          );
        }}
      >
        <label className="field">
          선택 문서 내용
          <textarea
            data-testid="whiteboard-edit-content"
            rows={10}
            disabled={locked}
            readOnly={!writable}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <label className="field">
          상태
          <select
            data-testid="whiteboard-status"
            disabled={locked || !writable}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {statusOptions(document).map((value) => (
              <option value={value} key={value}>
                {statusLabel(value)}
              </option>
            ))}
          </select>
        </label>
        {!writable ? (
          <p className="run-meta">원본 시스템이 관리하는 읽기 전용 문서입니다.</p>
        ) : null}
        {localError ? (
          <p className="error" role="alert">
            {localError}
          </p>
        ) : null}
        {conflict ? (
          <p className="whiteboard-conflict" role="alert">
            파일이 이미 변경되었습니다. 작성 중인 내용을 보관한 뒤 최신 내용 읽기를 선택하세요.
          </p>
        ) : null}
        <div className="run-actions whiteboard-form-actions">
          <button
            className="ghost"
            type="submit"
            data-testid="whiteboard-update"
            disabled={locked || !dirty || !writable}
          >
            수정 내용 저장
          </button>
        </div>
      </form>
    </article>
  );
}
