import { Database, type SQLQueryBindings } from "bun:sqlite";
import { RESET_SCHEMA, RESET_VERSION, TRANSITIONS } from "./migrations";

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
  if (current > 0 && current < RESET_VERSION) {
    db.close();
    throw new Error(
      `database schema v${current} is older than this build supports (v${RESET_VERSION}); upgrade it with the build that shipped it`,
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

/**
 * A new database gets the reset schema; an existing one gets every transition above
 * its recorded `user_version`, one transaction each. The version is read again
 * inside the transaction: the server and the worker open the same file and can both
 * decide to migrate at startup, and only the one that still sees the old version
 * may run the step. A database ahead of this build applies nothing.
 */
export function migrate(db: Database): number {
  let applied = 0;
  if (userVersion(db) === 0) {
    const reset = db.transaction((): boolean => {
      if (userVersion(db) !== 0) return false;
      db.exec(RESET_SCHEMA);
      db.exec(`PRAGMA user_version = ${RESET_VERSION}`);
      return true;
    });
    if (reset()) applied += 1;
  }
  for (const transition of TRANSITIONS) {
    const run = db.transaction((): boolean => {
      if (userVersion(db) >= transition.version) return false;
      db.exec(transition.sql);
      transition.run?.(db);
      db.exec(`PRAGMA user_version = ${transition.version}`);
      return true;
    });
    if (run()) applied += 1;
  }
  return applied;
}
