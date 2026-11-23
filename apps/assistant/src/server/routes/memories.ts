import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  addMemory, correctMemory, deleteMemory, listMemories, MemoryError, supersedesOf,
} from "../../knowledge/memory";
import { search } from "../../knowledge/retrieval";
import { contextBlock, toCitations } from "../../knowledge/citations";

const Create = z.object({
  statement: z.string().min(1).max(2_000),
  kind: z.enum(["fact", "preference", "inference", "interest", "commitment"]),
  evidence_ref: z.string().min(1).max(512),
}).strict();

const Correct = z.object({
  revision: z.number().int().positive(),
  correction: z.string().min(1).max(2_000),
}).strict();

const Remove = z.object({ revision: z.number().int().positive() }).strict();

function fail(error: MemoryError): Response {
  const map: Record<MemoryError["kind"], number> = {
    missing: 404, stale_revision: 409, invalid: 422, deleted: 409,
  };
  return Response.json({ error: error.kind }, { status: map[error.kind] });
}

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function memoriesRoute(db: Database, request: Request, path: string): Promise<Response> {
  try {
    if (path === "/api/memories") {
      if (request.method === "GET") {
        const status = new URL(request.url).searchParams.get("status") === "all" ? "all" : "active";
        return Response.json({ memories: listMemories(db, status) });
      }
      if (request.method === "POST") {
        const parsed = Create.safeParse(await body(request));
        if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 422 });
        return Response.json(addMemory(db, {
          statement: parsed.data.statement, kind: parsed.data.kind, evidenceRef: parsed.data.evidence_ref,
        }), { status: 201 });
      }
    }
    if (path === "/api/memories/search" && request.method === "POST") {
      const parsed = z.object({
        query: z.string().min(1).max(200),
        kinds: z.array(z.enum(["fact", "preference", "inference", "interest", "commitment"])).optional(),
      }).safeParse(await body(request));
      if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 422 });
      const found = search(db, {
        query: parsed.data.query,
        ...(parsed.data.kinds === undefined ? {} : { kinds: parsed.data.kinds }),
      });
      return Response.json({ citations: toCitations(found), context: contextBlock(found) });
    }
    const match = /^\/api\/memories\/([^/]+)$/.exec(path);
    if (!match) return Response.json({ error: "not_found" }, { status: 404 });
    const id = match[1];
    if (!id || !z.string().uuid().safeParse(id).success) return Response.json({ error: "invalid_input" }, { status: 422 });
    if (request.method === "PATCH") {
      const parsed = Correct.safeParse(await body(request));
      if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 422 });
      const corrected = correctMemory(db, id, { revision: parsed.data.revision, correction: parsed.data.correction });
      return Response.json({
        memory: corrected, supersedes: supersedesOf(db, corrected.id),
      });
    }
    if (request.method === "DELETE") {
      const parsed = Remove.safeParse(await body(request));
      if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 422 });
      return Response.json(deleteMemory(db, id, { revision: parsed.data.revision }));
    }
    if (request.method === "GET") {
      const found = listMemories(db, "all").find((memory) => memory.id === id);
      if (!found) return Response.json({ error: "missing" }, { status: 404 });
      return Response.json({ memory: found, supersedes: supersedesOf(db, id) });
    }
  } catch (error) {
    if (error instanceof MemoryError) return fail(error);
    throw error;
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}
