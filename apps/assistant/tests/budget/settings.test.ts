import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "../../src/db/store";
import { readSettings, SettingsError, writeSettings, PROPOSED_THRESHOLDS } from "../../src/server/routes/settings";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function database(): Database {
  const db = new Database(":memory:", { strict: true });
  migrate(db, migrations());
  databases.push(db);
  return db;
}

test("an update with a stale revision is refused and the stored revision advances once", () => {
  const db = database();
  const initial = readSettings(db);
  const saved = writeSettings(db, { ...initial, monthlyLimitMicroUsd: 50_000_000 }, "user", 1000);
  assert.equal(saved.revision, 2);
  assert.throws(() => writeSettings(db, { ...initial, monthlyLimitMicroUsd: 10_000_000 }, "user", 1001), SettingsError);
  assert.equal(readSettings(db).monthlyLimitMicroUsd, 50_000_000);
  assert.equal(readSettings(db).revision, 2);
});

test("automation cannot be enabled before the user confirms the settings", () => {
  const db = database();
  const initial = readSettings(db);
  assert.equal(initial.automationEnabled, false);
  assert.equal(initial.confirmedByUser, false);
  assert.equal(initial.proposeThresholds, PROPOSED_THRESHOLDS);
  assert.throws(() => writeSettings(db, { ...initial, automationEnabled: true }, "user", 1000), SettingsError);
  const confirmed = writeSettings(db, { ...initial, confirmedByUser: true, automationEnabled: true }, "user", 1001);
  assert.equal(confirmed.automationEnabled, true);
  assert.equal(confirmed.revision, 2);
});

test("a settings payload cannot carry a secret value", () => {
  const db = database();
  const initial = readSettings(db);
  assert.throws(() => writeSettings(db, { ...initial, secret: "plaintext" }, "user", 1000), SettingsError);
});
