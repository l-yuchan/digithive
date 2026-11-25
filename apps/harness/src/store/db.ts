import { Database, type SQLQueryBindings } from "bun:sqlite";
import { RESET_SCHEMA, RESET_VERSION, TRANSITIONS } from "./migrations";

/**
 * The oldest recorded version this build opens: the last version of the retired
 * chain (v10), whose schema the reset reproduces. Anything older would need steps
 * the two-transition rule no longer keeps.
 */
export const OLDEST_OPENABLE = RESET_VERSION - 1;

/**
 * Opens the SQLite database and applies every pending transition.
 * WAL + foreign keys are set once per connection; busy_timeout keeps a
 * concurrent worker from failing instantly on a short write conflict.
 */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  const current = userVersion(db);
  if (current > 0 && current < OLDEST_OPENABLE) {
    db.close();
    throw new Error(
      `database schema v${current} is older than this build supports (v${OLDEST_OPENABLE}); upgrade it with the build that shipped it`,
    );
  }
  migrate(db);
  return db;
}

function userVersion(db: Database): number {
  return (
    db.query<{ user_version: number }, SQLQueryBindings[]>("PRAGMA user_version").get()
      ?.user_version ?? 0
  );
}

/** One statement, nothing queued after it: the form whose result is kept. */
function writeVersion(db: Database, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * Runs the kept steps from `version` up, each in its own transaction, oldest first.
 *
 * Two things are measured rather than assumed (Bun 1.4.5, Windows):
 * - while a write transaction is open, a `PRAGMA user_version` read on the same
 *   connection can still return the value chosen before the transaction began, so a
 *   step never re-reads the version inside its own transaction: the version travels
 *   as a parameter, and the recorded value is written after the last step commits.
 * - `db.transaction(fn)` does not reliably pass the callback value back, so whether
 *   a step ran is decided by the caller and reported from here.
 */
function runSteps(db: Database, version: number): number {
  let recorded = version;
  for (const transition of TRANSITIONS) {
    if (recorded >= transition.version) continue;
    const run = db.transaction((): void => {
      db.exec(transition.sql);
      transition.run?.(db);
    });
    run();
    recorded = transition.version;
  }
  if (recorded !== version) writeVersion(db, recorded);
  return recorded;
}

/**
 * A new database gets the reset schema and is then stepped through the kept
 * transitions, so both kinds of database end up at the same shape; an existing one
 * is stepped from its recorded version. Returns how many steps this call ran.
 *
 * A database between the old chain's last version (v10) and the reset (v11) carries
 * that schema already and only needs the kept transitions.
 */
export function migrate(db: Database): number {
  const before = userVersion(db);
  let version: number;
  if (before === 0) {
    db.exec(RESET_SCHEMA);
    version = RESET_VERSION;
  } else {
    version = before;
  }
  const after = runSteps(db, version);
  // Every step on a fresh database is one the reset did not do, plus the reset itself.
  return before === 0 ? after - RESET_VERSION : after - before;
}
