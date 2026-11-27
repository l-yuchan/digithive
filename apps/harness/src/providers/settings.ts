import type { Database } from "bun:sqlite";
import { z } from "zod";

/**
 * What the owner may see about a model route. Provisioning stays in the environment:
 * the API key and any custom headers are never part of this shape, so an authenticated
 * settings response cannot leak a credential.
 */
export type ModelRouteSummary = {
  readonly name: string;
  readonly model: string;
  readonly baseUrl: string;
};

/** The name the primary route has always carried; fallbacks carry their configured name. */
export const PRIMARY_ROUTE_NAME = "primary";

/** The settings row that holds the owner's ordered route names. */
export const MODEL_PRIORITY_KEY = "model.priority";

type NamedRoute = { readonly name: string };

/** A configured route with the fields the settings screen is allowed to see. */
type CatalogRoute = { readonly name: string; readonly model: string; readonly baseUrl: string };

/**
 * The public catalogue in configured order: primary first, then the fallbacks in the
 * order the environment lists them. It is deliberately independent of the saved
 * priority, so a client can show every configured route even when the saved order
 * names fewer of them (for example after a fallback was removed).
 */
export function modelRouteCatalog(config: {
  readonly baseUrl: string;
  readonly model: string;
  readonly fallbackProviders: readonly CatalogRoute[];
}): ModelRouteSummary[] {
  return [
    { name: PRIMARY_ROUTE_NAME, model: config.model, baseUrl: config.baseUrl },
    ...config.fallbackProviders.map((route) => ({
      name: route.name,
      model: route.model,
      baseUrl: route.baseUrl,
    })),
  ];
}

/** Creates the additive settings store. It is not a schema version: no migration runs. */
export function ensureSettingsTable(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
}

/** A route name list that names every configured route exactly once. */
export function isModelPriority(
  priority: readonly string[],
  routes: readonly NamedRoute[],
): boolean {
  if (!Array.isArray(priority)) return false;
  const names = routes.map((route) => route.name);
  if (new Set(names).size !== names.length) return false;
  if (priority.length !== names.length) return false;
  const selected = new Set(priority);
  if (selected.size !== priority.length) return false;
  return names.every((name) => selected.has(name));
}

/**
 * A saved order made to fit the routes this process actually has. Names the owner saved
 * keep their relative order; a route added since is appended in configured order; a
 * route that no longer exists is dropped. An unreadable or stale value therefore never
 * leaves the router without a complete order.
 */
export function normalizeModelPriority(
  saved: readonly string[],
  routes: readonly NamedRoute[],
): string[] {
  const configured = routes.map((route) => route.name);
  const known = new Set(configured);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const name of saved) {
    if (!known.has(name) || seen.has(name)) continue;
    seen.add(name);
    order.push(name);
  }
  for (const name of configured) {
    if (seen.has(name)) continue;
    seen.add(name);
    order.push(name);
  }
  return order;
}

/**
 * The route names in the order the owner chose. Read on every model call: the server
 * and the worker each open the same database, so saving in the web process affects the
 * next call in either process without a restart. A missing value, or one whose stored
 * JSON is malformed, means the configured order; a database error is not hidden.
 */
export function readModelPriority(db: Database, routes: readonly NamedRoute[]): string[] {
  const row = db
    .query<{ value_json: string }, [string]>("SELECT value_json FROM settings WHERE key = ?")
    .get(MODEL_PRIORITY_KEY);
  let saved: string[] = [];
  if (row) {
    try {
      const parsed = z.array(z.string()).safeParse(JSON.parse(row.value_json));
      if (parsed.success) saved = parsed.data;
    } catch {
      // Only the persisted value is untrusted; the table read above still surfaces.
      saved = [];
    }
  }
  return normalizeModelPriority(saved, routes);
}

/**
 * Stores an exact permutation of the configured route names. A caller that sends a
 * missing, extra, duplicated or unknown name is refused rather than saved partially.
 */
export function writeModelPriority(
  db: Database,
  priority: readonly string[],
  routes: readonly NamedRoute[],
): string[] {
  if (!isModelPriority(priority, routes)) throw new Error("invalid_model_priority");
  const order = normalizeModelPriority(priority, routes);
  db.query(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
  ).run(MODEL_PRIORITY_KEY, JSON.stringify(order));
  return order;
}
