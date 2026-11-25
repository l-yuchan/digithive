import { expect, test } from "bun:test";
import { openDatabase } from "../src/store/db";
import { composeBriefing, runBriefing } from "../src/jobs/briefing";
import { EventLog } from "../src/events/log";

test("briefings exclude disabled account sources and attribute identical item IDs to their account", () => {
  const db = openDatabase(":memory:");
  try {
    db.query(
      "INSERT INTO integration_accounts(id,provider,subject,label,created_at,updated_at) VALUES ('second','google','sub-second','Second account','now','now')",
    ).run();
    db.query("INSERT INTO account_sources(account_id,source) VALUES ('second','gmail')").run();
    const insert = db.query(
      "INSERT INTO sync_items(account_id,source,item_id,title,detail,updated_at) VALUES (?,'gmail','shared',?,'body','now')",
    );
    insert.run("6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6", "Disabled newsletter");
    insert.run("second", "Enabled newsletter");
    db.query(
      "UPDATE account_sources SET enabled=0 WHERE account_id='6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6' AND source='gmail'",
    ).run();

    const content = composeBriefing(db, Date.parse("2026-11-25T00:00:00Z"));

    expect(
      content.mail.map((item) => ({ id: item.id, accountId: item.accountId, title: item.title })),
    ).toEqual([{ id: "shared", accountId: "second", title: "Enabled newsletter" }]);
    expect(content.text).toContain("[mail:second:shared]");
    expect(content.text).not.toContain("Disabled newsletter");
  } finally {
    db.close();
  }
});

test("an account-scoped briefing ignores every other account's items", () => {
  const db = openDatabase(":memory:");
  try {
    db.query(
      "INSERT INTO integration_accounts(id,provider,subject,label,created_at,updated_at) VALUES ('second','google','sub-second','Second account','now','now')",
    ).run();
    db.query("INSERT INTO account_sources(account_id,source) VALUES ('second','gmail')").run();
    const insert = db.query(
      "INSERT INTO sync_items(account_id,source,item_id,title,detail,updated_at) VALUES (?,'gmail','shared',?,'body','now')",
    );
    insert.run("6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6", "First account mail");
    insert.run("second", "Second account mail");

    const scoped = composeBriefing(db, Date.parse("2026-11-25T00:00:00Z"), {
      accountId: "second",
    });

    expect(scoped.mail.map((item) => item.title)).toEqual(["Second account mail"]);
    expect(scoped.text).not.toContain("First account mail");
  } finally {
    db.close();
  }
});

test("independent scheduled briefing runs in the same minute each publish once", async () => {
  const db = openDatabase(":memory:");
  try {
    const now = Date.parse("2026-11-25T12:00:00Z");
    const insertRun = db.query(
      "INSERT INTO runs(id,origin,goal,status,budget_json,created_at) VALUES (?,'work','briefing','running','{}',?)",
    );
    for (const id of ["first", "second"]) insertRun.run(id, new Date(now).toISOString());
    let deliveries = 0;
    const deps = {
      db,
      events: new EventLog(db),
      now: () => now,
      push: async () => {
        deliveries += 1;
        return { ok: true };
      },
    };

    const first = await runBriefing({ ...deps, runId: "first" }, true);
    const second = await runBriefing({ ...deps, runId: "second" }, true);
    const replay = await runBriefing({ ...deps, runId: "first" }, true);

    expect([first.stored, second.stored, replay.stored]).toEqual([true, true, false]);
    expect(deliveries).toBe(2);
    expect(db.query("SELECT run_id FROM briefings ORDER BY run_id").all()).toEqual([
      { run_id: "first" },
      { run_id: "second" },
    ]);
  } finally {
    db.close();
  }
});
