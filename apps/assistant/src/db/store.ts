import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export type Migration = {
  readonly version: number;
  readonly sql: string;
};

export class MigrationError extends Error {
  constructor(readonly version: number, cause: unknown) {
    super(`Migration ${version} failed`, { cause });
    this.name = "MigrationError";
  }
}

export function migrations(): readonly Migration[] {
  const directory = resolve(import.meta.dir, "migrations");
  return readdirSync(directory)
    .filter((name) => /^\d+_[a-z_]+\.sql$/.test(name))
    .sort()
    .map((name) => ({
      version: Number(name.slice(0, name.indexOf("_"))),
      sql: readFileSync(resolve(directory, name), "utf8"),
    }));
}

export function schemaVersion(db: Database): number {
  const version = db.query("SELECT max(version) AS value FROM schema_migrations").get();
  if (!version || typeof version !== "object" || !("value" in version)) {
    throw new MigrationError(0, "Migration table is missing");
  }
  return typeof version.value === "number" ? version.value : 0;
}

export function migrate(db: Database, pending: readonly Migration[]): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  let current = schemaVersion(db);
  for (const migration of pending) {
    if (migration.version <= current) continue;
    if (migration.version !== current + 1) {
      throw new MigrationError(migration.version, "Nonconsecutive migration version");
    }
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
          migration.version,
          new Date().toISOString(),
        );
      }).immediate();
    } catch (error) {
      throw new MigrationError(migration.version, error);
    }
    current = migration.version;
  }
}

export function openDatabase(filename: string): Database {
  const db = new Database(filename, { create: true, strict: true });
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000");
    migrate(db, migrations());
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
