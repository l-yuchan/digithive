import type { Database } from "bun:sqlite";
import { z } from "zod";
import { unlinkSync } from "node:fs";
import { listMemories, remember, correctMemory, MEMORY_KINDS } from "../knowledge/memory";
import { listFiles, storeFile, readStoredFile } from "../files/store";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const text = z.string().trim().min(1).max(4000);

export async function handleKnowledgeRequest(
  request: Request,
  deps: {
    readonly db: Database;
    readonly filesRoot: string;
    readonly maxUploadBytes: number;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/memories") {
    if (request.method === "GET")
      return json({
        memories: listMemories(deps.db, url.searchParams.get("includeSuperseded") === "1"),
      });
    if (request.method === "POST") {
      const parsed = z
        .object({ kind: z.enum(MEMORY_KINDS), text })
        .safeParse(await request.json().catch(() => null));
      if (!parsed.success)
        return json({ error: "invalid_memory", issues: parsed.error.issues }, 422);
      return json(remember(deps.db, { ...parsed.data, source: { origin: "user" } }), 201);
    }
  }
  const memory = /^\/api\/memories\/([^/]+)\/correct$/.exec(path);
  if (memory && request.method === "POST") {
    const parsed = z.object({ text }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid_memory", issues: parsed.error.issues }, 422);
    const result = correctMemory(deps.db, { id: memory[1] ?? "", text: parsed.data.text });
    return result ? json(result) : json({ error: "memory_not_found" }, 404);
  }
  if (path === "/api/files") {
    if (request.method === "GET")
      return json({ files: listFiles(deps.db).map(({ path: _path, ...file }) => file) });
    if (request.method === "POST") {
      const limit = deps.maxUploadBytes;
      if (Number(request.headers.get("content-length")) > limit)
        return json({ error: "file_too_large", limit }, 413);
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (request.body) {
        const reader = request.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > limit) {
              await reader.cancel();
              return json({ error: "file_too_large", limit }, 413);
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const name = url.searchParams.get("name")?.trim();
      if (!name || size === 0) return json({ error: "invalid_file" }, 422);
      const stored = storeFile(deps.db, deps.filesRoot, {
        name,
        mime: request.headers.get("content-type") ?? "application/octet-stream",
        bytes: Buffer.concat(chunks),
      });
      const { path: _path, ...file } = stored;
      return json(file, 201);
    }
  }
  const file = /^\/api\/files\/([^/]+)(\/content)?$/.exec(path);
  if (file) {
    const id = file[1] ?? "";
    if (request.method === "GET" && file[2]) {
      const stored = readStoredFile(deps.db, id);
      if (!stored) return json({ error: "file_not_found" }, 404);
      return new Response(new Uint8Array(stored.bytes), {
        headers: {
          "content-type": stored.meta.mime,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(stored.meta.name)}`,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      });
    }
    if (request.method === "DELETE" && !file[2]) {
      const stored = readStoredFile(deps.db, id);
      if (!stored) return json({ error: "file_not_found" }, 404);
      unlinkSync(stored.meta.path);
      deps.db.query("DELETE FROM files WHERE id = ?").run(id);
      return json({ deleted: true });
    }
  }
  return null;
}
