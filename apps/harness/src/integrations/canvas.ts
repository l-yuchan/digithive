import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";
import type { NormalizedItem, SyncOutcome } from "./normalize";
import { recordOutcome, saveItems } from "./sync-store";

export type CanvasConfig = {
  readonly baseUrl: string;
  readonly token: string;
};

export type CanvasTodoPayload = {
  type?: unknown;
  course_id?: unknown;
  context_name?: unknown;
  html_url?: unknown;
  assignment?: { id?: unknown; name?: unknown; due_at?: unknown; html_url?: unknown; course_id?: unknown };
  quiz?: { id?: unknown; title?: unknown; due_at?: unknown; html_url?: unknown };
};

export function normalizeCanvasTodo(todo: CanvasTodoPayload): NormalizedItem {
  const assignment = todo.assignment;
  const quiz = todo.quiz;
  if (assignment) {
    return {
      id: String(assignment.id ?? ""),
      source: "canvas",
      title: String(assignment.name ?? "(과제)"),
      at: assignment.due_at ? String(assignment.due_at) : null,
      detail: String(todo.context_name ?? `과목 ${String(assignment.course_id ?? todo.course_id ?? "-")}`),
      url: assignment.html_url ? String(assignment.html_url) : todo.html_url ? String(todo.html_url) : null,
    };
  }
  return {
    id: String(quiz?.id ?? ""),
    source: "canvas",
    title: String(quiz?.title ?? "(퀴즈)"),
    at: quiz?.due_at ? String(quiz.due_at) : null,
    detail: String(todo.context_name ?? `과목 ${String(todo.course_id ?? "-")}`),
    url: quiz?.html_url ? String(quiz.html_url) : null,
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
    return await recordOutcome(deps, "canvas", false, 0, null, "canvas_not_configured");
  }
  try {
    const url = new URL("/api/v1/users/self/todo", deps.config.baseUrl.replace(/\/+$/, ""));
    url.searchParams.set("per_page", "100");
    const response = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${deps.config.token}` } });
    if (!response.ok) throw new Error(`canvas_http_${response.status}`);
    const body = (await response.json()) as CanvasTodoPayload[];
    const items = body
      .map(normalizeCanvasTodo)
      .filter((item) => item.id.length > 0)
      .sort((a, b) => (a.at ?? "9999").localeCompare(b.at ?? "9999"));
    saveItems(deps.db, "canvas", items, now);
    return await recordOutcome(deps, "canvas", true, items.length, null, null);
  } catch (error) {
    return await recordOutcome(deps, "canvas", false, 0, null, error instanceof Error ? error.message : "unknown");
  }
}

export function canvasItemsDueSoon(db: Database, from: number, until: number, limit = 20): NormalizedItem[] {
  return (
    db
      .query("SELECT item_id, title, at, detail, url FROM sync_items WHERE source = 'canvas' AND at IS NOT NULL AND at >= ? AND at <= ? ORDER BY at LIMIT ?")
      .all(new Date(from).toISOString(), new Date(until).toISOString(), limit) as Record<string, unknown>[]
  ).map((row) => ({
    id: String(row["item_id"]),
    source: "canvas" as const,
    title: String(row["title"]),
    at: row["at"] === null ? null : String(row["at"]),
    detail: String(row["detail"] ?? ""),
    url: row["url"] === null ? null : String(row["url"]),
  }));
}
