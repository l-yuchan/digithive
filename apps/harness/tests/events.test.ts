import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { openDatabase } from "../src/store/db";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

function db(): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  return database;
}

describe("event log", () => {
  test("seq is monotonic and survives a reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "event-reopen-"));
    const path = join(root, "events.db");
    let database = openDatabase(path);
    try {
      const log = new EventLog(database);
      const a = log.append({ kind: "turn.started", payload: { turn: 1 } });
      const b = log.append({ kind: "message.delta", payload: { text: "안" } });
      database.close();
      database = openDatabase(path);
      const reopened = new EventLog(database);
      const c = reopened.append({ kind: "message.delta", payload: { text: "녕" } });
      expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
      expect(reopened.after(a.seq).map((event) => event.payload)).toEqual([
        { text: "안" },
        { text: "녕" },
      ]);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("after(seq) replays exactly the later events, in order", () => {
    const log = new EventLog(db());
    const first = log.append({ kind: "turn.started", payload: null });
    log.append({ kind: "message.delta", payload: { text: "a" } });
    log.append({ kind: "message.delta", payload: { text: "b" } });
    const replay = log.after(first.seq);
    expect(replay.map((event) => event.kind)).toEqual(["message.delta", "message.delta"]);
    expect(replay.map((event) => z.object({ text: z.string() }).parse(event.payload).text)).toEqual(
      ["a", "b"],
    );
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

test("local appends do not skip earlier events written by another connection", () => {
  const database = db();
  try {
    const first = new EventLog(database);
    const second = new EventLog(database);
    const seen: string[] = [];
    const stop = first.subscribe((event) => seen.push(event.kind));
    try {
      second.append({ kind: "external", payload: null });
      first.append({ kind: "local", payload: null });
      expect(seen).toEqual(["external", "local"]);
    } finally {
      stop();
    }
  } finally {
    database.close();
  }
});

test("subscribing from a replay cursor delivers events written between replay and subscription", async () => {
  const database = db();
  const log = new EventLog(database);
  const replayCursor = log.lastSeq();
  log.append({ kind: "in-the-gap", payload: null });
  let stop: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const delivered = new Promise<string>((resolve) => {
      stop = log.subscribe((event) => resolve(event.kind), replayCursor);
    });
    expect(
      await Promise.race([
        delivered,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("gap event lost")), 500);
        }),
      ]),
    ).toBe("in-the-gap");
  } finally {
    if (timer) clearTimeout(timer);
    stop();
    database.close();
  }
});
