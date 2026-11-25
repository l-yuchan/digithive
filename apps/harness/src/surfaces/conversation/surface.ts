import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { EventLog } from "../../events/log";
import type { Entry } from "../../core/sessions";
import { conversationText } from "../../core/contracts";
import { listQueue, queuePaused, setQueuePaused, type QueuedMessage } from "../../core/queue";
import { executeTurn, prepareTurn, runTurn, type ConversationDeps, type TurnResult } from "./loop";
import { shouldName, titleRunInFlight } from "../../workflows/title-run";
import {
  cancelQueued,
  drainQueue,
  enqueueMessage,
  pauseQueue,
  queuedSessions,
  type QueueExecutor,
} from "./queue-executor";

/**
 * The conversation surface as the HTTP routes use it: a message either starts a turn
 * now or waits its place. Turns are serialised per conversation — two answering at
 * once would branch from the same leaf and overwrite each other's leaf — and the
 * queue lives in the database, so a restart resumes it.
 *
 * Order after a turn settles: the first answer is named first, then the next queued
 * question runs, so a name always describes the first exchange alone.
 */
export type Conversation = {
  /** Starts a turn at once, or queues the text behind the turn in flight. */
  readonly send: (
    sessionId: string,
    text: string,
    extra?: TurnExtra,
  ) => { accepted: true; queued: boolean };
  readonly queue: (sessionId: string) => {
    readonly items: QueuedMessage[];
    readonly paused: boolean;
  };
  readonly cancelQueued: (sessionId: string, queueId: string) => boolean;
  /** Continues the queue once a naming run ended, whatever it decided. */
  readonly resumeAfterTitle: (sessionId: string) => {
    readonly drained: boolean;
    readonly queued: number;
  };
  /** Owner-resumed drain after a failed turn paused the queue. */
  readonly resume: (sessionId: string) => { readonly drained: boolean; readonly queued: number };
  /** After a restart: resume every conversation that still has queued text. */
  readonly resumePending: () => number;
  /** A removed conversation never runs its queued text. */
  readonly discard: (sessionId: string) => number;
  /** Stops the surface's background work (the naming-run listener). */
  readonly close: () => void;
};

type TurnExtra = { readonly appendUser?: boolean; readonly parentId?: string | null };

export type ConversationRuntimeDeps = {
  readonly db: Database;
  readonly events: EventLog;
  /** Builds the turn's dependencies; the settle hook is added here, not by callers. */
  readonly turnDeps: () => ConversationDeps;
  /**
   * Asks the app to name a conversation now; true when a naming run started, in
   * which case the next queued question waits for it.
   */
  readonly startTitle?: (sessionId: string) => boolean;
  /** How long a naming run may hold the queue before it is stepped around. */
  readonly titleGuardMs?: number;
};

/** The material a title run reads: the first question, its reasoning, its answer, its tools. */
export function materialOf(entries: readonly Entry[]): {
  question: string;
  thinking: string;
  answer: string;
  tools: readonly string[];
} {
  const question = entries.find((entry) => entry.kind === "message" && entry.role === "user");
  const answer = entries.find((entry) => entry.kind === "message" && entry.role === "assistant");
  const thinking = (answer?.events ?? [])
    .filter(
      (event): event is Extract<typeof event, { type: "thinking" }> => event.type === "thinking",
    )
    .map((event) => event.text)
    .join("");
  const tools = [
    ...new Set(
      (answer?.events ?? []).flatMap((event) => (event.type === "tool_call" ? [event.name] : [])),
    ),
  ];
  return {
    question: question ? conversationText(question.events) : "",
    thinking,
    answer: answer ? conversationText(answer.events) : "",
    tools,
  };
}

export function createConversation(deps: ConversationRuntimeDeps): Conversation {
  const { db, events } = deps;
  const executor: QueueExecutor = { db, events };

  const run = (sessionId: string, text: string, extra: TurnExtra = {}) => {
    void runTurn(turnDepsFor(), { sessionId, text, ...extra }).catch((error: unknown) => {
      console.error("turn failed", error);
    });
  };

  /**
   * A queued turn is started here, in the server process, not handed to a worker: the
   * drain runs where a turn or a naming run just ended, and a row left queued for a
   * worker that is not running would hold the conversation open forever.
   */
  const claim = (sessionId: string, text: string) => {
    let runId: string;
    try {
      runId = prepareTurn(turnDepsFor(), { sessionId, text }).runId;
    } catch (error) {
      // The text stays queued; the owner resumes once the cause is fixed.
      pauseQueue(db, events, sessionId, `enqueue_failed: ${String(error)}`);
      return;
    }
    void executeTurn(turnDepsFor(), { sessionId, text }, runId).catch((error: unknown) => {
      console.error("queued turn failed", error);
    });
  };

  const drain = (sessionId: string, allowTitle: boolean) => ({
    drained: drainQueue(executor, sessionId, {
      allowTitle,
      paused: queuePaused(db, sessionId),
      idle: !busy(sessionId),
      shouldName: shouldName(db, sessionId),
      startTitle: (id) => {
        const started = deps.startTitle?.(id) ?? false;
        if (started) watchNaming(id);
        return started;
      },
      claim,
    }),
    queued: listQueue(db, sessionId).length,
  });

  /**
   * After a turn settled: a finished answer lets the next queued message run; a
   * failed one pauses the queue instead of meeting the same failure again. An aborted
   * turn (deadline) is not a model failure, so the queue keeps going.
   */
  const settle = (sessionId: string, result: TurnResult) => {
    if (result.status === "failed" && listQueue(db, sessionId).length > 0)
      pauseQueue(db, events, sessionId, "previous turn failed");
    drain(sessionId, true);
  };

  const busy = (sessionId: string) =>
    turnRunInFlight(db, sessionId) || titleRunInFlight(db, sessionId);

  const turnDepsFor = (): ConversationDeps => ({
    ...deps.turnDeps(),
    onSettled: ({ sessionId, result }) => settle(sessionId, result),
  });

  /**
   * A naming run releases the queue when it ends. The app reports that as an event
   * rather than through the executor, because the run may be executed by a worker in
   * another process; a guard timer covers a report that never comes.
   */
  const naming: { timer?: ReturnType<typeof setTimeout>; sessionId: string | null } = {
    sessionId: null,
  };
  const watchNaming = (sessionId: string) => {
    naming.sessionId = sessionId;
    if (naming.timer) clearTimeout(naming.timer);
    naming.timer = setTimeout(() => {
      if (naming.sessionId === sessionId) drain(sessionId, false);
    }, deps.titleGuardMs ?? 90_000);
    naming.timer.unref?.();
  };
  const unsubscribe = events.subscribe((event) => {
    if (event.kind !== "session.title_settled") return;
    const ended = z.string().safeParse(event.sessionId);
    if (!ended.success) return;
    if (naming.timer) clearTimeout(naming.timer);
    naming.sessionId = null;
    drain(ended.data, false);
  });
  // The subscription polls the database, so it must not outlive the surface: a caller
  // that drops the conversation (a test, or a shutdown) must not leave a timer reading
  // a closed handle.
  const stop = () => {
    unsubscribe();
    if (naming.timer) clearTimeout(naming.timer);
  };

  return {
    close: stop,
    send: (sessionId, text, extra = {}) => {
      // A paused queue belongs to the owner: nothing starts until they resume it.
      if (queuePaused(db, sessionId)) {
        enqueueMessage(executor, sessionId, text);
        return { accepted: true, queued: true };
      }
      if (busy(sessionId)) {
        enqueueMessage(executor, sessionId, text);
        return { accepted: true, queued: true };
      }
      // Naming the first answer must finish before a second question joins it.
      if (shouldName(db, sessionId)) {
        enqueueMessage(executor, sessionId, text);
        drain(sessionId, true);
        return { accepted: true, queued: true };
      }
      setQueuePaused(db, sessionId, false);
      run(sessionId, text, extra);
      return { accepted: true, queued: false };
    },
    queue: (sessionId) => ({ items: listQueue(db, sessionId), paused: queuePaused(db, sessionId) }),
    cancelQueued: (sessionId, queueId) => cancelQueued(executor, sessionId, queueId),
    resumeAfterTitle: (sessionId) => drain(sessionId, false),
    resume: (sessionId) => {
      setQueuePaused(db, sessionId, false);
      return drain(sessionId, true);
    },
    resumePending: () => {
      let resumed = 0;
      for (const sessionId of queuedSessions(db)) if (drain(sessionId, true).drained) resumed += 1;
      return resumed;
    },
    discard: (sessionId) =>
      db.query("DELETE FROM session_queue WHERE session_id = ?").run(sessionId).changes,
  };
}

/** A conversation turn is live while its run row is live. */
function turnRunInFlight(db: Database, sessionId: string): boolean {
  const row = db
    .query<{ live: number }, [string]>(
      "SELECT COUNT(*) AS live FROM runs WHERE session_id = ? AND origin = 'conversation' AND status IN ('queued','running','awaiting_approval')",
    )
    .get(sessionId);
  return (row?.live ?? 0) > 0;
}
