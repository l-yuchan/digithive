import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "../../src/db/store";
import {
  addMemory, contextEpoch, correctMemory, deleteMemory, listMemories, MemoryError, supersedesOf,
} from "../../src/knowledge/memory";
import { interests, search } from "../../src/knowledge/retrieval";
import { contextBlock, toCitations, rejectUnknownCitations } from "../../src/knowledge/citations";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function database(): Database {
  const db = new Database(":memory:", { strict: true });
  migrate(db, migrations());
  databases.push(db);
  return db;
}

test("a correction supersedes the old wording and only the new text is searchable", () => {
  const db = database();
  const original = addMemory(db, {
    statement: "아침에는 길게 설명해줘", kind: "preference", evidenceRef: "conversation:1",
  }, 1000);
  const corrected = correctMemory(db, original.id, { revision: 1, correction: "아침에는 짧게 설명해줘" }, 1001);

  assert.equal(corrected.revision, 2);
  assert.deepEqual(supersedesOf(db, corrected.id), [original.id]);
  assert.deepEqual(listMemories(db).map((memory) => memory.statement), ["아침에는 짧게 설명해줘"]);
  assert.deepEqual(search(db, { query: "길게" }), []);
  assert.equal(search(db, { query: "짧게" })[0]?.id, corrected.id);
  assert.equal(search(db, { query: "짧게" })[0]?.revision, 2);
});

test("a stale revision cannot overwrite a newer correction", () => {
  const db = database();
  const memory = addMemory(db, { statement: "주말에는 알림을 꺼줘", kind: "preference", evidenceRef: "conversation:2" }, 1000);
  correctMemory(db, memory.id, { revision: 1, correction: "주말에는 오전 알림만" }, 1001);
  assert.throws(
    () => correctMemory(db, memory.id, { revision: 1, correction: "다른 수정" }, 1002),
    MemoryError,
  );
  assert.equal(listMemories(db).filter((row) => row.statement === "다른 수정").length, 0);
});

test("a deleted memory leaves active search and audit keeps no body", () => {
  const db = database();
  const memory = addMemory(db, {
    statement: "비밀스러운 예시 문장", kind: "fact", evidenceRef: "conversation:3",
  }, 1000);
  const before = contextEpoch(db);
  const result = deleteMemory(db, memory.id, { revision: 1 }, 1001);

  assert.equal(result.deleted, true);
  assert.equal(result.contextEpoch, before + 1);
  assert.deepEqual(search(db, { query: "비밀스러운" }), []);
  const audit = db.query("SELECT metadata_json FROM audit_log WHERE action = 'memory.delete'").get();
  assert.equal(JSON.stringify(audit).includes("비밀스러운"), false);
});

test("an interest never answers a commitment query", () => {
  const db = database();
  addMemory(db, { statement: "한국사 논문을 읽고 싶다", kind: "interest", evidenceRef: "conversation:4" }, 1000);
  addMemory(db, { statement: "한국사 과제를 12월 1일까지 제출한다", kind: "commitment", evidenceRef: "lms:9" }, 1001);

  assert.equal(interests(db).length, 1);
  assert.deepEqual(search(db, { query: "한국사", kinds: ["commitment"] }).map((row) => row.kind), ["commitment"]);
  assert.deepEqual(search(db, { query: "한국사", kinds: ["interest"] }).map((row) => row.kind), ["interest"]);
});

test("citations only ever name a retrieved record", () => {
  const db = database();
  const memory = addMemory(db, { statement: "회의는 화요일 오후", kind: "fact", evidenceRef: "mail:1" }, 1000);
  const found = search(db, { query: "화요일" });
  const citations = toCitations(found);
  assert.equal(citations[0]?.sourceId, memory.id);
  assert.equal(citations[0]?.revision, 1);
  const filtered = rejectUnknownCitations([
    { sourceId: memory.id, kind: "fact", revision: 1, quote: "회의는 화요일 오후" },
    { sourceId: "invented", kind: "fact", revision: 1, quote: "지어낸 인용" },
  ], found);
  assert.deepEqual(filtered.map((citation) => citation.sourceId), [memory.id]);
  assert.match(contextBlock(found), new RegExp(`\\[memory:${memory.id} rev1\\]`));
});

test("every memory change advances the context epoch", () => {
  const db = database();
  const start = contextEpoch(db);
  const memory = addMemory(db, { statement: "기록 하나", kind: "fact", evidenceRef: "conversation:5" }, 1000);
  assert.equal(contextEpoch(db), start + 1);
  correctMemory(db, memory.id, { revision: 1, correction: "고친 기록" }, 1001);
  assert.equal(contextEpoch(db), start + 2);
});
