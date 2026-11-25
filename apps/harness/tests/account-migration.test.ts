import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../src/store/migrations";
import { migrate } from "../src/store/db";
import { open, seal } from "../src/core/vault";
import { upsertGoogleAccount } from "../src/integrations/accounts";

function oldDatabase(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 5)) {
    db.exec(migration.sql);
  }
  db.exec("PRAGMA user_version=5");
  return db;
}

test("the seeded Google row upgrades into an ordinary account without losing anything", () => {
  const db = oldDatabase();
  const encrypted = seal("migration-secret", '{"accessToken":"retained","refreshToken":"rt"}');
  db.query(
    "INSERT INTO oauth_tokens(provider,payload,scope,expires_at,updated_at) VALUES ('google',?,'read','expiry','updated')",
  ).run(encrypted);
  db.query(
    "INSERT INTO integration_state(source,cursor,last_sync_at,ok) VALUES ('gmail','mail-history','success',1)",
  ).run();
  db.query(
    "INSERT INTO sync_items(source,item_id,title,detail,updated_at) VALUES ('gmail','m1','제목','본문','updated')",
  ).run();

  migrate(db);

  const seeded = db
    .query<{ id: string; label: string; subject: string | null; email: string | null }, []>(
      "SELECT id,label,subject,email FROM integration_accounts ORDER BY provider,id",
    )
    .all();
  // The renamed legacy row is a normal account: it is the fallback owner of
  // pre-account data, and its label is not the old "기존 Google" marker any more.
  expect(seeded).toEqual([
    { id: "canvas-default", label: "한양 LMS", subject: null, email: null },
    {
      id: "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6",
      label: "Google 계정",
      subject: null,
      email: null,
    },
  ]);
  expect(
    db
      .query<{ account_id: string; payload: string }, []>(
        "SELECT account_id,payload FROM oauth_tokens",
      )
      .get(),
  ).toEqual({ account_id: "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6", payload: encrypted });
  expect(
    db
      .query<{ account_id: string; source: string; cursor: string }, []>(
        "SELECT account_id,source,cursor FROM account_sources WHERE source='gmail'",
      )
      .get(),
  ).toEqual({
    account_id: "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6",
    source: "gmail",
    cursor: "mail-history",
  });
  expect(
    db
      .query<{ account_id: string; item_id: string }, []>(
        "SELECT account_id,item_id FROM sync_items WHERE source='gmail'",
      )
      .get(),
  ).toEqual({ account_id: "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6", item_id: "m1" });

  // Added and migrated Google accounts are the same kind of row.
  const { id } = upsertGoogleAccount(db, { subject: "sub-new", email: "new@example.com" });
  const added = db
    .query<{ subject: string; label: string }, [string]>(
      "SELECT subject,label FROM integration_accounts WHERE id=?",
    )
    .get(id);
  expect(added).toEqual({ subject: "sub-new", label: "new@example.com" });
  db.close();
});

test("v5 credentials, source cursors and items retain their explicit account identity after migration", () => {
  const db = oldDatabase();
  const encrypted = seal("migration-secret", '{"accessToken":"retained"}');
  try {
    db.query(
      "INSERT INTO oauth_tokens(provider,payload,scope,expires_at,updated_at) VALUES ('google',?,'read','expiry','updated')",
    ).run(encrypted);
    for (const [source, cursor] of [
      ["gmail", "mail-history"],
      ["calendar", "calendar-sync"],
      ["canvas", "lms-cursor"],
    ] as const) {
      db.query(
        "INSERT INTO integration_state(source,cursor,last_sync_at,ok) VALUES (?,?,'success',1)",
      ).run(source, cursor);
      db.query(
        "INSERT INTO sync_items(source,item_id,title,detail,updated_at) VALUES (?,'same-id',?,'body','updated')",
      ).run(source, source);
    }
    db.query(
      "INSERT INTO runs(id,origin,goal,status,budget_json,created_at) VALUES ('old-run','work','retained','queued','{}','created')",
    ).run();

    migrate(db);

    const token = db
      .query<{ account_id: string; payload: string }, []>(
        "SELECT account_id,payload FROM oauth_tokens",
      )
      .get();
    expect(token?.account_id).toBe("6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6");
    expect(token?.payload).toBe(encrypted);
    expect(open("migration-secret", token?.payload ?? "")).toBe('{"accessToken":"retained"}');
    expect(
      db
        .query("SELECT account_id,source,cursor,last_sync_at FROM account_sources ORDER BY source")
        .all(),
    ).toEqual([
      {
        account_id: "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6",
        source: "calendar",
        cursor: "calendar-sync",
        last_sync_at: "success",
      },
      {
        account_id: "canvas-default",
        source: "canvas",
        cursor: "lms-cursor",
        last_sync_at: "success",
      },
      {
        account_id: "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6",
        source: "gmail",
        cursor: "mail-history",
        last_sync_at: "success",
      },
    ]);
    expect(
      db.query("SELECT account_id,source,item_id,detail FROM sync_items ORDER BY source").all(),
    ).toEqual([
      {
        account_id: "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6",
        source: "calendar",
        item_id: "same-id",
        detail: "body",
      },
      { account_id: "canvas-default", source: "canvas", item_id: "same-id", detail: "body" },
      {
        account_id: "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6",
        source: "gmail",
        item_id: "same-id",
        detail: "body",
      },
    ]);
    expect(
      db.query("SELECT goal,executor_json,timeout_seconds FROM runs WHERE id='old-run'").get(),
    ).toEqual({
      goal: "retained",
      executor_json: '{"kind":"agent"}',
      timeout_seconds: 1800,
    });
    expect(migrate(db)).toBe(0);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

function databaseAt8(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 8)) {
    db.exec(migration.sql);
  }
  db.exec("PRAGMA user_version=8");
  return db;
}

const RENAMED_LEGACY_ID = "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6";

test("v9 gives the placeholder account an ordinary id and moves every reference with it", () => {
  const db = databaseAt8();
  try {
    db.query(
      "INSERT INTO oauth_states(state,account_id,expires_at,created_at) VALUES ('st','google-default','later','now')",
    ).run();
    db.query(
      `INSERT INTO schedules
         (id,title,instruction,enabled,trigger_json,executor_json,timeout_seconds,next_run_at,created_at,updated_at)
       VALUES ('mine','내 수집','x',1,?,?,1800,NULL,'now','now')`,
    ).run(
      JSON.stringify({ kind: "interval", everySeconds: 900, anchorAt: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({
        kind: "builtin",
        name: "sync_sources",
        accountId: "google-default",
      }),
    );

    migrate(db);

    expect(
      db.query("SELECT id FROM integration_accounts WHERE id='google-default'").get(),
    ).toBeNull();
    expect(db.query("SELECT account_id FROM oauth_states WHERE state='st'").get()).toEqual({
      account_id: RENAMED_LEGACY_ID,
    });
    expect(db.query("SELECT executor_json FROM workflows WHERE id='wf-mine'").get()).toEqual({
      executor_json: JSON.stringify({
        kind: "builtin",
        name: "sync_sources",
        accountId: RENAMED_LEGACY_ID,
      }),
    });
    // The account-less seed is gone; every account has its own collection workflow.
    expect(db.query("SELECT id FROM workflows WHERE id='wf-system-sync'").get()).toBeNull();
    const collectors = db
      .query<{ id: string; account: string }, []>(
        `SELECT id, json_extract(executor_json,'$.accountId') AS account FROM workflows
          WHERE json_extract(executor_json,'$.name')='sync_sources' ORDER BY id`,
      )
      .all();
    expect(collectors).toEqual([
      { id: "wf-collect-canvas-default", account: "canvas-default" },
      { id: "wf-mine", account: RENAMED_LEGACY_ID },
    ]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("account/source foreign keys reject cross-source orphans while identical IDs remain isolated", () => {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    migrate(db);
    db.query(
      "INSERT INTO integration_accounts(id,provider,subject,email,label,created_at,updated_at) VALUES ('other','google','sub-other','other@example.test','Other','now','now')",
    ).run();
    db.query("INSERT INTO account_sources(account_id,source) VALUES ('other','gmail')").run();
    const insert = db.query(
      "INSERT INTO sync_items(account_id,source,item_id,title,updated_at) VALUES (?,?,'same-id',?,'now')",
    );
    insert.run("6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6", "gmail", "first");
    insert.run("other", "gmail", "second");
    expect(db.query("SELECT account_id,title FROM sync_items ORDER BY account_id").all()).toEqual([
      { account_id: "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6", title: "first" },
      { account_id: "other", title: "second" },
    ]);
    expect(() => insert.run("other", "calendar", "orphan")).toThrow("FOREIGN KEY");
    expect(() => insert.run("missing", "gmail", "orphan")).toThrow("FOREIGN KEY");
    expect(() => insert.run("other", "gmail", "duplicate")).toThrow("UNIQUE");
  } finally {
    db.close();
  }
});

test("a later v6 failure rolls back new account tables without disturbing the v5 credentials", () => {
  const db = oldDatabase();
  try {
    db.query(
      "INSERT INTO oauth_tokens(provider,payload,updated_at) VALUES ('google','preserved','now')",
    ).run();
    db.exec("CREATE TABLE oauth_states(existing TEXT)");

    expect(() => migrate(db)).toThrow("already exists");

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
    expect(db.query("SELECT payload FROM oauth_tokens").all()).toEqual([{ payload: "preserved" }]);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE name IN ('integration_accounts','account_sources')",
        )
        .all(),
    ).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='integration_state'").all()).toEqual(
      [{ name: "integration_state" }],
    );
  } finally {
    db.close();
  }
});
