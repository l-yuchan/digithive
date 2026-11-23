import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CanvasCliError, isCourseAllowed, runCanvasCli, type CanvasConfig, type CliSpawn } from "./canvas-cli";

const Assignment = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable().optional(),
  due_at: z.string().nullable().optional(),
  html_url: z.string().optional(),
  course_id: z.number().optional(),
  submission_types: z.array(z.string()).optional(),
  has_submitted_submissions: z.boolean().optional(),
});

const Announcement = z.object({
  id: z.number(), title: z.string(), message: z.string().optional(),
  posted_at: z.string().optional(), html_url: z.string().optional(),
});

const Course = z.object({ id: z.number(), name: z.string(), course_code: z.string().optional() });

export type CanvasSource = { readonly connectionId: string; readonly courseIds: readonly number[] };

export type Collected = {
  readonly kind: "assignment" | "announcement" | "course";
  readonly remoteId: string;
  readonly content: unknown;
};

function assertAllowed(config: CanvasConfig, courseId: number): void {
  if (!isCourseAllowed(config, courseId)) throw new CanvasCliError("forbidden");
}

export async function collectCourse(
  config: CanvasConfig, courseId: number, spawn?: CliSpawn,
): Promise<readonly Collected[]> {
  assertAllowed(config, courseId);
  const assignmentsPath = `/api/v1/courses/${courseId}/assignments?per_page=100`;
  const raw = await runCanvasCli(config, assignmentsPath, spawn === undefined ? {} : { spawn });
  const assignments = z.array(Assignment).safeParse(raw);
  if (!assignments.success) throw new CanvasCliError("invalid_json");
  const items: Collected[] = [];
  for (const assignment of assignments.data) {
    if (assignment.course_id !== undefined && assignment.course_id !== courseId) continue;
    items.push({ kind: "assignment", remoteId: `assignment:${courseId}:${assignment.id}`, content: assignment });
  }
  return items;
}

export async function collectAnnouncements(
  config: CanvasConfig, courseId: number, spawn?: CliSpawn,
): Promise<readonly Collected[]> {
  assertAllowed(config, courseId);
  const raw = await runCanvasCli(config, `/api/v1/courses/${courseId}/discussion_topics?only_announcements=true&per_page=100`, spawn === undefined ? {} : { spawn });
  const announcements = z.array(Announcement).safeParse(raw);
  if (!announcements.success) throw new CanvasCliError("invalid_json");
  return announcements.data.map((announcement) => ({
    kind: "announcement" as const,
    remoteId: `announcement:${courseId}:${announcement.id}`,
    content: announcement,
  }));
}

export async function collectCourses(config: CanvasConfig, spawn?: CliSpawn): Promise<readonly Collected[]> {
  const raw = await runCanvasCli(config, "/api/v1/courses?enrollment_state=active&per_page=100", spawn === undefined ? {} : { spawn });
  const courses = z.array(Course).safeParse(raw);
  if (!courses.success) throw new CanvasCliError("invalid_json");
  return courses.data
    .filter((course) => isCourseAllowed(config, course.id))
    .map((course) => ({ kind: "course" as const, remoteId: `course:${course.id}`, content: course }));
}

function hash(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/**
 * A list is only trustworthy when the whole call succeeded. A missing item is
 * turned into a tombstone only after a complete list, so a permission error or
 * a partial read can never look like "the course was deleted".
 */
export async function syncCanvas(
  db: Database, config: CanvasConfig, source: CanvasSource, now = () => Date.now(), spawn?: CliSpawn,
): Promise<{ stored: number; tombstoned: number }> {
  const collected: Collected[] = [...await collectCourses(config, spawn)];
  for (const courseId of source.courseIds) {
    if (!source.courseIds.includes(courseId)) continue;
    collected.push(...await collectCourse(config, courseId, spawn));
    collected.push(...await collectAnnouncements(config, courseId, spawn));
  }
  return db.transaction(() => {
    let stored = 0;
    let tombstoned = 0;
    const seen = new Set<string>();
    for (const item of collected) {
      seen.add(item.remoteId);
      const contentHash = hash(item.content);
      const existing = db.query(
        "SELECT id,current_version_id FROM source_items WHERE connection_id = ? AND remote_id = ?",
      ).get(source.connectionId, item.remoteId);
      const parsed = z.object({ id: z.string(), current_version_id: z.string().nullable() }).safeParse(existing);
      const itemId = parsed.success ? parsed.data.id : crypto.randomUUID();
      if (!parsed.success) {
        db.query("INSERT INTO source_items (id,connection_id,remote_id,observed_at) VALUES (?,?,?,?)")
          .run(itemId, source.connectionId, item.remoteId, new Date(now()).toISOString());
      }
      const version = db.query("SELECT id FROM source_versions WHERE source_item_id = ? AND content_hash = ?")
        .get(itemId, contentHash);
      if (!z.object({ id: z.string() }).safeParse(version).success) {
        const versionId = crypto.randomUUID();
        db.query(`INSERT INTO source_versions (id,source_item_id,content_hash,content_json,tombstone,observed_at)
          VALUES (?,?,?,?,0,?)`)
          .run(versionId, itemId, contentHash, JSON.stringify({ kind: item.kind, content: item.content }),
            new Date(now()).toISOString());
        db.query("UPDATE source_items SET current_version_id = ? WHERE id = ?").run(versionId, itemId);
        stored += 1;
      }
    }
    for (const courseId of source.courseIds) {
      const missing = db.query(`SELECT i.id, i.remote_id FROM source_items i
        WHERE i.connection_id = ? AND i.remote_id LIKE ?`).all(source.connectionId, `assignment:${courseId}:%`)
        .map((row) => z.object({ id: z.string(), remote_id: z.string() }).parse(row))
        .filter((row) => !seen.has(row.remote_id));
      for (const row of missing) {
        db.query("UPDATE source_versions SET tombstone = 1 WHERE source_item_id = ?").run(row.id);
        tombstoned += 1;
      }
    }
    db.query("UPDATE connections SET sync_status = 'synced', last_success_at = ? WHERE id = ?")
      .run(new Date(now()).toISOString(), source.connectionId);
    return { stored, tombstoned };
  }).immediate();
}

export function markCanvasStale(db: Database, connectionId: string): void {
  db.query("UPDATE connections SET sync_status = 'stale' WHERE id = ?").run(connectionId);
}
