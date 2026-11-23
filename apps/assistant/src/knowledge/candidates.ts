import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";

export type CandidateKind = "task" | "schedule" | "deadline_change";
export type Confidence = "confirmed" | "tentative";

export type Proposal = {
  readonly kind: CandidateKind;
  readonly subject: string;
  readonly dueAt: string | null;
  readonly startsAt: string | null;
  readonly place: string | null;
  readonly people: readonly string[];
  readonly confidence: Confidence;
  readonly evidence: string;
  readonly previousDueAt?: string | null;
};

export type StoredCandidate = Proposal & {
  readonly id: string;
  readonly status: "proposed" | "superseded" | "retracted";
  readonly dedupeKey: string;
};

const TENTATIVE = /(쯤|정도|아마|될 ?것|가능하면|언젠가|다음 ?주에)/;

function dateFromKorean(text: string, nowMs: number): string | null {
  const monthDay = /(\d{1,2})월\s*(\d{1,2})일/.exec(text);
  const year = new Date(nowMs).getUTCFullYear();
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T23:59:00+09:00`;
    }
  }
  const iso = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(text);
  if (iso) return `${iso[1]}T${iso[2]}:00+09:00`;
  return null;
}

function timeFromKorean(text: string): string | null {
  const match = /(\d{1,2})\s*시/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  return hour >= 0 && hour <= 23 ? String(hour).padStart(2, "0") : null;
}

export function dedupeKey(proposal: Proposal): string {
  return createHash("sha256").update(JSON.stringify({
    kind: proposal.kind, subject: proposal.subject.trim().toLowerCase(),
    dueAt: proposal.dueAt, startsAt: proposal.startsAt,
  })).digest("hex");
}

export function extractFromMail(input: {
  readonly subject: string;
  readonly from: string;
  readonly text: string;
  readonly messageId: string;
}, nowMs = Date.now()): readonly Proposal[] {
  const body = `${input.subject}\n${input.text}`;
  const proposals: Proposal[] = [];
  const due = dateFromKorean(body, nowMs);
  const tentative = TENTATIVE.test(body);
  const asksForWork = /(제출|과제|보고서|정리해|작성|준비|확인해|알려줘|부탁)/.test(body);
  const meeting = /(회의|미팅|면담|만나|모임|약속)/.test(body);
  const people = [...body.matchAll(/([가-힣]{2,4})\s*(교수님|선생님|팀장님|님)/g)]
    .map((match) => `${match[1]}${match[2]}`);
  const place = /([가-힣A-Za-z0-9]+(?:관|동|호|실|룸))\s*(?:에서|으로)/.exec(body)?.[1] ?? null;

  if (due !== null && asksForWork) {
    proposals.push({
      kind: "task", subject: input.subject || "(제목 없음)", dueAt: due, startsAt: null, place: null,
      people, confidence: tentative ? "tentative" : "confirmed",
      evidence: `gmail:${input.messageId}`,
    });
  }
  if (meeting) {
    const hour = timeFromKorean(body);
    const day = due?.slice(0, 10);
    proposals.push({
      kind: "schedule", subject: input.subject || "(제목 없음)", dueAt: null,
      startsAt: day && hour ? `${day}T${hour}:00:00+09:00` : day ? `${day}T00:00:00+09:00` : null,
      place, people, confidence: tentative || (!day && !hour) ? "tentative" : "confirmed",
      evidence: `gmail:${input.messageId}`,
    });
  }
  return proposals;
}

export function extractFromAssignment(input: {
  readonly courseId: number;
  readonly assignmentId: number;
  readonly name: string;
  readonly dueAt: string | null;
  readonly previousDueAt: string | null | undefined;
}): readonly Proposal[] {
  const evidence = `lms:${input.courseId}:${input.assignmentId}`;
  if (input.dueAt === null) return [];
  if (input.previousDueAt === undefined || input.previousDueAt === input.dueAt) {
    return [{
      kind: "task", subject: input.name, dueAt: input.dueAt, startsAt: null, place: null, people: [],
      confidence: "confirmed", evidence,
    }];
  }
  if (input.previousDueAt === null) return [];
  return [{
    kind: "deadline_change", subject: input.name, dueAt: input.dueAt, startsAt: null, place: null, people: [],
    confidence: "confirmed", evidence, previousDueAt: input.previousDueAt,
  }];
}

const Row = z.object({
  id: z.string(), kind: z.enum(["task", "schedule", "deadline_change"]), status: z.enum(["proposed", "superseded", "retracted"]),
  dedupe_key: z.string().nullable(), evidence_json: z.string(), previous_json: z.string().nullable(),
});

export function storeCandidate(
  db: Database, proposal: Proposal, sourceVersionId: string, now = Date.now(),
): { readonly candidate: StoredCandidate; readonly inserted: boolean } {
  const key = dedupeKey(proposal);
  const existing = db.query("SELECT id,kind,status,dedupe_key,evidence_json,previous_json FROM candidates WHERE dedupe_key = ?").get(key);
  const parsed = Row.safeParse(existing);
  if (parsed.success) {
    const stored: StoredCandidate = {
      ...proposal, id: parsed.data.id, status: parsed.data.status as StoredCandidate["status"], dedupeKey: key,
    };
    return { candidate: stored, inserted: false };
  }
  const id = crypto.randomUUID();
  const previous = proposal.previousDueAt === undefined ? null : JSON.stringify({ dueAt: proposal.previousDueAt });
  db.query(`INSERT INTO candidates
    (id,source_version_id,kind,status,proposed_at,timezone,evidence_json,dedupe_key,confidence,previous_json)
    VALUES (?,?,?, 'proposed', ?, 'Asia/Seoul', ?, ?, ?, ?)`)
    .run(id, sourceVersionId, proposal.kind, new Date(now).toISOString(), JSON.stringify(proposal), key,
      proposal.confidence, previous);
  return { candidate: { ...proposal, id, status: "proposed", dedupeKey: key }, inserted: true };
}

/** A later version of the same source supersedes the earlier candidate instead
 * of adding a second row, and records the previous value so a briefing can show
 * "기존 → 변경" with evidence. */
export function supersedeCandidate(
  db: Database, previousKey: string, proposal: Proposal, sourceVersionId: string, now = Date.now(),
): StoredCandidate {
  db.query("UPDATE candidates SET status = 'superseded' WHERE dedupe_key = ?").run(previousKey);
  const id = crypto.randomUUID();
  db.query(`INSERT INTO candidates
    (id,source_version_id,kind,status,proposed_at,timezone,evidence_json,dedupe_key,confidence,previous_json)
    VALUES (?,?,?, 'proposed', ?, 'Asia/Seoul', ?, ?, ?, ?)`)
    .run(id, sourceVersionId, proposal.kind, new Date(now).toISOString(), JSON.stringify(proposal), dedupeKey(proposal),
      proposal.confidence, JSON.stringify({ superseded: previousKey }));
  return { ...proposal, id, status: "proposed", dedupeKey: dedupeKey(proposal) };
}

/** Earlier proposed candidates for the same evidence stop being current when the
 * source value changed, so a briefing never shows two live due dates. */
export function supersedeEvidence(db: Database, evidence: string, keepKeys: readonly string[]): number {
  const keep = keepKeys.length === 0 ? [""] : keepKeys;
  const placeholders = keep.map(() => "?").join(",");
  const result = db.query(`UPDATE candidates SET status = 'superseded'
    WHERE evidence_json LIKE ? AND status = 'proposed' AND dedupe_key NOT IN (${placeholders})`)
    .run(`%"evidence":"${evidence}"%`, ...keep);
  return result.changes;
}

export function retractByEvidence(db: Database, evidence: string, now = Date.now()): number {
  const result = db.query("UPDATE candidates SET status = 'retracted', retracted_at = ? WHERE evidence_json LIKE ? AND status = 'proposed'")
    .run(new Date(now).toISOString(), `%"evidence":"${evidence}"%`);
  return result.changes;
}

export function listCandidates(db: Database): readonly StoredCandidate[] {
  return db.query("SELECT id,kind,status,dedupe_key,evidence_json,previous_json FROM candidates ORDER BY proposed_at DESC")
    .all()
    .map((row) => {
      const parsed = Row.parse(row);
      const proposal = JSON.parse(parsed.evidence_json) as Proposal;
      return { ...proposal, id: parsed.id, status: parsed.status, dedupeKey: parsed.dedupe_key ?? "" };
    });
}
