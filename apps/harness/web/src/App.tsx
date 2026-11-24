import { useEffect, useReducer, useRef, useState } from "react";
import { getJson, postJson, sendJson, type Entry, type Part, type Session } from "./api";
import { Composer } from "./composer/Composer";
import { WorkPanel } from "./work/WorkPanel";

type State = {
  readonly sessions: Session[];
  readonly activeId: string | null;
  readonly entries: Entry[];
  readonly lastSeq: number;
  readonly connected: boolean;
  readonly error: string | null;
};

type Action =
  | { type: "snapshot"; sessions: Session[]; entries: Entry[]; lastSeq: number }
  | { type: "sessions"; sessions: Session[] }
  | { type: "active"; id: string }
  | { type: "entries"; entries: Entry[] }
  | { type: "started"; entryId: string }
  | { type: "delta"; entryId: string; text: string }
  | { type: "status"; entryId: string; status: string }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "seq"; seq: number };

const initial: State = { sessions: [], activeId: null, entries: [], lastSeq: 0, connected: false, error: null };

function appendText(parts: Part[], text: string): Part[] {
  const last = parts.at(-1);
  if (last && last.type === "text") return [...parts.slice(0, -1), { type: "text", text: last.text + text }];
  return [...parts, { type: "text", text }];
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "snapshot":
      return { ...state, sessions: action.sessions, entries: action.entries, lastSeq: Math.max(state.lastSeq, action.lastSeq) };
    case "sessions":
      return { ...state, sessions: action.sessions };
    case "active":
      return { ...state, activeId: action.id, entries: [] };
    case "entries":
      return { ...state, entries: action.entries };
    case "started":
      if (state.entries.some((entry) => entry.id === action.entryId)) return state;
      return {
        ...state,
        entries: [
          ...state.entries,
          {
            id: action.entryId,
            sessionId: state.activeId ?? "",
            kind: "message",
            role: "assistant",
            status: "streaming",
            parts: [],
            createdAt: new Date().toISOString(),
            seq: Number.MAX_SAFE_INTEGER,
          },
        ],
      };
    case "delta": {
      const exists = state.entries.some((entry) => entry.id === action.entryId);
      if (!exists) {
        return {
          ...state,
          entries: [
            ...state.entries,
            {
              id: action.entryId,
              sessionId: state.activeId ?? "",
              kind: "message",
              role: "assistant",
              status: "streaming",
              parts: [{ type: "text", text: action.text }],
              createdAt: new Date().toISOString(),
              seq: Number.MAX_SAFE_INTEGER,
            },
          ],
        };
      }
      return {
        ...state,
        entries: state.entries.map((entry) => (entry.id === action.entryId ? { ...entry, parts: appendText(entry.parts, action.text) } : entry)),
      };
    }
    case "status":
      return { ...state, entries: state.entries.map((entry) => (entry.id === action.entryId ? { ...entry, status: action.status } : entry)) };
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return { ...state, error: action.message };
    case "seq":
      return { ...state, lastSeq: Math.max(state.lastSeq, action.seq) };
  }
}

function Parts({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "text")
          return (
            <p key={index} className="text">
              {part.text}
            </p>
          );
        if (part.type === "reasoning")
          return (
            <p key={index} className="reasoning">
              {part.text}
            </p>
          );
        if (part.type === "tool_call")
          return (
            <p key={index} className="tool-call" data-testid="tool-call">
              도구 호출 · {part.name}
            </p>
          );
        if (part.type === "tool_result")
          return (
            <p key={index} className={part.denied ? "tool-result denied" : "tool-result"} data-testid="tool-result">
              {part.denied ? "거부됨" : part.timeout ? "시간 초과" : "결과"} · {part.name}
            </p>
          );
        return (
          <p key={index} className="error">
            {part.message}
          </p>
        );
      })}
    </>
  );
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"chat" | "work">("chat");
  const activeRef = useRef<string | null>(null);
  activeRef.current = state.activeId;

  const reloadSessions = async (q?: string) => {
    const suffix = q && q.trim().length > 0 ? `?q=${encodeURIComponent(q.trim())}` : "";
    const body = await getJson<{ sessions: Session[] }>(`/api/sessions${suffix}`);
    dispatch({ type: "sessions", sessions: body.sessions });
    return body.sessions;
  };

  const reloadEntries = async (id: string) => {
    const body = await getJson<{ entries: Entry[] }>(`/api/sessions/${id}/entries`);
    dispatch({ type: "entries", entries: body.entries });
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const sessions = await reloadSessions();
      if (cancelled) return;
      const first = sessions[0];
      if (first) dispatch({ type: "active", id: first.id });
      else {
        const created = await postJson<Session>("/api/sessions", { title: "첫 대화" });
        dispatch({ type: "sessions", sessions: [created] });
        dispatch({ type: "active", id: created.id });
      }
    })().catch((error: unknown) => dispatch({ type: "error", message: String(error) }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = state.activeId;
    if (!id) return;
    let cancelled = false;
    void reloadEntries(id).catch((error: unknown) => dispatch({ type: "error", message: String(error) }));

    const source = new EventSource(`/api/events?after=0&session=${encodeURIComponent(id)}`);
    source.addEventListener("snapshot", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { sessions: Session[]; entries: Entry[]; lastSeq: number };
      dispatch({ type: "snapshot", sessions: data.sessions, entries: data.entries, lastSeq: data.lastSeq });
      dispatch({ type: "connected", value: true });
    });
    const on = (kind: string, handler: (payload: Record<string, unknown>, seq: number) => void) => {
      source.addEventListener(kind, (event) => {
        const message = event as MessageEvent<string>;
        const seq = Number(message.lastEventId || "0");
        if (seq > 0) dispatch({ type: "seq", seq });
        handler(JSON.parse(message.data) as Record<string, unknown>, seq);
      });
    };
    on("message.started", (payload) => dispatch({ type: "started", entryId: String(payload["entryId"]) }));
    on("message.delta", (payload) =>
      dispatch({ type: "delta", entryId: String(payload["entryId"]), text: String(payload["text"] ?? payload["reasoning"] ?? "") }),
    );
    on("message.completed", (payload) => {
      dispatch({ type: "status", entryId: String(payload["entryId"]), status: "complete" });
      if (!cancelled) void reloadEntries(id);
    });
    on("message.aborted", (payload) => {
      dispatch({ type: "status", entryId: String(payload["entryId"]), status: "aborted" });
      if (!cancelled) void reloadEntries(id);
    });
    on("session.renamed", () => {
      if (!cancelled) void reloadSessions(query);
    });
    source.onerror = () => dispatch({ type: "connected", value: false });
    return () => {
      cancelled = true;
      source.close();
    };
  }, [state.activeId]);

  const send = async (text: string) => {
    const id = state.activeId;
    if (!id) return;
    setSending(true);
    dispatch({ type: "error", message: null });
    try {
      await postJson(`/api/sessions/${id}/messages`, { text });
      await reloadEntries(id);
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSending(false);
    }
  };

  const newSession = async () => {
    const created = await postJson<Session>("/api/sessions", { title: "새 대화" });
    await reloadSessions();
    dispatch({ type: "active", id: created.id });
  };

  const saveRename = async () => {
    if (!renaming) return;
    try {
      await sendJson("PATCH", `/api/sessions/${renaming.id}`, { title: renaming.title });
      setRenaming(null);
      await reloadSessions(query);
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
    }
  };

  const removeSession = async (id: string) => {
    try {
      await sendJson("DELETE", `/api/sessions/${id}`);
      setConfirmDelete(null);
      const sessions = await reloadSessions(query);
      const next = sessions[0];
      if (next) dispatch({ type: "active", id: next.id });
      else dispatch({ type: "active", id: "" });
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
    }
  };

  const saveEdit = async () => {
    if (!editing || !state.activeId) return;
    const id = state.activeId;
    try {
      await postJson(`/api/sessions/${id}/entries/${editing.id}/edit`, { text: editing.text });
      setEditing(null);
      await reloadEntries(id);
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
    }
  };

  const regenerate = async (entryId: string) => {
    if (!state.activeId) return;
    try {
      await postJson(`/api/sessions/${state.activeId}/entries/${entryId}/regenerate`, {});
      await reloadEntries(state.activeId);
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
    }
  };

  const switchBranch = async (entryId: string, direction: -1 | 1) => {
    const entry = state.entries.find((candidate) => candidate.id === entryId);
    const ids = entry?.siblingIds ?? [];
    if (ids.length <= 1) return;
    const index = Math.max(0, ids.indexOf(entryId));
    const next = ids[(index + direction + ids.length) % ids.length];
    if (!next || !state.activeId) return;
    try {
      await postJson(`/api/sessions/${state.activeId}/entries/${next}/leaf`, { entryId: next });
      await reloadEntries(state.activeId);
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
    }
  };

  const fork = async (entryId: string) => {
    if (!state.activeId) return;
    try {
      const created = await postJson<{ sessionId: string }>(`/api/sessions/${state.activeId}/fork`, { entryId, title: "분기 대화" });
      await reloadSessions();
      dispatch({ type: "active", id: created.sessionId });
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
    }
  };

  const search = async (value: string) => {
    setQuery(value);
    try {
      await reloadSessions(value);
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
    }
  };

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="대화 목록">
        <h1>digithive</h1>
        <button className="primary" type="button" data-testid="new-session" onClick={() => void newSession()}>
          새 대화
        </button>
        <input
          className="search"
          type="search"
          placeholder="대화 검색"
          data-testid="session-search"
          value={query}
          onChange={(event) => void search(event.target.value)}
        />
        <ul className="session-list">
          {state.sessions.map((session) => (
            <li key={session.id} className="session-row">
              {renaming?.id === session.id ? (
                <span className="rename-form">
                  <input
                    data-testid="rename-input"
                    value={renaming.title}
                    onChange={(event) => setRenaming({ id: session.id, title: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveRename();
                      if (event.key === "Escape") setRenaming(null);
                    }}
                    autoFocus
                  />
                  <button type="button" data-testid="rename-save" onClick={() => void saveRename()}>
                    저장
                  </button>
                  <button type="button" onClick={() => setRenaming(null)}>
                    취소
                  </button>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    className="session-item"
                    aria-current={session.id === state.activeId ? "true" : undefined}
                    onClick={() => dispatch({ type: "active", id: session.id })}
                  >
                    {session.title}
                  </button>
                  <button
                    type="button"
                    className="icon"
                    aria-label={`${session.title} 이름 변경`}
                    data-testid="session-rename"
                    onClick={() => setRenaming({ id: session.id, title: session.title })}
                  >
                    ✎
                  </button>
                  {confirmDelete === session.id ? (
                    <>
                      <button type="button" className="icon danger" data-testid="session-delete-confirm" onClick={() => void removeSession(session.id)}>
                        삭제
                      </button>
                      <button type="button" className="icon" onClick={() => setConfirmDelete(null)}>
                        취소
                      </button>
                    </>
                  ) : (
                    <button type="button" className="icon" aria-label={`${session.title} 삭제`} data-testid="session-delete" onClick={() => setConfirmDelete(session.id)}>
                      ×
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        <p className="conn" data-testid="connection">
          {state.connected ? "연결됨" : "연결 중…"}
        </p>
      </aside>
      <main className="conversation" aria-label={view === "chat" ? "대화" : "작업"}>
        <nav className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={view === "chat"} data-testid="tab-chat" onClick={() => setView("chat")}>
            대화
          </button>
          <button type="button" role="tab" aria-selected={view === "work"} data-testid="tab-work" onClick={() => setView("work")}>
            작업
          </button>
        </nav>
        {view === "work" ? <WorkPanel /> : (
        <>
        <ol className="messages" data-testid="messages" aria-live="polite">
          {state.entries
            .filter((entry) => entry.kind === "message")
            .map((entry) => (
              <li
                key={entry.id}
                className={`bubble ${entry.role ?? "assistant"} ${entry.status ?? ""}`}
                data-testid={`entry-${entry.role ?? "assistant"}`}
                data-entry-id={entry.id}
              >
                <span className="author">
                  {entry.role === "user" ? "나" : "비서"}
                  {(entry.siblingCount ?? 1) > 1 ? (
                    <span className="branches">
                      <button type="button" className="icon" data-testid="branch-prev" onClick={() => void switchBranch(entry.id, -1)}>
                        ‹
                      </button>
                      <span data-testid="branch-index">
                        {entry.siblingIndex}/{entry.siblingCount}
                      </span>
                      <button type="button" className="icon" data-testid="branch-next" onClick={() => void switchBranch(entry.id, 1)}>
                        ›
                      </button>
                    </span>
                  ) : null}
                </span>
                {editing?.id === entry.id ? (
                  <span className="edit-form">
                    <textarea
                      data-testid="edit-input"
                      rows={3}
                      value={editing.text}
                      onChange={(event) => setEditing({ id: entry.id, text: event.target.value })}
                      autoFocus
                    />
                    <span className="row">
                      <button type="button" className="primary" data-testid="edit-save" onClick={() => void saveEdit()}>
                        저장 후 다시 묻기
                      </button>
                      <button type="button" onClick={() => setEditing(null)}>
                        취소
                      </button>
                    </span>
                  </span>
                ) : (
                  <Parts parts={entry.parts} />
                )}
                {entry.status === "streaming" && entry.parts.length === 0 ? <span className="typing">…</span> : null}
                <span className="actions">
                  {entry.role === "user" ? (
                    <button
                      type="button"
                      className="link"
                      data-testid="msg-edit"
                      onClick={() =>
                        setEditing({
                          id: entry.id,
                          text: entry.parts
                            .filter((part): part is { type: "text"; text: string } => part.type === "text")
                            .map((part) => part.text)
                            .join(""),
                        })
                      }
                    >
                      수정
                    </button>
                  ) : (
                    <button type="button" className="link" data-testid="msg-regenerate" onClick={() => void regenerate(entry.id)}>
                      재생성
                    </button>
                  )}
                  <button type="button" className="link" data-testid="msg-fork" onClick={() => void fork(entry.id)}>
                    분기
                  </button>
                </span>
              </li>
            ))}
        </ol>
        {state.error ? (
          <p className="error" role="alert" data-testid="chat-error">
            {state.error}
          </p>
        ) : null}
        <Composer disabled={sending} onSend={(text) => void send(text)} />
        </>
        )}
      </main>
    </div>
  );
}
