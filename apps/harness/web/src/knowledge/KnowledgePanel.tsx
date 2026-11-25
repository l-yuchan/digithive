import { useCallback, useState } from "react";
import { FileSection } from "./FileSection";
import { MemorySection } from "./MemorySection";
import { listFiles, listMemories } from "./knowledgeApi";
import { useCollection } from "./useCollection";

export function KnowledgePanel() {
  const [history, setHistory] = useState(false);
  const loadMemories = useCallback(() => listMemories(history), [history]);
  const memories = useCollection(loadMemories);
  const files = useCollection(listFiles);
  const errors = [
    memories.loadError && `기억 ${memories.loadError}`,
    memories.actionError,
    files.loadError && `파일 ${files.loadError}`,
    files.actionError,
  ];

  return (
    <section className="knowledge" aria-labelledby="knowledge-title">
      <header className="card card-head">
        <h2 id="knowledge-title">기억과 파일</h2>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            memories.refresh();
            files.refresh();
          }}
        >
          새로고침
        </button>
      </header>
      {errors.some(Boolean) ? (
        <div className="error-card" role="alert" data-testid="knowledge-error">
          {errors.map(
            (error) =>
              error && (
                <p key={error} className="error">
                  {error}
                </p>
              ),
          )}
        </div>
      ) : null}
      <div className="knowledge-columns">
        <MemorySection collection={memories} history={history} onHistory={setHistory} />
        <FileSection collection={files} />
      </div>
    </section>
  );
}
