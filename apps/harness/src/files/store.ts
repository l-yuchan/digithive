import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type StoredFile = {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly path: string;
  readonly origin: string;
  readonly createdAt: string;
};

export function storeFile(
  db: Database,
  root: string,
  input: { readonly name: string; readonly mime: string; readonly bytes: Uint8Array; readonly origin?: string; readonly now?: number },
): StoredFile {
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const id = crypto.randomUUID();
  const safeName = input.name.replace(/[^\w.\-가-힣 ]/g, "_").slice(0, 120) || "file";
  const dir = resolve(root, sha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${id}-${safeName}`);
  writeFileSync(path, input.bytes);
  const createdAt = new Date(input.now ?? Date.now()).toISOString();
  db.query("INSERT INTO files (id, name, mime, bytes, sha256, path, origin, created_at) VALUES (?,?,?,?,?,?,?,?)").run(
    id,
    safeName,
    input.mime,
    input.bytes.length,
    sha,
    path,
    input.origin ?? "upload",
    createdAt,
  );
  return { id, name: safeName, mime: input.mime, bytes: input.bytes.length, sha256: sha, path, origin: input.origin ?? "upload", createdAt };
}

export function readStoredFile(db: Database, id: string): { meta: StoredFile; bytes: Uint8Array } | null {
  const row = db.query<{ id: string; name: string; mime: string; bytes: number; sha256: string; path: string; origin: string; created_at: string }, SQLQueryBindings[]>("SELECT id, name, mime, bytes, sha256, path, origin, created_at FROM files WHERE id = ?").get(id);
  if (!row) return null;
  const meta: StoredFile = {
    id: row.id,
    name: row.name,
    mime: row.mime,
    bytes: row.bytes,
    sha256: row.sha256,
    path: row.path,
    origin: row.origin,
    createdAt: row.created_at,
  };
  return { meta, bytes: new Uint8Array(readFileSync(row.path)) };
}

export function listFiles(db: Database, limit = 50): StoredFile[] {
  return (db.query<{ id: string; name: string; mime: string; bytes: number; sha256: string; path: string; origin: string; created_at: string }, SQLQueryBindings[]>("SELECT id, name, mime, bytes, sha256, path, origin, created_at FROM files ORDER BY created_at DESC LIMIT ?").all(limit)).map(
    (row) => ({
      id: (row["id"]),
      name: (row["name"]),
      mime: (row["mime"]),
      bytes: (row["bytes"]),
      sha256: (row["sha256"]),
      path: (row["path"]),
      origin: (row["origin"]),
      createdAt: (row["created_at"]),
    }),
  );
}
