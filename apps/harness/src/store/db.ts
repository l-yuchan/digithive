import { Database, type SQLQueryBindings } from "bun:sqlite";
import { MIGRATIONS } from "./migrations";

export type Db = Database;

/**
 * Opens the SQLite database and applies every pending migration.
 * WAL + foreign keys are set once per connection; busy_timeout keeps a
 * concurrent worker from failing instantly on a short write conflict.
 */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

/**
 * Applies migrations above the recorded `user_version`, in one transaction
 * each. The version is read again inside the transaction: the server and the
 * worker open the same file and can both decide to migrate at startup, and only
 * the one that still sees the old version may run the statements.
 */
export function migrate(db: Database): number {
  const row = db.query<{ user_version: number }, SQLQueryBindings[]>("PRAGMA user_version").get();
  const current = row?.user_version ?? 0;
  let applied = 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const run = db.transaction((): boolean => {
      const inside = db
        .query<{ user_version: number }, SQLQueryBindings[]>("PRAGMA user_version")
        .get();
      if ((inside?.user_version ?? 0) >= migration.version) return false;
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      return true;
    });
    if (run()) applied += 1;
  }
  return applied;
}
