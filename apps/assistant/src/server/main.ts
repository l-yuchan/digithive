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
import { settingsRoute, usageRoute } from "./routes/usage";
import { conversationsRoute } from "./routes/conversations";
import { filesRoute } from "./routes/files";
import { memoriesRoute } from "./routes/memories";
import { FileStore } from "../files/store";
import { chatShell } from "../web/views/chat";
import { filesShell } from "../web/views/files";
import { memoryShell } from "../web/views/memory";

export function handler(
  db: Database,
  auth: AuthGate,
  store = new FileStore(db, process.env["ASSISTANT_FILES_ROOT"] ?? "./data/files"),
): (request: Request) => Response | Promise<Response> {
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
      return auth.authenticated(request) ? chatShell() : shell(false);
    }
    if (request.method === "GET" && path === "/files") {
      return auth.authenticated(request) ? filesShell() : shell(false);
    }
    if (request.method === "GET" && path === "/memory") {
      return auth.authenticated(request) ? memoryShell() : shell(false);
    }
    if (request.method === "GET" && (path === "/app.js" || path === "/files.js" || path === "/memory.js" || path === "/styles.css")) {
      const file = Bun.file(resolve(import.meta.dir, "../../dist/public", path.slice(1)));
      if (!(await file.exists())) return Response.json({ error: "not_built" }, { status: 503 });
      return new Response(file, {
        headers: {
          "content-type": path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
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
    if (path === "/api/memories" || path.startsWith("/api/memories/")) {
      return memoriesRoute(db, request, path);
    }
    if (path === "/api/files" || path.startsWith("/api/files/")) {
      return filesRoute(db, store, request, path);
    }
    if (path === "/api/conversations" || path.startsWith("/api/conversations/")) {
      return conversationsRoute(db, request, path);
    }
    if (path === "/api/settings") {
      return settingsRoute(db, request);
    }
    if (path === "/api/usage" && request.method === "GET") {
      return usageRoute(db);
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
