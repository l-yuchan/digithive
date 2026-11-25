import { z } from "zod";
import { useCallback, useEffect, useEffectEvent, useReducer, useState } from "react";
import {
  apiUrl,
  EntrySchema,
  SessionSchema,
  getJson,
  postJson,
  sendJson,
  type Entry,
  type Part,
  type Session,
} from "./api";
import { Composer } from "./composer/Composer";
import { ConversationSidebar, type RenameTarget } from "./sidebar/ConversationSidebar";
import { WorkPanel } from "./work/WorkPanel";
import { ConnectionsPanel } from "./connections/ConnectionsPanel";
import { SchedulesPanel } from "./schedules/SchedulesPanel";
import { hasOAuthResult } from "./connections/oauth";
import { Login } from "./auth/Login";
import { MessageParts } from "./MessageParts";

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

const initial: State = {
  sessions: [],
  activeId: null,
  entries: [],
  lastSeq: 0,
  connected: false,
  error: null,
};

function appendText(parts: Part[], text: string): Part[] {
  const last = parts.at(-1);
  if (last && last.type === "text")
    return [...parts.slice(0, -1), { type: "text", text: last.text + text }];
  return [...parts, { type: "text", text }];
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "snapshot":
      return {
        ...state,
        sessions: action.sessions,
        entries: action.entries,
        lastSeq: Math.max(state.lastSeq, action.lastSeq),
      };
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
        entries: state.entries.map((entry) =>
          entry.id === action.entryId
            ? { ...entry, parts: appendText(entry.parts, action.text) }
            : entry,
        ),
      };
    }
    case "status":
      return {
        ...state,
        entries: state.entries.map((entry) =>
          entry.id === action.entryId ? { ...entry, status: action.status } : entry,
        ),
      };
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return { ...state, error: action.message };
    case "seq":
      return { ...state, lastSeq: Math.max(state.lastSeq, action.seq) };
    default: {
      const unexpected: never = action;
      throw new Error(`Unknown action: ${JSON.stringify(unexpected)}`);
    }
  }
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"chat" | "work" | "connections" | "schedules">(() =>
    hasOAuthResult(window.location.search) ? "connections" : "chat",
  );
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    void getJson("/api/session", z.object({ authenticated: z.boolean() }))
      .then((body) => setAuthed(body.authenticated))
      .catch(() => setAuthed(false));
  }, []);
  const reloadSessions = useCallback(async (q?: string) => {
    const suffix = q && q.trim().length > 0 ? `?q=${encodeURIComponent(q.trim())}` : "";
    const body = await getJson(
      `/api/sessions${suffix}`,
      z.object({ sessions: z.array(SessionSchema) }),
    );
    dispatch({ type: "sessions", sessions: body.sessions });
    return body.sessions;
  }, []);

  const reloadEntries = useCallback(async (id: string) => {
    const body = await getJson(
      `/api/sessions/${id}/entries`,
      z.object({ entries: z.array(EntrySchema) }),
    );
    dispatch({ type: "entries", entries: body.entries });
  }, []);
  const reportError = useCallback(
    (error: unknown) => dispatch({ type: "error", message: String(error) }),
    [],
  );
  const onSessionRenamed = useEffectEvent(() => {
    reloadSessions(query).catch(reportError);
  });

  useEffect(() => {
    if (authed !== true) return undefined;
    let cancelled = false;
    void (async () => {
      const sessions = await reloadSessions();
      if (cancelled) return;
      const first = sessions[0];
      if (first) dispatch({ type: "active", id: first.id });
      else {
        const created = await postJson("/api/sessions", { title: "첫 대화" }, SessionSchema);
        dispatch({ type: "sessions", sessions: [created] });
        dispatch({ type: "active", id: created.id });
      }
    })().catch((error: unknown) => dispatch({ type: "error", message: String(error) }));
    return () => {
      cancelled = true;
    };
  }, [authed, reloadSessions]);

  useEffect(() => {
    if (authed !== true) return undefined;
    const id = state.activeId;
    if (!id) return undefined;
    let cancelled = false;
    void reloadEntries(id).catch((error: unknown) =>
      dispatch({ type: "error", message: String(error) }),
    );

    const source = new EventSource(apiUrl(`/api/events?after=0&session=${encodeURIComponent(id)}`));
    source.addEventListener("snapshot", (event) => {
      if (!(event instanceof MessageEvent)) return;
      const data = z
        .object({
          sessions: z.array(SessionSchema),
          entries: z.array(EntrySchema),
          lastSeq: z.number(),
        })
        .parse(JSON.parse(z.string().parse(event.data)));
      dispatch({
        type: "snapshot",
        sessions: data.sessions,
        entries: data.entries,
        lastSeq: data.lastSeq,
      });
      dispatch({ type: "connected", value: true });
    });
    const on = <T,>(
      kind: string,
      schema: z.ZodType<T>,
      handler: (payload: T, seq: number) => void,
    ) => {
      source.addEventListener(kind, (event) => {
        if (!(event instanceof MessageEvent)) return;
        const seq = Number(event.lastEventId || "0");
        if (seq > 0) dispatch({ type: "seq", seq });
        const envelope = z
          .object({ payload: schema })
          .parse(JSON.parse(z.string().parse(event.data)));
        handler(envelope.payload, seq);
      });
    };
    const entryPayload = z.object({ entryId: z.string() });
    on("message.started", entryPayload, (payload) =>
      dispatch({ type: "started", entryId: payload.entryId }),
    );
    on(
      "message.delta",
      entryPayload.extend({ text: z.string().optional(), reasoning: z.string().optional() }),
      (payload) =>
        dispatch({
          type: "delta",
          entryId: payload.entryId,
          text: payload.text ?? payload.reasoning ?? "",
        }),
    );
    on("message.completed", entryPayload, (payload) => {
      dispatch({ type: "status", entryId: payload.entryId, status: "complete" });
      if (!cancelled) reloadEntries(id).catch(reportError);
    });
    on("message.aborted", entryPayload, (payload) => {
      dispatch({ type: "status", entryId: payload.entryId, status: "aborted" });
      if (!cancelled) reloadEntries(id).catch(reportError);
    });
    on("session.renamed", z.unknown(), () => {
      if (!cancelled) onSessionRenamed();
    });
    source.addEventListener("error", () => dispatch({ type: "connected", value: false }));
    return () => {
      cancelled = true;
      source.close();
    };
  }, [state.activeId, authed, reloadEntries, reportError]);

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
    const created = await postJson("/api/sessions", { title: "새 대화" }, SessionSchema);
    await reloadSessions();
    dispatch({ type: "active", id: created.id });
    setSidebarOpen(false);
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
      const created = await postJson(
        `/api/sessions/${state.activeId}/fork`,
        { entryId, title: "분기 대화" },
        z.object({ sessionId: z.string() }),
      );
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

  if (authed === null)
    return (
      <div className="login">
        <p>불러오는 중…</p>
      </div>
    );
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  return (
    <div className={`shell${sidebarOpen ? " sidebar-open" : ""}`}>
      <ConversationSidebar
        sessions={state.sessions}
        activeId={state.activeId}
        connected={state.connected}
        open={sidebarOpen}
        query={query}
        renaming={renaming}
        confirmDelete={confirmDelete}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        onClose={() => setSidebarOpen(false)}
        onNew={() => void newSession()}
        onSearch={(value) => void search(value)}
        onSelect={(id) => {
          dispatch({ type: "active", id });
          setSidebarOpen(false);
        }}
        onRenameStart={(session) => setRenaming({ id: session.id, title: session.title })}
        onRenameChange={(title) =>
          setRenaming((current) => (current ? { id: current.id, title } : current))
        }
        onRenameSave={() => void saveRename()}
        onRenameCancel={() => setRenaming(null)}
        onDeleteStart={(id) => setConfirmDelete(id)}
        onDelete={(id) => void removeSession(id)}
        onDeleteCancel={() => setConfirmDelete(null)}
      />
      <main
        className="conversation"
        aria-label={
          view === "chat"
            ? "대화"
            : view === "work"
              ? "작업"
              : view === "schedules"
                ? "스케줄"
                : "연결"
        }
      >
        <nav className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "chat"}
            data-testid="tab-chat"
            onClick={() => setView("chat")}
          >
            대화
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "work"}
            data-testid="tab-work"
            onClick={() => setView("work")}
          >
            작업
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "schedules"}
            data-testid="tab-schedules"
            onClick={() => setView("schedules")}
          >
            스케줄
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "connections"}
            data-testid="tab-connections"
            onClick={() => setView("connections")}
          >
            연결
          </button>
        </nav>
        {view === "work" ? (
          <WorkPanel />
        ) : view === "schedules" ? (
          <SchedulesPanel />
        ) : view === "connections" ? (
          <ConnectionsPanel />
        ) : (
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
                          <button
                            type="button"
                            className="icon"
                            data-testid="branch-prev"
                            onClick={() => void switchBranch(entry.id, -1)}
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
                            onClick={() => void switchBranch(entry.id, 1)}
                          >
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
                          onChange={(event) =>
                            setEditing({ id: entry.id, text: event.target.value })
                          }
                          autoFocus
                        />
                        <span className="row">
                          <button
                            type="button"
                            className="primary"
                            data-testid="edit-save"
                            onClick={() => void saveEdit()}
                          >
                            저장 후 다시 묻기
                          </button>
                          <button type="button" onClick={() => setEditing(null)}>
                            취소
                          </button>
                        </span>
                      </span>
                    ) : (
                      <MessageParts parts={entry.parts} />
                    )}
                    {entry.status === "streaming" && entry.parts.length === 0 ? (
                      <span className="typing">…</span>
                    ) : null}
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
                                .filter(
                                  (part): part is { type: "text"; text: string } =>
                                    part.type === "text",
                                )
                                .map((part) => part.text)
                                .join(""),
                            })
                          }
                        >
                          수정
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="link"
                          data-testid="msg-regenerate"
                          onClick={() => void regenerate(entry.id)}
                        >
                          재생성
                        </button>
                      )}
                      <button
                        type="button"
                        className="link"
                        data-testid="msg-fork"
                        onClick={() => void fork(entry.id)}
                      >
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
