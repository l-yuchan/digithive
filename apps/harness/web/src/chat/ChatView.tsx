import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { getJson, postJson, sendJson, type Entry, type Session } from "../api";
import type { ConversationEvent } from "../api";
import { ConversationEventList } from "../MessageParts";
import { Composer } from "../composer/Composer";
import { ConversationList, type RenameTarget } from "../sidebar/ConversationSidebar";

/** The queue API's answer: what is waiting, and whether a failure paused it. */
export const QueueSchema = z.object({
  items: z.array(
    z.object({ id: z.string(), sessionId: z.string(), text: z.string(), createdAt: z.string() }),
  ),
  paused: z.boolean(),
});
export type Queue = z.infer<typeof QueueSchema>;

/** The user's words in a turn; tool chatter never becomes an editable prompt. */
export function conversationText(events: readonly ConversationEvent[]): string {
  return events
    .filter((event): event is Extract<ConversationEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.text)
    .join("\n");
}

type ChatProps = {
  readonly sessions: Session[];
  readonly active: Session | null;
  readonly entries: Entry[];
  readonly error: string | null;
  readonly connected: boolean;
  readonly query: string;
  readonly listOpen: boolean;
  readonly renaming: RenameTarget | null;
  readonly confirmDelete: string | null;
  readonly editing: { id: string; text: string } | null;
  readonly queue: Queue;
  readonly onOpenList: () => void;
  readonly onCloseList: () => void;
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
  readonly onSend: (text: string) => void;
  readonly onQueueCancel: (queueId: string) => void;
  readonly onQueueResume: () => void;
  readonly onEditStart: (id: string, text: string) => void;
  readonly onEditChange: (text: string) => void;
  readonly onEditSave: () => void;
  readonly onEditCancel: () => void;
  readonly onRegenerate: (entryId: string) => void;
  readonly onFork: (entryId: string) => void;
  readonly onBranch: (entryId: string, direction: -1 | 1) => void;
};

/**
 * The 대화 tab: the conversation list and the transcript share the tab, so the list is
 * part of the conversation rather than a global drawer. What the owner typed while an
 * answer was still arriving is shown above the composer, where it can be cancelled —
 * a queued message must never look like one that was already answered.
 */
export function ChatView(props: ChatProps) {
  const { active, entries, queue } = props;
  return (
    <div className={`chat${props.listOpen ? " list-open" : ""}`} data-testid="chat-panel">
      <ConversationList
        sessions={props.sessions}
        activeId={active?.id ?? null}
        connected={props.connected}
        query={props.query}
        renaming={props.renaming}
        confirmDelete={props.confirmDelete}
        onNew={props.onNew}
        onSearch={props.onSearch}
        onSelect={props.onSelect}
        onRenameStart={props.onRenameStart}
        onRenameChange={props.onRenameChange}
        onRenameSave={props.onRenameSave}
        onRenameCancel={props.onRenameCancel}
        onDeleteStart={props.onDeleteStart}
        onDelete={props.onDelete}
        onDeleteCancel={props.onDeleteCancel}
        onClose={props.onCloseList}
      />
      <section className="chat-main" aria-label="대화">
        <header className="chat-head">
          <button
            type="button"
            className="chat-list-toggle"
            aria-controls="conversation-list"
            aria-expanded={props.listOpen}
            data-testid="chat-list-toggle"
            onClick={props.onOpenList}
          >
            ☰ 대화 목록
          </button>
          <h2 data-testid="chat-title">{active?.title ?? "대화"}</h2>
          {active?.titleSource === "auto" ? (
            <span className="title-source" data-testid="title-source">
              자동 이름
            </span>
          ) : null}
        </header>
        <ol className="messages" data-testid="messages" aria-live="polite">
          {entries
            .filter((entry) => entry.kind === "message")
            .map((entry, _index, visible) =>
              entry.role === "user" ? (
                <li
                  key={entry.id}
                  className={`turn user ${entry.status ?? ""}`}
                  data-testid="entry-user"
                  data-entry-id={entry.id}
                >
                  <span className="author">
                    나
                    {(entry.siblingCount ?? 1) > 1 ? (
                      <span className="branches">
                        <button
                          type="button"
                          className="icon"
                          data-testid="branch-prev"
                          onClick={() => props.onBranch(entry.id, -1)}
                        >
                          ‹
                        </button>
                        <span data-testid="branch-index">
                          {entry.siblingIndex}/{entry.siblingCount}
                        </span>
                        <button
                          type="button"
                          className="icon"
                          data-testid="branch-next"
                          onClick={() => props.onBranch(entry.id, 1)}
                        >
                          ›
                        </button>
                      </span>
                    ) : null}
                  </span>
                  <p className="event text">{conversationText(entry.events)}</p>
                  <span className="actions">
                    <button
                      type="button"
                      className="link"
                      data-testid="msg-edit"
                      onClick={() => props.onEditStart(entry.id, conversationText(entry.events))}
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      className="link"
                      data-testid="msg-fork"
                      onClick={() => props.onFork(entry.id)}
                    >
                      분기
                    </button>
                  </span>
                </li>
              ) : (
                <li
                  key={entry.id}
                  className={`turn assistant ${entry.status ?? ""}`}
                  data-testid="entry-assistant"
                  data-entry-id={entry.id}
                >
                  <span className="author">비서</span>
                  <div className="events">
                    <ConversationEventList events={entry.events} status={entry.status} />
                  </div>
                  {/* Actions belong to the turn, not to each event: regenerate
                      once at the end, fork once, nothing repeated. */}
                  <span className="actions">
                    {visible.at(-1)?.id === entry.id ? (
                      <button
                        type="button"
                        className="link"
                        data-testid="msg-regenerate"
                        onClick={() => props.onRegenerate(entry.id)}
                      >
                        재생성
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="link"
                      data-testid="msg-fork"
                      onClick={() => props.onFork(entry.id)}
                    >
                      분기
                    </button>
                  </span>
                </li>
              ),
            )}
        </ol>
        {props.editing ? (
          <div className="edit-form" data-testid="edit-panel">
            <textarea
              data-testid="edit-input"
              rows={3}
              value={props.editing.text}
              onChange={(event) => props.onEditChange(event.target.value)}
              autoFocus
            />
            <span className="row">
              <button
                type="button"
                className="primary"
                data-testid="edit-save"
                onClick={props.onEditSave}
              >
                저장 후 다시 묻기
              </button>
              <button type="button" onClick={props.onEditCancel}>
                취소
              </button>
            </span>
          </div>
        ) : null}
        {queue.items.length > 0 || queue.paused ? (
          <section
            className={`queue${queue.paused ? " paused" : ""}`}
            aria-label="대기 중인 메시지"
            data-testid="queue-panel"
          >
            <header>
              <strong>대기 중 · {queue.items.length}</strong>
              {queue.paused ? (
                <span className="queue-paused">이전 응답이 실패해 멈췄습니다</span>
              ) : null}
              {queue.paused ? (
                <button
                  type="button"
                  className="link"
                  data-testid="queue-resume"
                  onClick={props.onQueueResume}
                >
                  다시 시작
                </button>
              ) : null}
            </header>
            <ol>
              {queue.items.map((item) => (
                <li key={item.id} data-testid="queue-item">
                  <span>{item.text}</span>
                  <button
                    type="button"
                    className="icon"
                    aria-label={`대기 취소: ${item.text}`}
                    data-testid="queue-cancel"
                    onClick={() => props.onQueueCancel(item.id)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {props.error ? (
          <p className="error" role="alert" data-testid="chat-error">
            {props.error}
          </p>
        ) : null}
        <Composer onSend={props.onSend} />
      </section>
    </div>
  );
}

const EMPTY_QUEUE: Queue = { items: [], paused: false };

/**
 * Reads the queue for the active conversation. It is an external value that changes by
 * itself (another tab, a drain, a pause), so it is polled while the tab is open; the
 * local revision only forces an immediate re-read after this tab acts.
 */
export function useQueue(sessionId: string | null, revision: number): Queue {
  const [queue, setQueue] = useState<Queue>(EMPTY_QUEUE);
  const read = useCallback(() => {
    if (!sessionId) return () => undefined;
    let cancelled = false;
    void getJson(`/api/sessions/${encodeURIComponent(sessionId)}/queue`, QueueSchema)
      .then((value) => {
        if (!cancelled) setQueue(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  // The interval is tied to the conversation, so acting in this tab does not restart
  // it; the revision is a request for one more read and only that.
  useEffect(() => {
    if (!sessionId) return undefined;
    const stop = read();
    const timer = setInterval(() => read(), 2_000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [sessionId, read]);
  useEffect(() => {
    if (revision === 0) return undefined;
    return read();
  }, [revision, read]);
  // Nothing queued belongs to no conversation: derived, not a second state to keep.
  return sessionId ? queue : EMPTY_QUEUE;
}

export async function cancelQueued(sessionId: string, queueId: string): Promise<void> {
  await sendJson(
    "DELETE",
    `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}`,
  );
}

export async function resumeQueue(sessionId: string): Promise<void> {
  await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/queue/resume`, {});
}
