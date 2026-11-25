import type { Session } from "../api";

export type RenameTarget = { readonly id: string; readonly title: string };

type Props = {
  readonly sessions: Session[];
  readonly activeId: string | null;
  readonly connected: boolean;
  readonly query: string;
  readonly renaming: RenameTarget | null;
  readonly confirmDelete: string | null;
  readonly onNew: () => void;
  readonly onSearch: (value: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onRenameStart: (session: Session) => void;
  readonly onRenameChange: (title: string) => void;
  readonly onRenameSave: () => void;
  readonly onRenameCancel: () => void;
  readonly onDeleteStart: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onDeleteCancel: () => void;
  readonly onClose: () => void;
};

/**
 * The conversation list. It belongs to the chat tab and is shown there only: on a wide
 * screen it sits beside the transcript, on a narrow one it replaces it until a
 * conversation is chosen.
 */
export function ConversationList({
  sessions,
  activeId,
  connected,
  query,
  renaming,
  confirmDelete,
  onNew,
  onSearch,
  onSelect,
  onRenameStart,
  onRenameChange,
  onRenameSave,
  onRenameCancel,
  onDeleteStart,
  onDelete,
  onDeleteCancel,
  onClose,
}: Props) {
  return (
    <aside
      className="chat-list"
      id="conversation-list"
      aria-label="대화 목록"
      data-testid="chat-list"
    >
      <header className="chat-list-head">
        <button className="primary" type="button" data-testid="new-session" onClick={onNew}>
          새 대화
        </button>
        <button
          className="icon"
          type="button"
          aria-label="대화 목록 닫기"
          data-testid="chat-list-close"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <input
        className="search"
        type="search"
        placeholder="대화 검색"
        aria-label="대화 검색"
        data-testid="session-search"
        value={query}
        onChange={(event) => onSearch(event.target.value)}
      />
      <ul className="session-list">
        {sessions.map((session) => (
          <li key={session.id} className="session-row">
            {renaming?.id === session.id ? (
              <span className="rename-form">
                <input
                  data-testid="rename-input"
                  value={renaming.title}
                  onChange={(event) => onRenameChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onRenameSave();
                    if (event.key === "Escape") onRenameCancel();
                  }}
                  autoFocus
                />
                <button type="button" data-testid="rename-save" onClick={onRenameSave}>
                  저장
                </button>
                <button type="button" onClick={onRenameCancel}>
                  취소
                </button>
              </span>
            ) : (
              <>
                <button
                  type="button"
                  className="session-item"
                  aria-current={session.id === activeId ? "true" : undefined}
                  data-testid="session-item"
                  data-title-source={session.titleSource}
                  onClick={() => onSelect(session.id)}
                >
                  {session.title}
                </button>
                <button
                  type="button"
                  className="icon"
                  aria-label={`${session.title} 이름 변경`}
                  data-testid="session-rename"
                  onClick={() => onRenameStart(session)}
                >
                  ✎
                </button>
                {confirmDelete === session.id ? (
                  <>
                    <button
                      type="button"
                      className="icon danger"
                      data-testid="session-delete-confirm"
                      onClick={() => onDelete(session.id)}
                    >
                      삭제
                    </button>
                    <button type="button" className="icon" onClick={onDeleteCancel}>
                      취소
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="icon"
                    aria-label={`${session.title} 삭제`}
                    data-testid="session-delete"
                    onClick={() => onDeleteStart(session.id)}
                  >
                    ×
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="conn" data-testid="connection">
        {connected ? "연결됨" : "연결 중…"}
      </p>
    </aside>
  );
}
