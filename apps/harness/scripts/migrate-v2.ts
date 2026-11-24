/**
 * v2 → v3 data conversion.
 *
 *   bun scripts/migrate-v2.ts --from <v2.db> [--to <v3.db>] [--dry-run]
 *
 * Reads the v2 database read-only, maps conversations/messages into
 * sessions/entries, and never modifies the source. Re-running is a no-op for
 * conversations that already exist in the target.
 */
import { Database } from "bun:sqlite";
import { openDatabase } from "../src/store/db";

type Args = { from: string; to: string | null; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { from: "", to: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from") out.from = argv[++index] ?? "";
    else if (arg === "--to") out.to = argv[++index] ?? null;
    else if (arg === "--dry-run") out.dryRun = true;
  }
  if (!out.from) throw new Error("--from <v2.db> is required");
  return out;
}

function tables(db: Database): Set<string> {
  return new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
}

export type MigrationReport = {
  readonly conversations: number;
  readonly entries: number;
  readonly skipped: number;
  readonly memories: number;
  readonly files: number;
  readonly dryRun: boolean;
};

export function migrateV2(fromPath: string, toDb: Database, dryRun: boolean): MigrationReport {
  const source = new Database(fromPath, { readonly: true });
  const sourceTables = tables(source);
  if (!sourceTables.has("conversations") || !sourceTables.has("messages")) {
    source.close();
    throw new Error("source database has no conversations/messages tables");
  }

  const conversations = source
    .query("SELECT id, title, created_at FROM conversations ORDER BY created_at")
    .all() as { id: string; title: string; created_at: string }[];

  let created = 0;
  let entries = 0;
  let skipped = 0;

  const insertSession = toDb.query(
    "INSERT INTO sessions (id, title, created_at, updated_at, metadata_json) VALUES (?,?,?,?,?)",
  );
  const updateSession = toDb.query("UPDATE sessions SET updated_at = ?, leaf_id = ? WHERE id = ?");
  const insertEntry = toDb.query(
    "INSERT INTO entries (id, session_id, parent_id, kind, role, status, payload_json, created_at, seq) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  const insertFts = toDb.query("INSERT INTO entries_fts (entry_id, session_id, text) VALUES (?,?,?)");

  const run = toDb.transaction(() => {
    for (const conversation of conversations) {
      const exists = toDb.query("SELECT id FROM sessions WHERE id = ?").get(conversation.id);
      if (exists) {
        skipped += 1;
        continue;
      }
      if (!dryRun) {
        insertSession.run(
          conversation.id,
          conversation.title || "이전 대화",
          conversation.created_at,
          conversation.created_at,
          JSON.stringify({ v2: true, v2ConversationId: conversation.id }),
        );
      }
      created += 1;

      const messages = source
        .query("SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid")
        .all(conversation.id) as { id: string; role: string; content: string; created_at: string }[];
      let parent: string | null = null;
      let seq = 0;
      for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        seq += 1;
        const entryId = crypto.randomUUID();
        if (!dryRun) {
          insertEntry.run(
            entryId,
            conversation.id,
            parent,
            "message",
            message.role,
            "complete",
            JSON.stringify({ parts: [{ type: "text", text: message.content }] }),
            message.created_at,
            seq,
          );
          if (message.content.trim().length >= 3) insertFts.run(entryId, conversation.id, message.content.trim());
        }
        parent = entryId;
        entries += 1;
      }
      if (!dryRun) updateSession.run(conversation.created_at, parent, conversation.id);
    }
  });
  run();

  let memories = 0;
  const alreadyMigrated = (toDb.query("SELECT count(*) AS n FROM memories").get() as { n: number }).n > 0;
  if (sourceTables.has("memories") && !dryRun && !alreadyMigrated) {
    const cols = new Set((source.query("PRAGMA table_info(memories)").all() as { name: string }[]).map((row) => row.name));
    if (cols.has("kind") && cols.has("text") && cols.has("created_at")) {
      const rows = source.query("SELECT kind, text, created_at FROM memories").all() as { kind: string; text: string; created_at: string }[];
      for (const row of rows) {
        toDb.query("INSERT INTO memories (id, kind, text, source_json, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(
          crypto.randomUUID(),
          row.kind,
          row.text,
          JSON.stringify({ v2: true }),
          row.created_at,
          row.created_at,
        );
        memories += 1;
      }
    }
  }

  let files = 0;
  const filesMigrated = (toDb.query("SELECT count(*) AS n FROM files WHERE origin = 'v2'").get() as { n: number }).n > 0;
  if (sourceTables.has("files") && !dryRun && !filesMigrated) {
    const cols = new Set((source.query("PRAGMA table_info(files)").all() as { name: string }[]).map((row) => row.name));
    if (cols.has("name") && cols.has("path")) {
      const rows = source.query("SELECT name, path, mime, bytes, sha256, created_at FROM files").all() as {
        name: string;
        path: string;
        mime: string | null;
        bytes: number | null;
        sha256: string | null;
        created_at: string;
      }[];
      for (const row of rows) {
        toDb.query("INSERT INTO files (id, name, mime, bytes, sha256, path, origin, created_at) VALUES (?,?,?,?,?,?,?,?)").run(
          crypto.randomUUID(),
          row.name,
          row.mime ?? "application/octet-stream",
          row.bytes ?? 0,
          row.sha256 ?? "",
          row.path,
          "v2",
          row.created_at,
        );
        files += 1;
      }
    }
  }

  source.close();
  return { conversations: created, entries, skipped, memories, files, dryRun };
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  const target = args.to ? openDatabase(args.to) : openDatabase(":memory:");
  const report = migrateV2(args.from, target, args.dryRun);
  console.log(JSON.stringify(report));
  if (!args.dryRun) {
    const counts = target.query("SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM entries) AS entries").get() as {
      sessions: number;
      entries: number;
    };
    console.log(JSON.stringify({ target: args.to ?? ":memory:", ...counts }));
  }
  target.close();
}
