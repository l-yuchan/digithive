import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { migrate, migrations } from "../../src/db/store";
import {
  dedupeKey, extractFromAssignment, extractFromMail, listCandidates, retractByEvidence, storeCandidate,
} from "../../src/knowledge/candidates";
import { extractCandidates } from "../../src/knowledge/extract-candidates";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function database(): Database {
  const db = new Database(":memory:", { strict: true });
  migrate(db, migrations());
  databases.push(db);
  db.query("INSERT INTO connections (id,provider,scopes_json) VALUES ('src','gmail','[]')").run();
  return db;
}

function addVersion(db: Database, remoteId: string, content: unknown, observedAt: string): string {
  const itemId = crypto.randomUUID();
  db.query("INSERT INTO source_items (id,connection_id,remote_id,observed_at) VALUES (?,?,?,?)")
    .run(itemId, "src", remoteId, observedAt);
  const versionId = crypto.randomUUID();
  db.query(`INSERT INTO source_versions (id,source_item_id,content_hash,content_json,tombstone,observed_at)
    VALUES (?,?,?,?,0,?)`)
    .run(versionId, itemId, createHash("sha256").update(JSON.stringify(content)).digest("hex"),
      JSON.stringify(content), observedAt);
  db.query("UPDATE source_items SET current_version_id = ? WHERE id = ?").run(versionId, itemId);
  return itemId;
}

test("a mail with a deadline and a request becomes a task with its evidence", () => {
  const proposals = extractFromMail({
    subject: "과제 제출 안내",
    from: "교수 <prof@example.com>",
    text: "12월 1일까지 보고서를 제출하세요. 김교수님 확인 부탁드립니다.",
    messageId: "m1",
  }, Date.parse("2026-11-01T00:00:00Z"));
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.kind, "task");
  assert.equal(proposals[0]?.dueAt, "2026-12-01T23:59:00+09:00");
  assert.equal(proposals[0]?.confidence, "confirmed");
  assert.equal(proposals[0]?.evidence, "gmail:m1");
  assert.deepEqual(proposals[0]?.people, ["김교수님"]);
});

test("a vague meeting stays tentative and never becomes a confirmed promise", () => {
  const proposals = extractFromMail({
    subject: "다음 주에 만나요",
    from: "팀장 <lead@example.com>",
    text: "다음 주쯤 회의 한번 하면 좋겠습니다. 아마 3시쯤 가능할 것 같아요.",
    messageId: "m2",
  }, Date.parse("2026-11-01T00:00:00Z"));
  const meeting = proposals.find((proposal) => proposal.kind === "schedule");
  assert.ok(meeting);
  assert.equal(meeting.confidence, "tentative");
  assert.equal(meeting.startsAt, null);
});

test("an LMS deadline change keeps the previous value and links both", () => {
  const db = database();
  const first = extractFromAssignment({
    courseId: 101, assignmentId: 7, name: "중간 보고서", dueAt: "2026-11-20T14:59:00Z", previousDueAt: undefined,
  });
  assert.equal(first[0]?.kind, "task");
  const changed = extractFromAssignment({
    courseId: 101, assignmentId: 7, name: "중간 보고서", dueAt: "2026-11-15T14:59:00Z", previousDueAt: "2026-11-20T14:59:00Z",
  });
  assert.equal(changed[0]?.kind, "deadline_change");
  assert.equal(changed[0]?.previousDueAt, "2026-11-20T14:59:00Z");
  const stored = storeCandidate(db, changed[0]!, "version-2", 1000).candidate;
  assert.equal(stored.status, "proposed");
  assert.equal(z.object({ previous_json: z.string() }).parse(
    db.query("SELECT previous_json FROM candidates WHERE id = ?").get(stored.id),
  ).previous_json.includes("2026-11-20"), true);
});

test("re-observing the same content creates no duplicate candidate", () => {
  const db = database();
  addVersion(db, "gmail:m3", {
    mail: { subject: "과제", from: "교수", text: "12월 1일까지 제출" },
    message: { id: "m3" },
  }, "2026-11-01T00:00:00Z");
  const first = extractCandidates(db, () => Date.parse("2026-11-01T01:00:00Z"));
  const second = extractCandidates(db, () => Date.parse("2026-11-01T02:00:00Z"));
  assert.equal(first.created >= 1, true);
  assert.equal(second.created, 0);
  assert.equal(listCandidates(db).length, 1);
});

test("a withdrawn source retracts its candidate instead of leaving a stale promise", () => {
  const db = database();
  addVersion(db, "gmail:m4", {
    mail: { subject: "과제", from: "교수", text: "12월 1일까지 제출" },
    message: { id: "m4" },
  }, "2026-11-01T00:00:00Z");
  extractCandidates(db, () => Date.parse("2026-11-01T01:00:00Z"));
  const retracted = retractByEvidence(db, "gmail:m4", Date.parse("2026-11-02T00:00:00Z"));
  assert.equal(retracted, 1);
  assert.deepEqual(listCandidates(db).map((candidate) => candidate.status), ["retracted"]);
});

test("the dedupe key ignores case and whitespace in the subject but not the date", () => {
  const base = {
    kind: "task" as const, subject: "  중간 보고서 ", dueAt: "2026-11-20T14:59:00Z", startsAt: null,
    place: null, people: [], confidence: "confirmed" as const, evidence: "lms:1",
  };
  assert.equal(dedupeKey(base), dedupeKey({ ...base, subject: "중간 보고서" }));
  assert.notEqual(dedupeKey(base), dedupeKey({ ...base, dueAt: "2026-11-15T14:59:00Z" }));
});
