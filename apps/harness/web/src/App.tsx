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
import { WorkPanel } from "./work/WorkPanel";
import { ConnectionsPanel } from "./connections/ConnectionsPanel";
import { WorkflowsPanel } from "./workflows/WorkflowsPanel";
import { KnowledgePanel } from "./knowledge/KnowledgePanel";
import { Login } from "./auth/Login";
import { watchBuild } from "./buildCheck";
import { TAB_PATHS, routeOf, tabPath, type Tab } from "./routes";
import { ChatView, cancelQueued, resumeQueue, useQueue } from "./chat/ChatView";
import type { RenameTarget } from "./sidebar/ConversationSidebar";

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
  | { type: "active"; id: string | null }
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

/**
 * The directory the app is served from, ending in `/`.
 *
 * `document.baseURI` is the *current page's* URL, not the mount point. On `/chat/<id>`
 * it therefore pointed at the conversation, and every link was built on top of it:
 * `/chat/<id>` → `/chat/<id>/chat/<id2>` → `//chat//chat//chat/<id3>`. The app is
 * served at the origin root (the server answers `/`, `/chat`, `/chat/<id>` and the
 * other tabs from one shell), so the root is the origin itself.
 */
function appRoot(): string {
  return "/";
}

/** The app's own path: the address minus the root above. */
function appPath(): string {
  return new URL(window.location.href).pathname;
}

/**
 * The tab comes from the address, so a reload or a shared link opens the same screen and
 * back/forward move between tabs. A static host (a file:// preview, an `/assets/` shell)
 * cannot route paths, so there the address is a `?tab=` query instead; the app uses
 * whichever form its own location already uses.
 */
function readLocation(): { tab: Tab; sessionId: string | null } {
  const path = appPath();
  // A query address is the static host's form; otherwise the path is the answer.
  if (!new URLSearchParams(window.location.search).has("tab")) return routeOf(path);
  const route = routeOf(path);
  if (route.sessionId !== null) return route;
  const query = new URLSearchParams(window.location.search);
  if (query.get("oauth") !== null) return { tab: "connections", sessionId: null };
  const tab = query.get("tab");
  const known: readonly Tab[] = ["chat", "work", "workflows", "connections", "knowledge"];
  const found = known.find((candidate) => candidate === tab);
  return { tab: found ?? "chat", sessionId: query.get("session") };
}

function locationUsingQuery(): boolean {
  return new URLSearchParams(window.location.search).has("tab");
}

function addressFor(tab: Tab, sessionId: string | null): string {
  const target = tabPath(tab, tab === "chat" ? sessionId : null).replace(/^\//, "");
  if (locationUsingQuery()) {
    const query = new URLSearchParams();
    if (tab !== "chat") query.set("tab", tab);
    if (tab === "chat" && sessionId) query.set("session", sessionId);
    const suffix = query.toString();
    return `${window.location.origin}${appRoot()}${suffix.length > 0 ? `?${suffix}` : ""}`;
  }
  return `${window.location.origin}${appRoot()}${target}`;
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [route, setRoute] = useState(readLocation);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [queueRevision, setQueueRevision] = useState(0);
  const queue = useQueue(state.activeId, queueRevision);

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

  /** Moves to a tab (and conversation) and records it in the address. */
  const go = useCallback((tab: Tab, sessionId: string | null, replace = false) => {
    const address = addressFor(tab, sessionId);
    if (window.location.href !== address)
      window.history[replace ? "replaceState" : "pushState"](null, "", address);
    setRoute({ tab, sessionId });
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(readLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // An address written by the old links is rewritten in place, so a bookmarked
  // `//chat//chat/<id>` becomes `/chat/<id>` without a second entry in history.
  useEffect(() => {
    const current = readLocation();
    const canonical = addressFor(current.tab, current.sessionId);
    if (window.location.href !== canonical) window.history.replaceState(null, "", canonical);
  }, []);

  // The chat tab owns the conversation; opening another tab keeps it in memory.
  const routeSession = route.tab === "chat" ? route.sessionId : null;
  useEffect(() => {
    if (routeSession) dispatch({ type: "active", id: routeSession });
  }, [routeSession]);

  // Loaded once: later navigation is driven by the address and the list, so the
  // first conversation the address names is the only one this effect picks.
  const initialSession = useState(() => readLocation().sessionId)[0];
  useEffect(() => {
    if (authed !== true) return undefined;
    let cancelled = false;
    void (async () => {
      const sessions = await reloadSessions();
      if (cancelled) return;
      const fromRoute = initialSession
        ? sessions.find((session) => session.id === initialSession)
        : undefined;
      const first = fromRoute ?? sessions[0];
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
    // Only the first authenticated load picks a conversation; later navigations are
    // driven by the address and the list.
  }, [authed, reloadSessions, initialSession]);

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
      if (!cancelled) {
        reloadEntries(id).catch(reportError);
        setQueueRevision((value) => value + 1);
      }
    });
    on(
      "turn.response.aborted",
      entryPayload.extend({ reason: z.string().optional() }),
      (payload) => {
        dispatch({ type: "status", entryId: payload.entryId, status: "aborted" });
        dispatch({ type: "error", message: payload.reason ?? "응답 생성이 중단되었습니다." });
        if (!cancelled) {
          reloadEntries(id).catch(reportError);
          setQueueRevision((value) => value + 1);
        }
      },
    );
    // Anything that changes the queue (another tab, a drain, a pause) is read again.
    for (const kind of [
      "queue.enqueued",
      "queue.dequeued",
      "queue.cancelled",
      "queue.paused",
      "session.renamed",
    ])
      on(kind, z.unknown(), () => {
        setQueueRevision((value) => value + 1);
        if (kind === "session.renamed" && !cancelled) onSessionRenamed();
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
      // A queued question deliberately does not touch the transcript; refreshing it
      // would show the same conversation as if nothing had happened.
      setQueueRevision((value) => value + 1);
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
    setListOpen(false);
    go("chat", created.id);
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
      if (next) {
        dispatch({ type: "active", id: next.id });
        go("chat", next.id, true);
      } else {
        dispatch({ type: "active", id: null });
        go("chat", null, true);
      }
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
      go("chat", created.sessionId);
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

  const active = state.sessions.find((session) => session.id === state.activeId) ?? null;
  const tabs: readonly { tab: Tab; label: string; testId: string }[] = [
    { tab: "chat", label: "대화", testId: "tab-chat" },
    { tab: "work", label: "실행 로그", testId: "tab-work" },
    { tab: "workflows", label: "워크플로", testId: "tab-workflows" },
    { tab: "connections", label: "연결", testId: "tab-connections" },
    { tab: "knowledge", label: "기억", testId: "tab-knowledge" },
  ];

  return (
    <div className="shell">
      <nav className="tabs" role="tablist" aria-label="화면">
        {/* Real links: the address is the state, so a tab can be opened in a new tab. */}
        {tabs.map(({ tab, label, testId }) => (
          <a
            key={tab}
            role="tab"
            href={TAB_PATHS[tab]}
            aria-selected={route.tab === tab}
            data-testid={testId}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              go(tab, tab === "chat" ? state.activeId : null);
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      <main className="conversation" aria-label={tabs.find(({ tab }) => tab === route.tab)?.label}>
        {route.tab === "work" ? (
          <WorkPanel />
        ) : route.tab === "workflows" ? (
          <WorkflowsPanel />
        ) : route.tab === "connections" ? (
          <ConnectionsPanel />
        ) : route.tab === "knowledge" ? (
          <KnowledgePanel />
        ) : (
          <ChatView
            sessions={state.sessions}
            active={active}
            entries={state.entries}
            error={state.error}
            connected={state.connected}
            query={query}
            listOpen={listOpen}
            renaming={renaming}
            confirmDelete={confirmDelete}
            editing={editing}
            queue={queue}
            onOpenList={() => setListOpen(true)}
            onCloseList={() => setListOpen(false)}
            onNew={() => void newSession()}
            onSearch={(value) => void search(value)}
            onSelect={(id) => {
              dispatch({ type: "active", id });
              setListOpen(false);
              go("chat", id);
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
            onSend={(text) => void send(text)}
            onQueueCancel={(queueId) => {
              const id = state.activeId;
              if (!id) return;
              void cancelQueued(id, queueId)
                .catch(reportError)
                .finally(() => setQueueRevision((value) => value + 1));
            }}
            onQueueResume={() => {
              const id = state.activeId;
              if (!id) return;
              void resumeQueue(id)
                .catch(reportError)
                .finally(() => setQueueRevision((value) => value + 1));
            }}
            onEditStart={(id, text) => setEditing({ id, text })}
            onEditChange={(text) =>
              setEditing((current) => (current ? { id: current.id, text } : current))
            }
            onEditSave={() => void saveEdit()}
            onEditCancel={() => setEditing(null)}
            onRegenerate={(entryId) => void regenerate(entryId)}
            onFork={(entryId) => void fork(entryId)}
            onBranch={(entryId, direction) => void switchBranch(entryId, direction)}
          />
        )}
      </main>
      {/* `sending` only blocks a second submit of the same box; a running answer never
          removes the invitation to type. */}
      <span className="visually-hidden" data-testid="sending" aria-live="polite">
        {sending ? "전송 중" : ""}
      </span>
    </div>
  );
}
