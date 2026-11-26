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
 * Applies the kept steps from `version` up, each in its own transaction, oldest first.
 *
 * Two things are measured rather than assumed (Bun 1.4.5, Windows):
 * - while a write transaction is open, a `PRAGMA user_version` read on the same
 *   connection can still return the value chosen before the transaction began, so a
 *   step never re-reads the version inside its own transaction: the version travels
 *   as a parameter, and the recorded value is written after the last step commits.
 * - the `user_version` read only answers through a statement whose result is kept, so
 *   it is asked with `query().get()` and never with `exec`.
 */
/**
 * Applies the kept steps after `version`. Returns the recorded version and how many
 * steps it ran, counted where they run.
 *
 * A database older than the reset also needs the repairs the reset already carries
 * (`session_queue`, `title_source`, `queue_paused`) before v14 and v15 can run; those
 * live in v12, which runs exactly for a database a reset never produced.
 */
function runSteps(
  db: Database,
  version: number,
): { readonly recorded: number; readonly ran: number } {
  let recorded = version;
  let ran = 0;
  const steps = TRANSITIONS;
  for (const transition of steps) {
    if (recorded >= transition.version) continue;
    db.transaction((): void => {
      db.exec(transition.sql);
      transition.run?.(db);
    })();
    recorded = transition.version;
    ran += 1;
  }
  if (recorded !== version) writeVersion(db, recorded);
  return { recorded, ran };
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
  // Every step on a fresh database is one the reset did not do, plus the reset itself.
  return runSteps(db, version).ran;
}
