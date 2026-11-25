import { useState } from "react";
import { z } from "zod";
import { apiUrl, sendJson } from "../api";
import { formatDateTime } from "../format";
import { uploadFile, type FileRecord } from "./knowledgeApi";
import type { Collection } from "./useCollection";

export function FileSection({ collection }: { readonly collection: Collection<FileRecord> }) {
  const { rows, loading, loadError, pending, mutate } = collection;
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const busy = pending !== null;

  return (
    <section className="card knowledge-section" aria-labelledby="knowledge-files">
      <h3 className="section-title" id="knowledge-files">
        파일
      </h3>
      <label className="field">
        파일 업로드
        <input
          data-testid="file-input"
          type="file"
          disabled={busy}
          onChange={(event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            input.value = "";
            mutate("파일 업로드", async () => {
              await uploadFile(file);
            });
          }}
        />
        <small>파일을 선택하면 바로 업로드합니다.</small>
      </label>
      <h4 className="section-title knowledge-list-head">파일 목록</h4>
      {pending || loading ? (
        <p role="status" className="run-meta">
          {pending ? `${pending} 중…` : "파일을 불러오는 중…"}
        </p>
      ) : null}
      {!loading && !loadError && rows?.length === 0 ? (
        <p className="run-meta">아직 저장된 파일이 없습니다.</p>
      ) : null}
      <ul className="knowledge-list" data-testid="file-list" aria-busy={loading}>
        {rows?.map((file) => {
          const path = `/api/files/${encodeURIComponent(file.id)}`;
          return (
            <li key={file.id} data-testid={`file-${file.id}`}>
              <strong>{file.name}</strong>
              <p className="run-meta">
                {file.bytes.toLocaleString("ko-KR")}바이트 ·{" "}
                <time dateTime={file.createdAt}>{formatDateTime(file.createdAt)}</time>
              </p>
              <div className="run-actions">
                <a
                  className="ghost button-link"
                  href={apiUrl(`${path}/content`)}
                  download={file.name}
                >
                  다운로드
                </a>
                {confirmId === file.id ? (
                  <>
                    <button
                      className="ghost danger-button"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        mutate("파일 삭제", async () => {
                          await sendJson(
                            "DELETE",
                            path,
                            undefined,
                            z.object({ deleted: z.literal(true) }),
                          );
                          setConfirmId(null);
                        });
                      }}
                    >
                      삭제 확인
                    </button>
                    <button
                      className="ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmId(null)}
                    >
                      취소
                    </button>
                  </>
                ) : (
                  <button
                    className="ghost danger-button"
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmId(file.id)}
                  >
                    삭제
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
