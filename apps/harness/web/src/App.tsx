import { z } from "zod";
import { useCallback, useEffect, useEffectEvent, useReducer, useState } from "react";
import {
  apiUrl,
  EntrySchema,
  SessionSchema,
  getJson,
  postJson,
  sendJson,
  type ConversationEvent,
  type Entry,
  type Session,
} from "./api";
import { Composer } from "./composer/Composer";
import { ConversationSidebar, type RenameTarget } from "./sidebar/ConversationSidebar";
import { WorkPanel } from "./work/WorkPanel";
import { ConnectionsPanel } from "./connections/ConnectionsPanel";
import { WorkflowsPanel } from "./workflows/WorkflowsPanel";
import { KnowledgePanel } from "./knowledge/KnowledgePanel";
import { hasOAuthResult } from "./connections/oauth";
import { Login } from "./auth/Login";
import { ConversationEventList } from "./MessageParts";
import { watchBuild } from "./buildCheck";

/** The user's words in a turn; tool chatter never becomes an editable prompt. */
function conversationText(events: readonly ConversationEvent[]): string {
  return events
    .filter((event): event is Extract<ConversationEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.text)
    .join("\n");
}

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
  | {
      type: "delta";
      entryId: string;
      eventId: number;
      kind: "text" | "thinking";
      text: string;
    }
  | { type: "event"; entryId: string; event: ConversationEvent }
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

function textSize(events: readonly ConversationEvent[]): number {
  return events.reduce(
    (total, event) =>
      total + (event.type === "text" || event.type === "thinking" ? event.text.length : 0),
    0,
  );
}

/**
 * A reconnect replaces the list with the server's copy. An entry the reader is
 * watching stream can be a few deltas behind the server's last save, so the copy
 * with more text wins while the turn is still running.
 */
function mergeSnapshot(local: readonly Entry[], incoming: readonly Entry[]): Entry[] {
  const localById = new Map(local.map((entry) => [entry.id, entry]));
  const merged = incoming.map((entry) => {
    const current = localById.get(entry.id);
    if (
      current &&
      current.status === "streaming" &&
      entry.status === "streaming" &&
      textSize(current.events) > textSize(entry.events)
    )
      return { ...entry, events: current.events };
    return entry;
  });
  const known = new Set(merged.map((entry) => entry.id));
  for (const entry of local) {
    if (entry.status === "streaming" && !known.has(entry.id)) merged.push(entry);
  }
  return merged;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "snapshot":
      return {
        ...state,
        sessions: action.sessions,
        entries: mergeSnapshot(state.entries, action.entries),
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
            events: [],
            createdAt: new Date().toISOString(),
            seq: Number.MAX_SAFE_INTEGER,
          },
        ],
      };
    case "delta": {
      const delta = (events: readonly ConversationEvent[]): ConversationEvent[] => {
        const open = events.find((event) => event.id === action.eventId);
        if (open && (open.type === "text" || open.type === "thinking"))
          return events.map((event) =>
            event.id === action.eventId && (event.type === "text" || event.type === "thinking")
              ? { ...event, text: event.text + action.text }
              : event,
          );
        return [
          ...events.filter((event) => event.id !== action.eventId),
          { type: action.kind, id: action.eventId, text: action.text },
        ].toSorted((left, right) => left.id - right.id);
      };
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
              events: [{ type: action.kind, id: action.eventId, text: action.text }],
              createdAt: new Date().toISOString(),
              seq: Number.MAX_SAFE_INTEGER,
            },
          ],
        };
      }
      return {
        ...state,
        entries: state.entries.map((entry) =>
          entry.id === action.entryId ? { ...entry, events: delta(entry.events) } : entry,
        ),
      };
    }
    case "event": {
      if (!state.entries.some((entry) => entry.id === action.entryId)) return state;
      return {
        ...state,
        entries: state.entries.map((entry) =>
          entry.id === action.entryId
            ? {
                ...entry,
                events: [
                  ...entry.events.filter((event) => event.id !== action.event.id),
                  action.event,
                ].toSorted((left, right) => left.id - right.id),
              }
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
  const [view, setView] = useState<"chat" | "work" | "connections" | "workflows" | "knowledge">(
    () => (hasOAuthResult(window.location.search) ? "connections" : "chat"),
  );
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (authed !== true) return undefined;
    return watchBuild(() => window.location.reload());
  }, [authed]);

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

    const source = new EventSource(apiUrl(`/api/events?session=${encodeURIComponent(id)}`));
    source.addEventListener("open", () => dispatch({ type: "connected", value: true }));
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
    const eventPayload = entryPayload.extend({
      id: z.number(),
      callId: z.string().optional(),
      name: z.string().optional(),
      detail: z.string().optional(),
      failed: z.boolean().optional(),
    });
    on("turn.response.started", entryPayload, (payload) =>
      dispatch({ type: "started", entryId: payload.entryId }),
    );
    // Each kind is a different event in the turn, not a different key of one blob.
    const delta = (kind: "text" | "thinking") =>
      on(
        kind === "text" ? "text.delta" : "thinking.delta",
        entryPayload.extend({ id: z.number(), text: z.string() }),
        (payload) =>
          dispatch({
            type: "delta",
            entryId: payload.entryId,
            eventId: payload.id,
            kind,
            text: payload.text,
          }),
      );
    delta("text");
    delta("thinking");
    on("tool_call.started", eventPayload, (payload) => {
      if (payload.callId === undefined || payload.name === undefined) return;
      dispatch({
        type: "event",
        entryId: payload.entryId,
        event: {
          type: "tool_call",
          id: payload.id,
          callId: payload.callId,
          name: payload.name,
          detail: payload.detail ?? "",
        },
      });
    });
    on("tool_result.recorded", eventPayload, (payload) => {
      if (payload.callId === undefined || payload.name === undefined) return;
      dispatch({
        type: "event",
        entryId: payload.entryId,
        event: {
          type: "tool_result",
          id: payload.id,
          callId: payload.callId,
          name: payload.name,
          detail: payload.detail ?? "",
          ...(payload.failed ? { failed: true } : {}),
        },
      });
    });
    on("turn.response.completed", entryPayload, (payload) => {
      dispatch({ type: "status", entryId: payload.entryId, status: "complete" });
      if (!cancelled) reloadEntries(id).catch(reportError);
    });
    on(
      "turn.response.aborted",
      entryPayload.extend({ reason: z.string().optional() }),
      (payload) => {
        dispatch({ type: "status", entryId: payload.entryId, status: "aborted" });
        dispatch({ type: "error", message: payload.reason ?? "응답 생성이 중단되었습니다." });
        if (!cancelled) reloadEntries(id).catch(reportError);
      },
    );
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
              : view === "workflows"
                ? "워크플로"
                : view === "knowledge"
                  ? "기억과 파일"
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
            실행 로그
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "workflows"}
            data-testid="tab-workflows"
            onClick={() => setView("workflows")}
          >
            워크플로
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
          <button
            type="button"
            role="tab"
            aria-selected={view === "knowledge"}
            data-testid="tab-knowledge"
            onClick={() => setView("knowledge")}
          >
            기억
          </button>
        </nav>
        {view === "work" ? (
          <WorkPanel />
        ) : view === "workflows" ? (
          <WorkflowsPanel />
        ) : view === "connections" ? (
          <ConnectionsPanel />
        ) : view === "knowledge" ? (
          <KnowledgePanel />
        ) : (
          <>
            <ol className="messages" data-testid="messages" aria-live="polite">
              {state.entries
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
                      <p className="event text">{conversationText(entry.events)}</p>
                      <span className="actions">
                        <button
                          type="button"
                          className="link"
                          data-testid="msg-edit"
                          onClick={() =>
                            setEditing({ id: entry.id, text: conversationText(entry.events) })
                          }
                        >
                          수정
                        </button>
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
                  ) : (
                    <li
                      key={entry.id}
                      className={`turn assistant ${entry.status ?? ""}`}
                      data-testid="entry-assistant"
                      data-entry-id={entry.id}
                    >
                      <span className="author">비서</span>
                      <div className="events">
                        <ConversationEventList events={entry.events} />
                      </div>
                      {entry.status === "streaming" && entry.events.length === 0 ? (
                        <span className="typing">…</span>
                      ) : null}
                      {/* Actions belong to the turn, not to each event: regenerate
                          once at the end, fork once, nothing repeated. */}
                      <span className="actions">
                        {visible.at(-1)?.id === entry.id ? (
                          <button
                            type="button"
                            className="link"
                            data-testid="msg-regenerate"
                            onClick={() => void regenerate(entry.id)}
                          >
                            재생성
                          </button>
                        ) : null}
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
                  ),
                )}
            </ol>
            {editing ? (
              <div className="edit-form" data-testid="edit-panel">
                <textarea
                  data-testid="edit-input"
                  rows={3}
                  value={editing.text}
                  onChange={(event) => setEditing({ id: editing.id, text: event.target.value })}
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
              </div>
            ) : null}
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
