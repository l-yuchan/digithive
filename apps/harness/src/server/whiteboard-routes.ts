import { z } from "zod";
import type { WhiteboardStore } from "../whiteboard/types";
import {
  WhiteboardConflictError,
  WhiteboardError,
  WhiteboardNotFoundError,
  WhiteboardPathError,
} from "../whiteboard/types";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const userStatuses = ["active", "open", "in_progress", "done", "cancelled", "archived"] as const;
const writeSchema = z
  .object({
    path: z.string().min(1).max(512),
    kind: z.enum(["thread", "commitment"]),
    title: z.string().trim().min(1).max(200),
    text: z.string().max(180_000),
    status: z.enum(userStatuses).optional(),
  })
  .strict();
const updateSchema = z
  .object({
    text: z.string().max(180_000).optional(),
    status: z.enum(userStatuses).optional(),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function failure(error: unknown): Response {
  if (error instanceof WhiteboardConflictError)
    return json({ error: "stale_hash", actualHash: error.actualHash }, 409);
  if (error instanceof WhiteboardNotFoundError) return json({ error: "document_not_found" }, 404);
  if (error instanceof WhiteboardPathError) return json({ error: error.code }, 422);
  if (error instanceof WhiteboardError)
    return json({ error: error.code }, error.code === "path_exists" ? 409 : 422);
  if (error instanceof z.ZodError) return json({ error: "invalid_document" }, 422);
  throw error;
}

function documentId(raw: string): string {
  try {
    return z.string().min(1).max(200).parse(decodeURIComponent(raw));
  } catch (error) {
    if (error instanceof URIError) throw new WhiteboardPathError("invalid_document_id");
    throw error;
  }
}

/** HTTP access to the same canonical documents the agent tools read and write. */
export async function handleWhiteboardRequest(
  request: Request,
  deps: { readonly whiteboard: WhiteboardStore },
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/whiteboard") {
    try {
      if (request.method === "GET") {
        const input = z
          .object({
            query: z.string().max(500).optional(),
            kind: z.enum(["record", "thread", "commitment", "watch"]).optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          })
          .parse({
            query: url.searchParams.get("query") ?? undefined,
            kind: url.searchParams.get("kind") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
          });
        return json({
          documents: deps.whiteboard.list({
            limit: input.limit,
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
          }),
        });
      }
      if (request.method === "POST") {
        const parsed = writeSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: "invalid_document" }, 422);
        const document = deps.whiteboard.write({
          path: parsed.data.path,
          kind: parsed.data.kind,
          title: parsed.data.title,
          text: parsed.data.text,
          ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
          source: { type: "user", id: "http" },
        });
        return json({ document }, 201);
      }
      return json({ error: "method_not_allowed" }, 405);
    } catch (error) {
      return failure(error);
    }
  }
  const match = /^\/api\/whiteboard\/([^/]+)$/.exec(path);
  if (!match) return null;
  try {
    const id = documentId(match[1] ?? "");
    const current = deps.whiteboard.read(id);
    if (!current) return json({ error: "document_not_found" }, 404);
    if (request.method === "GET") return json({ document: current });
    if (request.method !== "PATCH") return json({ error: "method_not_allowed" }, 405);
    const owner = current.source["type"];
    if (owner !== "user" && owner !== "agent") {
      return json({ error: "operational_document_read_only" }, 409);
    }
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid_document_update" }, 422);
    const document = deps.whiteboard.update({
      id,
      expectedHash: parsed.data.expectedHash,
      ...(parsed.data.text === undefined ? {} : { text: parsed.data.text }),
      ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
    });
    return json({ document });
  } catch (error) {
    return failure(error);
  }
}
