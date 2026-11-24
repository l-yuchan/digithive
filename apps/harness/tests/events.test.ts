import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";

function db(): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  return database;
}

describe("event log", () => {
  test("seq is monotonic and survives a reopen", () => {
    const log = new EventLog(db());
    const a = log.append({ kind: "turn.started", payload: { turn: 1 } });
    const b = log.append({ kind: "message.delta", payload: { text: "안" } });
    const c = log.append({ kind: "message.delta", payload: { text: "녕" } });
    expect([a.seq, b.seq, c.seq]).toEqual([a.seq, a.seq + 1, a.seq + 2]);
    expect(log.lastSeq()).toBe(c.seq);
  });

  test("after(seq) replays exactly the later events, in order", () => {
    const log = new EventLog(db());
    const first = log.append({ kind: "turn.started", payload: null });
    log.append({ kind: "message.delta", payload: { text: "a" } });
    log.append({ kind: "message.delta", payload: { text: "b" } });
    const replay = log.after(first.seq);
    expect(replay.map((event) => event.kind)).toEqual(["message.delta", "message.delta"]);
    expect(replay.map((event) => (event.payload as { text: string }).text)).toEqual(["a", "b"]);
  });

  test("after(seq, sessionId) filters to one session", () => {
    const log = new EventLog(db());
    log.append({ kind: "turn.started", payload: null, sessionId: "s1" });
    log.append({ kind: "turn.started", payload: null, sessionId: "s2" });
    expect(log.after(0, "s1")).toHaveLength(1);
    expect(log.after(0, "s2")).toHaveLength(1);
  });

  test("subscribers see live events and stop after unsubscribe", () => {
    const log = new EventLog(db());
    const seen: string[] = [];
    const stop = log.subscribe((event) => seen.push(event.kind));
    log.append({ kind: "run.started", payload: null });
    stop();
    log.append({ kind: "run.settled", payload: null });
    expect(seen).toEqual(["run.started"]);
  });

  test("unreadable payload does not crash replay", () => {
    const database = db();
    const log = new EventLog(database);
    database
      .query("INSERT INTO events (kind, payload_json, created_at) VALUES ('x','{not json','now')")
      .run();
    expect(log.after(0)[0]?.payload).toEqual({ unreadable: true });
  });
});
