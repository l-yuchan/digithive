import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { extractCandidates } from "../../src/knowledge/extract-candidates";
import { listCandidates } from "../../src/knowledge/candidates";

type CandidateContext = {
  readonly db: Database;
  readonly evidence: string;
};

function addVersion(db: Database, connectionId: string, remoteId: string, content: unknown, observedAt: string, tombstone = 0): string {
  const existing = db.query("SELECT id FROM source_items WHERE connection_id = ? AND remote_id = ?")
    .get(connectionId, remoteId);
  const parsed = z.object({ id: z.string() }).safeParse(existing);
  const itemId = parsed.success ? parsed.data.id : crypto.randomUUID();
  if (!parsed.success) {
    db.query("INSERT INTO source_items (id,connection_id,remote_id,observed_at) VALUES (?,?,?,?)")
      .run(itemId, connectionId, remoteId, observedAt);
  }
  const versionId = crypto.randomUUID();
  db.query(`INSERT INTO source_versions (id,source_item_id,content_hash,content_json,tombstone,observed_at)
    VALUES (?,?,?,?,?,?)`)
    .run(versionId, itemId, createHash("sha256").update(JSON.stringify(content) + observedAt).digest("hex"),
      JSON.stringify(content), tombstone, observedAt);
  db.query("UPDATE source_items SET current_version_id = ? WHERE id = ?").run(versionId, itemId);
  return versionId;
}

function seed(context: CandidateContext): void {
  context.db.query("INSERT INTO connections (id,provider,scopes_json) VALUES ('gmail','gmail','[]')").run();
  context.db.query("INSERT INTO connections (id,provider,scopes_json) VALUES ('lms','canvas','[]')").run();
  addVersion(context.db, "gmail", "gmail:m-100", {
    mail: {
      subject: "기말 보고서 제출 안내",
      from: "김교수 <prof@example.com>",
      text: "12월 5일까지 기말 보고서를 제출하세요. 김교수님 확인 부탁드립니다.",
    },
    message: { id: "m-100" },
  }, "2026-11-10T00:00:00Z");
  addVersion(context.db, "gmail", "gmail:m-101", {
    mail: {
      subject: "다음 주에 만나요",
      from: "팀장 <lead@example.com>",
      text: "다음 주쯤 회의 한번 하면 좋겠습니다. 아마 3시쯤 가능할 것 같아요.",
    },
    message: { id: "m-101" },
  }, "2026-11-10T01:00:00Z");
  addVersion(context.db, "lms", "assignment:101:7", {
    kind: "assignment",
    content: { id: 7, course_id: 101, name: "중간 보고서", due_at: "2026-11-20T14:59:00Z" },
  }, "2026-11-10T02:00:00Z");
  addVersion(context.db, "lms", "assignment:101:7", {
    kind: "assignment",
    content: { id: 7, course_id: 101, name: "중간 보고서", due_at: "2026-11-15T14:59:00Z" },
  }, "2026-11-11T02:00:00Z");
}

export async function candidateMailLms(context: CandidateContext): Promise<void> {
  seed(context);
  const first = extractCandidates(context.db, () => Date.parse("2026-11-12T00:00:00Z"));
  const second = extractCandidates(context.db, () => Date.parse("2026-11-12T01:00:00Z"));
  const candidates = listCandidates(context.db);

  const task = candidates.find((candidate) => candidate.evidence === "gmail:m-100");
  assert.ok(task);
  assert.equal(task.kind, "task");
  assert.equal(task.dueAt, "2026-12-05T23:59:00+09:00");
  assert.equal(task.confidence, "confirmed");

  const meeting = candidates.find((candidate) => candidate.evidence === "gmail:m-101");
  assert.ok(meeting);
  assert.equal(meeting.kind, "schedule");
  assert.equal(meeting.confidence, "tentative");
  assert.equal(meeting.startsAt, null, "a vague meeting must not get a confirmed time");

  const change = candidates.find((candidate) => candidate.kind === "deadline_change");
  assert.ok(change);
  assert.equal(change.previousDueAt, "2026-11-20T14:59:00Z");
  assert.equal(change.dueAt, "2026-11-15T14:59:00Z");
  assert.equal(second.created, 0, "re-extraction must not duplicate candidates");

  await writeFile(join(context.evidence, "candidates.json"), `${JSON.stringify({
    firstCreated: first.created, secondCreated: second.created, total: candidates.length,
    candidates: candidates.map((candidate) => ({
      kind: candidate.kind, subject: candidate.subject, dueAt: candidate.dueAt, startsAt: candidate.startsAt,
      confidence: candidate.confidence, evidence: candidate.evidence, previousDueAt: candidate.previousDueAt ?? null,
      status: candidate.status,
    })),
  }, null, 2)}\n`);
}

export async function candidateDedupeStale(context: CandidateContext): Promise<void> {
  seed(context);
  extractCandidates(context.db, () => Date.parse("2026-11-12T00:00:00Z"));
  const beforeRepeat = listCandidates(context.db);
  assert.equal(beforeRepeat.filter((candidate) => candidate.status === "proposed" && candidate.dueAt === "2026-11-20T14:59:00Z").length, 0,
    "the earlier due date must not stay current");

  // The same content observed again (new version, same values) must not add a row.
  addVersion(context.db, "lms", "assignment:101:7", {
    kind: "assignment",
    content: { id: 7, course_id: 101, name: "중간 보고서", due_at: "2026-11-15T14:59:00Z" },
  }, "2026-11-12T02:00:00Z");
  const repeat = extractCandidates(context.db, () => Date.parse("2026-11-12T03:00:00Z"));
  assert.equal(repeat.created, 0);
  assert.equal(listCandidates(context.db).length, beforeRepeat.length);

  // A withdrawn mail retracts the promise it produced.
  addVersion(context.db, "gmail", "gmail:m-100", {
    mail: { subject: "기말 보고서 제출 안내", from: "김교수 <prof@example.com>", text: "회수된 안내" },
    message: { id: "m-100" },
  }, "2026-11-12T04:00:00Z", 1);
  const withdrawal = extractCandidates(context.db, () => Date.parse("2026-11-12T05:00:00Z"));
  const afterWithdrawal = listCandidates(context.db);
  const mailCandidate = afterWithdrawal.find((candidate) => candidate.evidence === "gmail:m-100");
  const lmsCandidate = afterWithdrawal.find((candidate) => candidate.evidence.startsWith("lms:"));
  assert.equal(mailCandidate?.status, "retracted");
  assert.equal(lmsCandidate?.status, "proposed", "an unrelated source keeps its candidate");

  await writeFile(join(context.evidence, "evidence-diff.json"), `${JSON.stringify({
    candidatesBeforeRepeat: beforeRepeat.length, createdOnRepeat: repeat.created,
    withdrawalRetractions: withdrawal.retracted,
    mailStatus: mailCandidate?.status, lmsStatus: lmsCandidate?.status,
    duplicateRows: 0,
  }, null, 2)}\n`);
}
