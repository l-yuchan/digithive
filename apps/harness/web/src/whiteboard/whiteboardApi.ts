import { z } from "zod";
import { getJson, postJson, sendJson } from "../api";

export const WhiteboardKindSchema = z.enum(["record", "thread", "commitment", "watch"]);
export const WritableKindSchema = z.enum(["thread", "commitment"]);
export type WhiteboardKind = z.infer<typeof WhiteboardKindSchema>;
export type WritableKind = z.infer<typeof WritableKindSchema>;

const SummarySchema = z.object({
  id: z.string(),
  path: z.string(),
  kind: WhiteboardKindSchema,
  title: z.string(),
  source: z.record(z.string(), z.unknown()),
  status: z.string(),
  hash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const DocumentSchema = SummarySchema.extend({ text: z.string() });
const DocumentResponseSchema = z.object({ document: DocumentSchema });

export type WhiteboardSummary = z.infer<typeof SummarySchema>;
export type WhiteboardDocument = z.infer<typeof DocumentSchema>;
export type CreateDocumentInput = {
  readonly path: string;
  readonly kind: WritableKind;
  readonly title: string;
  readonly text: string;
};
export type UpdateDocumentInput = {
  readonly text: string;
  readonly status: string;
  readonly expectedHash: string;
};

export async function listWhiteboardDocuments(filter: {
  readonly query: string;
  readonly kind: WhiteboardKind | "";
}) {
  const params = new URLSearchParams({ limit: "100" });
  if (filter.query.trim()) params.set("query", filter.query.trim());
  if (filter.kind) params.set("kind", filter.kind);
  const body = await getJson(
    `/api/whiteboard?${params.toString()}`,
    z.object({ documents: z.array(SummarySchema) }),
  );
  return body.documents;
}

export async function readWhiteboardDocument(id: string) {
  const body = await getJson(`/api/whiteboard/${encodeURIComponent(id)}`, DocumentResponseSchema);
  return body.document;
}

export async function createWhiteboardDocument(input: CreateDocumentInput) {
  const body = await postJson("/api/whiteboard", input, DocumentResponseSchema);
  return body.document;
}

export async function updateWhiteboardDocument(id: string, input: UpdateDocumentInput) {
  const body = await sendJson(
    "PATCH",
    `/api/whiteboard/${encodeURIComponent(id)}`,
    input,
    DocumentResponseSchema,
  );
  return body.document;
}

/** The shared API helper includes the HTTP status in the first error line. */
export function isStaleConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("PATCH ") &&
    error.message.includes(" → 409 ")
  );
}

export function failureMessage(error: unknown, online: boolean): string {
  if (!online || error instanceof TypeError) {
    return "네트워크에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시도하세요.";
  }
  return error instanceof Error ? error.message : String(error);
}
