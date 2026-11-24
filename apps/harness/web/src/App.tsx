import { useEffect, useReducer, useRef, useState } from "react";
import { getJson, postJson, type Entry, type Part, type Session } from "./api";
import { Composer } from "./composer/Composer";

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
  | { type: "part"; entryId: string; part: Part }
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
          { id: action.entryId, sessionId: state.activeId ?? "", kind: "message", role: "assistant", status: "streaming", parts: [], createdAt: new Date().toISOString(), seq: Number.MAX_SAFE_INTEGER },
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
          entry.id === action.entryId ? { ...entry, parts: appendText(entry.parts, action.text) } : entry,
        ),
      };
    }
    case "part":
      return {
        ...state,
        entries: state.entries.map((entry) => (entry.id === action.entryId ? { ...entry, parts: [...entry.parts, action.part] } : entry)),
      };
    case "status":
      return {
        ...state,
        entries: state.entries.map((entry) => (entry.id === action.entryId ? { ...entry, status: action.status } : entry)),
      };
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
        if (part.type === "text") return <p key={index} className="text">{part.text}</p>;
        if (part.type === "reasoning") return <p key={index} className="reasoning">{part.text}</p>;
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
        return <p key={index} className="error">{part.message}</p>;
      })}
    </>
  );
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const activeRef = useRef<string | null>(null);
  activeRef.current = state.activeId;
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const body = await getJson<{ sessions: Session[] }>("/api/sessions");
      if (cancelled) return;
      if (body.sessions.length === 0) {
        const created = await postJson<Session>("/api/sessions", { title: "첫 대화" });
        dispatch({ type: "sessions", sessions: [created] });
        dispatch({ type: "active", id: created.id });
        return;
      }
      dispatch({ type: "sessions", sessions: body.sessions });
      const first = body.sessions[0];
      if (first) dispatch({ type: "active", id: first.id });
    })().catch((error: unknown) => dispatch({ type: "error", message: String(error) }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = state.activeId;
    if (!id) return;
    let cancelled = false;
    const reloadEntries = () => {
      void getJson<{ entries: Entry[] }>(`/api/sessions/${id}/entries`)
        .then((body) => {
          if (!cancelled) dispatch({ type: "entries", entries: body.entries });
        })
        .catch((error: unknown) => dispatch({ type: "error", message: String(error) }));
    };
    reloadEntries();

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
    on("message.delta", (payload) => dispatch({ type: "delta", entryId: String(payload["entryId"]), text: String(payload["text"] ?? payload["reasoning"] ?? "") }));
    on("message.completed", (payload) => {
      dispatch({ type: "status", entryId: String(payload["entryId"]), status: "complete" });
      reloadEntries();
    });
    on("message.aborted", (payload) => {
      dispatch({ type: "status", entryId: String(payload["entryId"]), status: "aborted" });
      reloadEntries();
    });
    on("tool.result", (payload) =>
      dispatch({ type: "part", entryId: String(payload["entryId"] ?? ""), part: { type: "tool_result", id: String(payload["id"]), name: String(payload["name"]), output: String(payload["output"]) } }),
    );
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
      const body = await getJson<{ entries: Entry[] }>(`/api/sessions/${id}/entries`);
      dispatch({ type: "entries", entries: body.entries });
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSending(false);
    }
  };

  const newSession = async () => {
    const created = await postJson<Session>("/api/sessions", { title: "새 대화" });
    dispatch({ type: "sessions", sessions: [created, ...state.sessions] });
    dispatch({ type: "active", id: created.id });
  };

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="대화 목록">
        <h1>digithive</h1>
        <button className="primary" type="button" data-testid="new-session" onClick={() => void newSession()}>
          새 대화
        </button>
        <ul className="session-list">
          {state.sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className="session-item"
                aria-current={session.id === state.activeId ? "true" : undefined}
                onClick={() => dispatch({ type: "active", id: session.id })}
              >
                {session.title}
              </button>
            </li>
          ))}
        </ul>
        <p className="conn" data-testid="connection">
          {state.connected ? "연결됨" : "연결 중…"}
        </p>
      </aside>
      <main className="conversation" aria-label="대화">
        <ol className="messages" data-testid="messages" aria-live="polite">
          {state.entries
            .filter((entry) => entry.kind === "message")
            .map((entry) => (
              <li key={entry.id} className={`bubble ${entry.role ?? "assistant"} ${entry.status ?? ""}`} data-testid={`entry-${entry.role ?? "assistant"}`}>
                <span className="author">{entry.role === "user" ? "나" : "비서"}</span>
                <Parts parts={entry.parts} />
                {entry.status === "streaming" && entry.parts.length === 0 ? <span className="typing">…</span> : null}
              </li>
            ))}
        </ol>
        {state.error ? (
          <p className="error" role="alert" data-testid="chat-error">
            {state.error}
          </p>
        ) : null}
        <Composer disabled={sending} onSend={(text) => void send(text)} />
      </main>
    </div>
  );
}
