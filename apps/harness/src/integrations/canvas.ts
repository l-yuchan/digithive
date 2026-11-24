import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import type { NormalizedItem, SyncOutcome } from "./normalize";
import { recordOutcome, saveItems } from "./sync-store";
import { z } from "zod";

export type CanvasConfig = {
  readonly baseUrl: string;
  readonly token: string;
};

const CanvasTodoSchema = z.object({
  type: z.string().optional(),
  course_id: z.union([z.string(), z.number()]).optional(),
  context_name: z.string().nullish(),
  html_url: z.string().nullish(),
  assignment: z.object({
    id: z.union([z.string(), z.number()]).optional(), name: z.string().nullish(),
    due_at: z.string().nullish(), html_url: z.string().nullish(),
    course_id: z.union([z.string(), z.number()]).optional(),
  }).optional(),
  quiz: z.object({
    id: z.union([z.string(), z.number()]).optional(), title: z.string().nullish(),
    due_at: z.string().nullish(), html_url: z.string().nullish(),
  }).optional(),
});
export type CanvasTodoPayload = z.infer<typeof CanvasTodoSchema>;

export function normalizeCanvasTodo(raw: unknown): NormalizedItem {
  const todo = CanvasTodoSchema.parse(raw);
  const assignment = todo.assignment;
  const quiz = todo.quiz;
  if (assignment) {
    return {
      id: String(assignment.id ?? ""),
      source: "canvas",
      title: (assignment.name ?? "(과제)"),
      at: assignment.due_at ? (assignment.due_at) : null,
      detail: (todo.context_name ?? `과목 ${String(assignment.course_id ?? todo.course_id ?? "-")}`),
      url: assignment.html_url ? (assignment.html_url) : todo.html_url ? (todo.html_url) : null,
    };
  }
  return {
    id: String(quiz?.id ?? ""),
    source: "canvas",
    title: (quiz?.title ?? "(퀴즈)"),
    at: quiz?.due_at ? (quiz.due_at) : null,
    detail: (todo.context_name ?? `과목 ${String(todo.course_id ?? "-")}`),
    url: quiz?.html_url ? (quiz.html_url) : null,
  };
}

export type CanvasDeps = {
  readonly db: Database;
  readonly events: EventLog;
  readonly config: CanvasConfig;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
};

/**
 * Collects the LMS todo list (assignments and quizzes with due dates) and
 * orders it by due time. A missing token or a failing response is a visible
 * failure, never an empty success.
 */
export async function syncCanvas(deps: CanvasDeps): Promise<SyncOutcome> {
  const now = (deps.now ?? Date.now)();
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (deps.config.baseUrl.trim().length === 0 || deps.config.token.trim().length === 0) {
    return recordOutcome(deps, "canvas", false, 0, null, "canvas_not_configured");
  }
  try {
    const url = new URL("/api/v1/users/self/todo", deps.config.baseUrl.replace(/\/+$/, ""));
    url.searchParams.set("per_page", "100");
    const response = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${deps.config.token}` } });
    if (!response.ok) throw new Error(`canvas_http_${response.status}`);
    const body = z.array(CanvasTodoSchema).parse(await response.json());
    const items = body
      .map(normalizeCanvasTodo)
      .filter((item) => item.id.length > 0)
      .toSorted((a, b) => (a.at ?? "9999").localeCompare(b.at ?? "9999"));
    saveItems(deps.db, "canvas", items, now);
    return recordOutcome(deps, "canvas", true, items.length, null, null);
  } catch (error) {
    return recordOutcome(deps, "canvas", false, 0, null, error instanceof Error ? error.message : "unknown");
  }
}

export function canvasItemsDueSoon(db: Database, from: number, until: number, limit = 20): NormalizedItem[] {
  return (
    db
      .query<{ item_id: string; title: string; at: string | null; detail: string | null; url: string | null }, SQLQueryBindings[]>("SELECT item_id, title, at, detail, url FROM sync_items WHERE source = 'canvas' AND at IS NOT NULL AND at >= ? AND at <= ? ORDER BY at LIMIT ?")
      .all(new Date(from).toISOString(), new Date(until).toISOString(), limit)
  ).map((row) => ({
    id: (row["item_id"]),
    source: "canvas" as const,
    title: (row["title"]),
    at: row["at"] === null ? null : (row["at"]),
    detail: (row["detail"] ?? ""),
    url: row["url"] === null ? null : (row["url"]),
  }));
}
