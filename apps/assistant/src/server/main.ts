import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase, schemaVersion } from "../db/store";

export function handler(db: Database): (request: Request) => Response {
  return (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      return Response.json({ ok: true, schemaVersion: schemaVersion(db) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

if (import.meta.main) {
  const filename = resolve(process.env["ASSISTANT_DB_PATH"] ?? "./data/assistant.sqlite");
  mkdirSync(dirname(filename), { recursive: true });
  const db = openDatabase(filename);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env["ASSISTANT_PORT"] ?? 4317),
    fetch: handler(db),
  });
  console.log(`Assistant HTTP listening on ${server.hostname}:${server.port}`);
  process.on("SIGINT", () => { server.stop(); db.close(); });
  process.on("SIGTERM", () => { server.stop(); db.close(); });
}
