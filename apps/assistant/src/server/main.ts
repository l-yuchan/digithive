import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase, schemaVersion } from "../db/store";
import { loadServerConfig } from "../contracts/config";
import { AuthGate } from "./auth";
import { SecretVault } from "./secrets";
import { sessionRoute, shell } from "./routes/session";
import { authorized } from "./policy";
import { runsRoute } from "./routes/runs";

export function handler(db: Database, auth: AuthGate): (request: Request) => Response | Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      return Response.json({ ok: true, schemaVersion: schemaVersion(db) });
    }
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (!auth.sameOrigin(request, mutation)) {
      return Response.json({ error: "origin_rejected" }, { status: 403 });
    }
    if (request.method === "GET" && path === "/") {
      return shell(auth.authenticated(request));
    }
    if (path === "/api/session") {
      return sessionRoute(request, auth);
    }
    if (path.startsWith("/api/") && !authorized(db, auth, request, { kind: "session" })) {
      return Response.json({ error: "authentication_required" }, { status: 401 });
    }
    if (path === "/api/runs" || path.startsWith("/api/runs/")) {
      return runsRoute(db, request, path);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

if (import.meta.main) {
  const config = loadServerConfig();
  new SecretVault(config.encryptionKey);
  const filename = resolve(process.env["ASSISTANT_DB_PATH"] ?? "./data/assistant.sqlite");
  mkdirSync(dirname(filename), { recursive: true });
  const db = openDatabase(filename);
  const auth = new AuthGate(db, config);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env["ASSISTANT_PORT"] ?? 4317),
    fetch: handler(db, auth),
  });
  console.log(`Assistant HTTP listening on ${server.hostname}:${server.port}`);
  process.on("SIGINT", () => { server.stop(); db.close(); });
  process.on("SIGTERM", () => { server.stop(); db.close(); });
}
