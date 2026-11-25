import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/store/db";

/**
 * Applies the pending migrations to a *copy* of a database and reports what the
 * conversion did, so a live snapshot can be checked before the server boots on it.
 *
 *   bun scripts/qa-workflow-migration.ts --db data/qa/v9-snapshot.db
 */
function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function count(db: Database, sql: string): number {
  return db.query<{ n: number }, []>(sql).get()?.n ?? 0;
}

const source = argValue("--db");
if (!source || !existsSync(source)) {
  console.error("usage: bun scripts/qa-workflow-migration.ts --db <database file>");
  process.exit(2);
}

const workdir = mkdtempSync(join(tmpdir(), "workflow-migration-"));
const target = join(workdir, "copy.db");
copyFileSync(source, target);

const db = new Database(target);
db.exec("PRAGMA foreign_keys=ON");
const tables = db
  .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((row) => row.name);
if (!tables.includes("schedules") || !tables.includes("runs")) {
  console.error(`not a harness database (no schedules/runs table): ${source}`);
  db.close();
  rmSync(workdir, { recursive: true, force: true });
  process.exit(2);
}
const before = {
  version: db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0,
  schedules: count(db, "SELECT count(*) AS n FROM schedules"),
  runs: count(db, "SELECT count(*) AS n FROM runs"),
  occurrences: count(db, "SELECT count(*) AS n FROM schedule_occurrences"),
};
const applied = migrate(db);
const after = {
  version: db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0,
  workflows: count(db, "SELECT count(*) AS n FROM workflows"),
  schedules: count(db, "SELECT count(*) AS n FROM schedules"),
  orphanBindings: count(db, "SELECT count(*) AS n FROM schedules WHERE workflow_id IS NULL"),
  runsWithWorkflow: count(db, "SELECT count(*) AS n FROM runs WHERE workflow_id IS NOT NULL"),
  ftsRows: count(db, "SELECT count(*) AS n FROM workflows_fts"),
  unmatched: count(
    db,
    `SELECT count(*) AS n FROM schedules s
      WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.id = s.workflow_id)`,
  ),
  fkErrors: db.query("PRAGMA foreign_key_check").all().length,
};
db.close();
rmSync(workdir, { recursive: true, force: true });

const mismatch =
  after.unmatched +
  after.orphanBindings +
  after.fkErrors +
  (after.workflows === before.schedules ? 0 : 1);
console.log(
  JSON.stringify(
    { source, applied, before, after, mismatch, ok: mismatch === 0 && after.version === 10 },
    null,
    2,
  ),
);
process.exit(mismatch === 0 && after.version === 10 ? 0 : 1);
