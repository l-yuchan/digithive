import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { RUN_STATUSES, canTransition, isLeaseExpired, leaseExpiry, settleExpiredRuns } from "../src/core/run-state";

function db(): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  return database;
}

function insertRun(database: Database, id: string, status: string, expiresAt: string | null, now: number): void {
  database
    .query(
      `INSERT INTO runs (id, origin, goal, status, lease_expires_at, budget_json, created_at)
       VALUES (?, 'conversation', 'g', ?, ?, '{}', ?)`,
    )
    .run(id, status, expiresAt, new Date(now).toISOString());
}

describe("run state machine", () => {
  test("allows the documented transitions and nothing else", () => {
    const allowed: [string, string][] = [
      ["queued", "running"],
      ["queued", "cancelled"],
      ["running", "awaiting_approval"],
      ["awaiting_approval", "running"],
      ["running", "succeeded"],
      ["running", "failed"],
      ["running", "cancelled"],
      ["running", "interrupted"],
      ["awaiting_approval", "cancelled"],
      ["awaiting_approval", "interrupted"],
    ];
    for (const [from, to] of allowed) {
      expect(canTransition(from as never, to as never)).toBe(true);
    }
    const forbidden: [string, string][] = [
      ["succeeded", "running"],
      ["cancelled", "running"],
      ["interrupted", "running"],
      ["queued", "succeeded"],
      ["failed", "awaiting_approval"],
    ];
    for (const [from, to] of forbidden) {
      expect(canTransition(from as never, to as never)).toBe(false);
    }
  });

  test("lease expiry is time-based, not truthiness-based", () => {
    const now = Date.parse("2026-11-24T05:00:00.000Z");
    expect(isLeaseExpired(leaseExpiry(now), now)).toBe(false);
    expect(isLeaseExpired(leaseExpiry(now), now + 45_001)).toBe(true);
    expect(isLeaseExpired(null, now)).toBe(true);
  });

  test("a run without a live lease is settled as interrupted, never left running", () => {
    const database = db();
    const now = Date.parse("2026-11-24T05:00:00.000Z");
    insertRun(database, "dead", "running", new Date(now - 1_000).toISOString(), now);
    insertRun(database, "alive", "running", new Date(now + 30_000).toISOString(), now);
    insertRun(database, "done", "succeeded", null, now);

    const settled = settleExpiredRuns(database, now);
    expect(settled).toEqual(["dead"]);

    const dead = database.query("SELECT status, cancel_intent, settled_at FROM runs WHERE id = 'dead'").get() as {
      status: string;
      cancel_intent: string;
      settled_at: string;
    };
    expect(dead.status).toBe("interrupted");
    expect(dead.cancel_intent).toBe("host_restart");
    expect(dead.settled_at).not.toBeNull();

    const alive = database.query("SELECT status FROM runs WHERE id = 'alive'").get() as { status: string };
    expect(alive.status).toBe("running");
    expect(RUN_STATUSES).toContain("interrupted" as never);
  });
});
