/**
 * Builds a small v2-shaped database for exercising `migrate-v2.ts` without
 * touching a real v2 installation. QA fixture only.
 */
import { Database } from "bun:sqlite";

const path = Bun.argv[2];
if (!path) {
  console.error("usage: bun scripts/qa-make-v2-fixture.ts <path.db>");
  process.exit(2);
}

const db = new Database(path, { create: true });
db.exec(`
CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE memories (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE files (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT, bytes INTEGER, sha256 TEXT, path TEXT NOT NULL, created_at TEXT NOT NULL);
`);

db.query("INSERT INTO conversations (id,title,created_at) VALUES (?,?,?)").run(
  "c-1",
  "회의 준비",
  "2026-11-20T01:00:00.000Z",
);
db.query(
  "INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)",
).run("m-1", "c-1", "user", "내일 회의 준비물을 정리해줘", "2026-11-20T01:00:00.000Z");
db.query(
  "INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)",
).run("m-2", "c-1", "assistant", "준비물은 노트북과 자료입니다.", "2026-11-20T01:00:05.000Z");

db.query("INSERT INTO conversations (id,title,created_at) VALUES (?,?,?)").run(
  "c-2",
  "주간 보고",
  "2026-11-21T02:00:00.000Z",
);
db.query(
  "INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)",
).run("m-3", "c-2", "user", "주간 보고 초안을 써줘", "2026-11-21T02:00:00.000Z");
db.query(
  "INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)",
).run("m-4", "c-2", "assistant", "이번 주 진행 상황을 정리했습니다.", "2026-11-21T02:00:09.000Z");

db.query("INSERT INTO memories (id,kind,text,created_at) VALUES (?,?,?,?)").run(
  "mem-1",
  "interest",
  "회의는 오전 선호",
  "2026-11-19T00:00:00.000Z",
);
db.query(
  "INSERT INTO files (id,name,mime,bytes,sha256,path,created_at) VALUES (?,?,?,?,?,?,?)",
).run("f-1", "준비물.txt", "text/plain", 12, "abc", "/tmp/준비물.txt", "2026-11-19T00:00:00.000Z");

console.log(JSON.stringify({ path, conversations: 2, messages: 4, memories: 1, files: 1 }));
db.close();
