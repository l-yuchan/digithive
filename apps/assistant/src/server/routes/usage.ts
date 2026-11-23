import type { Database } from "bun:sqlite";
import { usageView, writeSettings, SettingsError, readSettings } from "./settings";

export async function settingsRoute(db: Database, request: Request): Promise<Response> {
  if (request.method === "GET") {
    const { settings } = usageView(db);
    return Response.json(settings);
  }
  if (request.method === "PUT") {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return Response.json({ error: "invalid_input" }, { status: 422 });
    }
    if (raw === null || typeof raw !== "object" || Object.hasOwn(raw, "secret")) {
      return Response.json({ error: "invalid_input" }, { status: 422 });
    }
    try {
      return Response.json(writeSettings(db, raw, "user"));
    } catch (error) {
      if (error instanceof SettingsError) {
        const status = error.kind === "stale_revision" ? 409 : 422;
        return Response.json({ error: error.kind }, { status });
      }
      throw error;
    }
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

export function usageRoute(db: Database): Response {
  const view = usageView(db);
  return Response.json({
    ...view.usage,
    priceVersions: db.query("SELECT DISTINCT price_version FROM cost_reservations ORDER BY price_version")
      .all().map((row) => (row && typeof row === "object" && "price_version" in row ? row.price_version : null)),
    proposals: readSettings(db).proposeThresholds,
  });
}
