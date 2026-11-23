import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { extractText, type ExtractionResult } from "./extract";

export class FileError extends Error {
  constructor(readonly kind: "too_large" | "unsupported_mime" | "escape" | "exists" | "missing" | "invalid_path") {
    super(kind);
    this.name = "FileError";
  }
}

export type FileRecord = {
  readonly id: string;
  readonly logicalPath: string;
  readonly sha256: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
};

const ALLOWED_MIME = new Set([
  "text/plain", "text/markdown", "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/octet-stream",
]);

/** Normalises a user-supplied logical path and refuses anything that could
 * escape the logical namespace or collide with a reserved segment. */
export function normalisePath(input: string): string {
  const trimmed = input.trim().replace(/\\/g, "/");
  if (trimmed === "" || trimmed.length > 512 || trimmed.startsWith("/")) throw new FileError("invalid_path");
  const parts = trimmed.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || part.includes("\u0000") || /^[a-z]+:/i.test(part)) {
      throw new FileError("invalid_path");
    }
  }
  return parts.join("/");
}

export function resolveBlob(root: string, sha256: string): string {
  const blobs = resolve(root, "blobs");
  const target = resolve(blobs, sha256.slice(0, 2), sha256);
  const rel = relative(blobs, target);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) throw new FileError("escape");
  return target;
}

export class FileStore {
  constructor(
    private readonly db: Database,
    readonly root: string,
    private readonly maxBytes = 25 * 1024 * 1024,
  ) {}

  async put(input: {
    readonly logicalPath: string;
    readonly mime: string;
    readonly bytes: Uint8Array;
    readonly ownerRunId?: string;
  }, now = Date.now()): Promise<{ file: FileRecord; extraction: ExtractionResult; blobPath: string }> {
    if (input.bytes.byteLength > this.maxBytes) throw new FileError("too_large");
    const mime = input.mime.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ALLOWED_MIME.has(mime)) throw new FileError("unsupported_mime");
    const logicalPath = normalisePath(input.logicalPath);
    const existing = this.db.query("SELECT id FROM files WHERE logical_path = ?").get(logicalPath);
    if (existing) throw new FileError("exists");

    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const blobPath = resolveBlob(this.root, sha256);
    await mkdir(dirname(blobPath), { recursive: true });
    const temporary = `${blobPath}.tmp-${crypto.randomUUID()}`;
    await writeFile(temporary, input.bytes);
    await rename(temporary, blobPath);

    const id = crypto.randomUUID();
    const createdAt = new Date(now).toISOString();
    const extraction = await extractText(input.bytes, mime);
    this.db.transaction(() => {
      this.db.query(`INSERT INTO files (id,logical_path,owner_run_id,sha256,mime,size_bytes,blob_ref,created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, logicalPath, input.ownerRunId ?? null, sha256, mime, input.bytes.byteLength, sha256, createdAt);
      this.db.query(`INSERT INTO file_derivations (id,file_id,kind,status,derived_blob_ref,error_code)
        VALUES (?,?,?,?,?,?)`)
        .run(crypto.randomUUID(), id, "text", extraction.status,
          extraction.status === "extracted" ? `${sha256}.txt` : null,
          extraction.status === "failed" ? extraction.errorCode : null);
    }).immediate();
    if (extraction.status === "extracted") {
      await mkdir(join(this.root, "derived"), { recursive: true });
      await writeFile(join(this.root, "derived", `${sha256}.txt`), extraction.text);
    }
    return { file: { id, logicalPath, sha256, mime, sizeBytes: input.bytes.byteLength, createdAt }, extraction, blobPath };
  }

  list(): readonly FileRecord[] {
    return this.db.query("SELECT id,logical_path,sha256,mime,size_bytes,created_at FROM files ORDER BY created_at DESC")
      .all()
      .map((row) => z.object({
        id: z.string(), logical_path: z.string(), sha256: z.string(), mime: z.string(),
        size_bytes: z.number(), created_at: z.string(),
      }).parse(row))
      .map((row) => ({
        id: row.id, logicalPath: row.logical_path, sha256: row.sha256, mime: row.mime,
        sizeBytes: row.size_bytes, createdAt: row.created_at,
      }));
  }

  async read(id: string): Promise<{ bytes: Uint8Array; file: FileRecord }> {
    const row = this.db.query("SELECT id,logical_path,sha256,mime,size_bytes,created_at FROM files WHERE id = ?").get(id);
    if (!row) throw new FileError("missing");
    const parsed = z.object({
      id: z.string(), logical_path: z.string(), sha256: z.string(), mime: z.string(),
      size_bytes: z.number(), created_at: z.string(),
    }).parse(row);
    const blobPath = resolveBlob(this.root, parsed.sha256);
    const info = await stat(blobPath).catch(() => undefined);
    if (!info?.isFile()) throw new FileError("missing");
    return {
      bytes: await readFile(blobPath),
      file: {
        id: parsed.id, logicalPath: parsed.logical_path, sha256: parsed.sha256,
        mime: parsed.mime, sizeBytes: parsed.size_bytes, createdAt: parsed.created_at,
      },
    };
  }

  async derivedText(id: string): Promise<string | undefined> {
    const row = this.db.query("SELECT derived_blob_ref FROM file_derivations WHERE file_id = ? AND kind = 'text'").get(id);
    if (!row) return undefined;
    const parsed = z.object({ derived_blob_ref: z.string().nullable() }).parse(row);
    if (!parsed.derived_blob_ref) return undefined;
    return Bun.file(join(this.root, "derived", parsed.derived_blob_ref)).text();
  }

  async remove(id: string): Promise<boolean> {
    this.db.query("DELETE FROM file_derivations WHERE file_id = ?").run(id);
    const files = this.db.query("DELETE FROM files WHERE id = ?").run(id);
    return files.changes !== 0;
  }
}

export async function removeBlobIfUnused(db: Database, sha256: string, root: string): Promise<boolean> {
  const count = z.object({ count: z.number() }).parse(
    db.query("SELECT count(*) AS count FROM files WHERE sha256 = ?").get(sha256),
  ).count;
  if (count > 0) return false;
  await rm(resolveBlob(root, sha256), { force: true });
  await rm(join(root, "derived", `${sha256}.txt`), { force: true });
  return true;
}
