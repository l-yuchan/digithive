import { useRef } from "react";
import type { Session } from "../api";

export type RenameTarget = { readonly id: string; readonly title: string };

type Props = {
  readonly sessions: Session[];
  readonly activeId: string | null;
  readonly connected: boolean;
  readonly open: boolean;
  readonly query: string;
  readonly renaming: RenameTarget | null;
  readonly confirmDelete: string | null;
  readonly onToggle: () => void;
  readonly onClose: () => void;
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
};

export function ConversationSidebar({
  sessions,
  activeId,
  connected,
  open,
  query,
  renaming,
  confirmDelete,
  onToggle,
  onClose,
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
}: Props) {
  const toggleRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    onClose();
    toggleRef.current?.focus();
  };

  return (
    <>
      <button
        ref={toggleRef}
        className="sidebar-toggle ghost"
        type="button"
        aria-expanded={open}
        aria-controls="conversation-sidebar"
        onClick={onToggle}
      >
        {open ? "대화 목록 닫기" : "대화 목록"}
      </button>
      <aside
        className="sidebar"
        id="conversation-sidebar"
        aria-label="대화 목록"
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
      >
        <h1>digithive</h1>
        <button className="primary" type="button" data-testid="new-session" onClick={onNew}>
          새 대화
        </button>
        <input
          className="search"
          type="search"
          placeholder="대화 검색"
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
    </>
  );
}
