import type { Database } from "bun:sqlite";
import { z } from "zod";
import { dedupeKey, extractFromAssignment, extractFromMail, retractByEvidence, storeCandidate, supersedeEvidence } from "./candidates";

const Version = z.object({
  version_id: z.string(),
  item_id: z.string(),
  remote_id: z.string(),
  content_json: z.string(),
  observed_at: z.string(),
});

/**
 * Walks every stored source version that has not been considered yet and turns
 * mail text and LMS assignment versions into candidate tasks, meetings or
 * deadline changes. A withdrawn version (tombstone) retracts the candidates it
 * produced. Re-running is idempotent because candidates are keyed by kind and
 * normalised content.
 */
export function extractCandidates(db: Database, now = () => Date.now()): { created: number; retracted: number } {
  const rows = z.array(Version).parse(db.query(`SELECT v.id AS version_id, v.source_item_id AS item_id,
      i.remote_id, v.content_json, v.observed_at
    FROM source_versions v JOIN source_items i ON i.id = v.source_item_id
    WHERE v.tombstone = 0 AND v.id = i.current_version_id`).all());
  let created = 0;
  let retracted = 0;
  const processed = new Set(
    z.array(z.object({ source_version_id: z.string().nullable() })).parse(
      db.query("SELECT source_version_id FROM candidates").all(),
    ).map((row) => row.source_version_id).filter((value): value is string => value !== null),
  );

  for (const row of rows) {
    const content = JSON.parse(row.content_json) as Record<string, unknown>;
    if (row.remote_id.startsWith("assignment:")) {
      const parsed = z.object({
        kind: z.string().optional(),
        content: z.object({
          id: z.number().optional(), course_id: z.number().optional(), name: z.string(),
          due_at: z.string().nullable().optional(),
        }),
      }).safeParse(content);
      if (!parsed.success) continue;
      const assignment = parsed.data.content;
      const previous = previousDue(db, row.item_id, row.observed_at);
      if (previous !== undefined && previous === (assignment.due_at ?? null)) {
        // Same value observed again: keep the existing candidate and its state.
        continue;
      }
      const keys: string[] = [];
      for (const proposal of extractFromAssignment({
        courseId: assignment.course_id ?? 0,
        assignmentId: assignment.id ?? 0,
        name: assignment.name,
        dueAt: assignment.due_at ?? null,
        previousDueAt: previous,
      })) {
        keys.push(dedupeKey(proposal));
        if (storeCandidate(db, proposal, row.version_id, now()).inserted) created += 1;
      }
      supersedeEvidence(db, `lms:${assignment.course_id ?? 0}:${assignment.id ?? 0}`, keys);
      continue;
    }
    if (row.remote_id.startsWith("gmail:")) {
      const parsed = z.object({
        mail: z.object({ subject: z.string(), from: z.string(), text: z.string() }).optional(),
        message: z.object({ id: z.string() }).optional(),
      }).safeParse(content);
      if (!parsed.success || !parsed.data.mail) continue;
      const messageId = parsed.data.message?.id ?? row.remote_id;
      const keys: string[] = [];
      for (const proposal of extractFromMail({
        subject: parsed.data.mail.subject,
        from: parsed.data.mail.from,
        text: parsed.data.mail.text,
        messageId,
      }, now())) {
        keys.push(dedupeKey(proposal));
        if (storeCandidate(db, proposal, row.version_id, now()).inserted) created += 1;
      }
      supersedeEvidence(db, `gmail:${messageId}`, keys);
    }
  }

  const withdrawn = z.array(z.object({ remote_id: z.string() })).parse(db.query(`SELECT i.remote_id
    FROM source_items i JOIN source_versions v ON v.id = i.current_version_id WHERE v.tombstone = 1`).all());
  for (const item of withdrawn) {
    retracted += retractByEvidence(db, item.remote_id.startsWith("gmail:") ? item.remote_id : `lms:${item.remote_id}`);
  }
  void processed;
  return { created, retracted };
}

function previousDue(db: Database, itemId: string, observedAt: string): string | null | undefined {
  const row = db.query(`SELECT content_json FROM source_versions
    WHERE source_item_id = ? AND observed_at < ? ORDER BY observed_at DESC LIMIT 1`).get(itemId, observedAt);
  const parsed = z.object({ content_json: z.string() }).safeParse(row);
  if (!parsed.success) return undefined;
  const content = z.object({ content: z.object({ due_at: z.string().nullable().optional() }).optional() })
    .safeParse(JSON.parse(parsed.data.content_json));
  if (!content.success || !content.data.content) return undefined;
  return content.data.content.due_at ?? null;
}
