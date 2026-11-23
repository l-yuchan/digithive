import type { Database } from "bun:sqlite";
import { z } from "zod";
import { FileError, removeBlobIfUnused, type FileStore } from "../../files/store";

const MAX_BYTES = 25 * 1024 * 1024;

function status(error: FileError): Response {
  const map: Record<FileError["kind"], number> = {
    too_large: 413, unsupported_mime: 415, exists: 409, escape: 403, invalid_path: 422, missing: 404,
  };
  return Response.json({ error: error.kind }, { status: map[error.kind] });
}

export async function filesRoute(
  db: Database, store: FileStore, request: Request, path: string,
): Promise<Response> {
  try {
    if (path === "/api/files" && request.method === "GET") {
      return Response.json({ files: store.list() });
    }
    if (path === "/api/files" && request.method === "POST") {
      const form = await request.formData();
      const upload = form.get("file");
      if (!(upload instanceof File)) return Response.json({ error: "invalid_input" }, { status: 422 });
      if (upload.size > MAX_BYTES) return Response.json({ error: "too_large" }, { status: 413 });
      const logical = typeof form.get("path") === "string" ? String(form.get("path")) : upload.name;
      const stored = await store.put({
        logicalPath: logical,
        mime: upload.type || "application/octet-stream",
        bytes: new Uint8Array(await upload.arrayBuffer()),
      });
      return Response.json({
        file: stored.file, extraction: stored.extraction.status,
      }, { status: 201 });
    }
    const match = /^\/api\/files\/([^/]+)(\/content|\/text)?$/.exec(path);
    if (!match) return Response.json({ error: "not_found" }, { status: 404 });
    const id = match[1];
    if (!id || !z.string().uuid().safeParse(id).success) return Response.json({ error: "invalid_input" }, { status: 422 });
    if (match[2] === "/content" && request.method === "GET") {
      const { bytes, file } = await store.read(id);
      return new Response(new Blob([new Uint8Array(bytes)], { type: file.mime }), {
        headers: {
          "content-type": file.mime,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.logicalPath.split("/").pop() ?? "file")}`,
          "cache-control": "no-store",
        },
      });    }
    if (match[2] === "/text" && request.method === "GET") {
      const text = await store.derivedText(id);
      if (text === undefined) return Response.json({ error: "no_derived_text" }, { status: 404 });
      return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (match[2] === undefined && request.method === "DELETE") {
      const existing = db.query("SELECT sha256 FROM files WHERE id = ?").get(id);
      const sha256 = z.object({ sha256: z.string() }).parse(existing).sha256;
      const removed = await store.remove(id);
      if (!removed) return Response.json({ error: "missing" }, { status: 404 });
      const blobRemoved = await removeBlobIfUnused(db, sha256, store.root);
      return Response.json({ deleted: true, blobRemoved });
    }
  } catch (error) {
    if (error instanceof FileError) return status(error);
    throw error;
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}
