import { useState } from "react";
import { reportAsync } from "../async";
import { WritableKindSchema, type CreateDocumentInput, type WritableKind } from "./whiteboardApi";

export function CreateForm({
  busy,
  offline,
  onCreate,
}: {
  readonly busy: boolean;
  readonly offline: boolean;
  readonly onCreate: (input: CreateDocumentInput) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<WritableKind>("thread");
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const locked = busy || offline;
  const incomplete = !path.trim() || !title.trim() || !text.trim();

  return (
    <section className="card whiteboard-create" aria-labelledby="whiteboard-create-title">
      <h3 id="whiteboard-create-title">새 노트 또는 할 일</h3>
      <form
        className="form-fields"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          if (locked || incomplete) return;
          setSubmitError(null);
          reportAsync(
            onCreate({
              path: path.trim(),
              kind,
              title: title.trim(),
              text: text.trim(),
            }).then((created) => {
              if (!created) return;
              setPath("");
              setTitle("");
              setText("");
            }),
            (error) => setSubmitError(String(error)),
          );
        }}
      >
        <label className="field">
          파일 경로
          <input
            data-testid="whiteboard-path"
            required
            maxLength={512}
            disabled={locked}
            value={path}
            placeholder={kind === "thread" ? "threads/notes/my-note" : "commitments/notes/my-task"}
            onChange={(event) => setPath(event.target.value)}
          />
          <small>
            {kind === "thread" ? "threads/" : "commitments/"} 아래의 ASCII 경로를 입력하세요.
          </small>
        </label>
        <div className="whiteboard-create-grid">
          <label className="field">
            제목
            <input
              data-testid="whiteboard-title"
              required
              maxLength={200}
              disabled={locked}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="field">
            문서 종류
            <select
              data-testid="whiteboard-kind"
              disabled={locked}
              value={kind}
              onChange={(event) => setKind(WritableKindSchema.parse(event.target.value))}
            >
              <option value="thread">노트</option>
              <option value="commitment">할 일</option>
            </select>
          </label>
        </div>
        <label className="field">
          내용
          <textarea
            data-testid="whiteboard-content"
            required
            rows={6}
            disabled={locked}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {submitError ? (
          <p className="error" role="alert">
            {submitError}
          </p>
        ) : null}
        <div className="run-actions whiteboard-form-actions">
          <button
            className="primary"
            type="submit"
            data-testid="whiteboard-save"
            disabled={locked || incomplete}
          >
            새 문서 저장
          </button>
        </div>
      </form>
    </section>
  );
}
