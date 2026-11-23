import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "../../src/db/store";
import { FileError, FileStore, normalisePath, resolveBlob } from "../../src/files/store";

const databases: Database[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(): { db: Database; store: FileStore; root: string } {
  const db = new Database(":memory:", { strict: true });
  migrate(db, migrations());
  databases.push(db);
  const root = mkdtempSync(join(tmpdir(), "digithive-files-"));
  roots.push(root);
  return { db, store: new FileStore(db, root), root };
}

test("content round-trips byte for byte and the original is separate from derived text", async () => {
  const { store: files } = store();
  const bytes = new TextEncoder().encode("# 제목\n본문입니다.\n");
  const stored = await files.put({ logicalPath: "tasks/draft.md", mime: "text/markdown", bytes }, 1000);

  assert.equal(stored.file.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(stored.extraction.status, "extracted");
  const read = await files.read(stored.file.id);
  assert.deepEqual(new Uint8Array(read.bytes), bytes);
  assert.equal(await files.derivedText(stored.file.id), "# 제목\n본문입니다.\n");
  assert.deepEqual(files.list().map((file) => file.logicalPath), ["tasks/draft.md"]);
});

test("an unsupported file is stored and downloadable without a fake extraction", async () => {
  const { store: files } = store();
  const stored = await files.put({
    logicalPath: "images/photo.bin", mime: "application/octet-stream",
    bytes: new Uint8Array([0, 1, 2, 3]),
  });
  assert.equal(stored.extraction.status, "unsupported");
  assert.equal(await files.derivedText(stored.file.id), undefined);
  const read = await files.read(stored.file.id);
  assert.equal(read.bytes.byteLength, 4);
});

test("a corrupt PDF records a failure instead of empty success", async () => {
  const { store: files } = store();
  const stored = await files.put({
    logicalPath: "docs/broken.pdf", mime: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.4 not really a pdf"),
  });
  assert.equal(stored.extraction.status, "failed");
  assert.equal(await files.derivedText(stored.file.id), undefined);
});

test("paths that could escape the namespace are refused", async () => {
  const { store: files } = store();
  for (const path of ["../secret.txt", "/etc/passwd", "a/../../b.txt", "C:/windows/win.ini", "a//b.txt", ""]) {
    await assert.rejects(() => files.put({
      logicalPath: path, mime: "text/plain", bytes: new TextEncoder().encode("x"),
    }), FileError);
  }
  assert.throws(() => resolveBlob("/data", "../../etc/passwd"), FileError);
  assert.equal(normalisePath("tasks\\draft.md"), "tasks/draft.md");
});

test("a duplicate logical path and an oversized upload are refused", async () => {
  const { db, store: files, root } = store();
  const small = new FileStore(db, root, 4);
  await files.put({ logicalPath: "notes/a.txt", mime: "text/plain", bytes: new TextEncoder().encode("one") });
  await assert.rejects(() => files.put({
    logicalPath: "notes/a.txt", mime: "text/plain", bytes: new TextEncoder().encode("two"),
  }), FileError);
  await assert.rejects(() => small.put({
    logicalPath: "notes/big.txt", mime: "text/plain", bytes: new TextEncoder().encode("12345"),
  }), FileError);
});

test("deleting a file removes its row and reports blob ownership", async () => {
  const { store: files } = store();
  const stored = await files.put({
    logicalPath: "notes/temp.txt", mime: "text/plain", bytes: new TextEncoder().encode("bye"),
  });
  assert.equal(await files.remove(stored.file.id), true);
  assert.equal(files.list().length, 0);
  assert.equal(await files.remove(stored.file.id), false);
});
