import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AuthGate } from "./auth";

const Scopes = z.array(z.string());

export type Access =
  | { readonly kind: "session" }
  | { readonly kind: "source"; readonly connectionId: string; readonly scope: string }
  | { readonly kind: "tool"; readonly toolId: string; readonly versionId: string }
  | { readonly kind: "external_write" }
  | { readonly kind: "environment_change" };

export function authorized(db: Database, auth: AuthGate, request: Request, access: Access): boolean {
  if (!auth.authenticated(request)) return false;
  switch (access.kind) {
    case "session":
      return true;
    case "source": {
      const row = db.query("SELECT scopes_json FROM connections WHERE id = ?").get(access.connectionId);
      if (!row || typeof row !== "object" || !("scopes_json" in row) || typeof row.scopes_json !== "string") return false;
      let raw: unknown;
      try {
        raw = JSON.parse(row.scopes_json);
      } catch (error) {
        if (error instanceof SyntaxError) return false;
        throw error;
      }
      const parsed = Scopes.safeParse(raw);
      return parsed.success && parsed.data.includes(access.scope);
    }
    case "tool": {
      const row = db.query("SELECT active FROM tool_versions WHERE id = ? AND tool_id = ?").get(access.versionId, access.toolId);
      return Boolean(row && typeof row === "object" && "active" in row && row.active === 1);
    }
    case "external_write":
    case "environment_change":
      return false;
  }
}
