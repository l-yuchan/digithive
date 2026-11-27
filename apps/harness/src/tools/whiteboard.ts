import { z } from "zod";
import type { ToolRuntime } from "./registry";
import type { WhiteboardEvidence } from "./whiteboard-evidence";
import type { WhiteboardStore } from "../whiteboard/types";
import { WhiteboardError } from "../whiteboard/types";

const kinds = ["record", "thread", "commitment", "watch"] as const;
const statuses = ["active", "open", "in_progress", "done", "cancelled", "archived"] as const;
const writeFields = {
  path: { type: "string" },
  kind: { enum: kinds },
  title: { type: "string" },
  text: { type: "string" },
  status: { enum: statuses },
} as const;
const textSchema = z.string().max(180_000);

const writeSchema = z
  .object({
    path: z.string().min(1).max(512),
    kind: z.enum(kinds),
    title: z.string().trim().min(1).max(200),
    text: textSchema,
    status: z.enum(statuses).optional(),
  })
  .strict();

export type WhiteboardToolDeps = {
  readonly whiteboard: WhiteboardStore;
  readonly evidence: WhiteboardEvidence;
};

/** Agents share the same filesystem and citation receipts as the HTTP surface. */
export function whiteboardTools(deps: WhiteboardToolDeps): ToolRuntime[] {
  const remember = (runId: string, ids: readonly string[]) => deps.evidence.record(runId, ids);
  return [
    {
      name: "whiteboard_list",
      description:
        "화이트보드의 Record/Thread/Commitment/Watch를 검색하거나 나열합니다. 출처·상태·경로를 반환하며 한국어 단어도 검색됩니다.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { enum: kinds },
          limit: { type: "number", minimum: 1, maximum: 200 },
        },
      },
      action: "read",
      conversation: true,
      execute: async (args, context) => {
        const input = z
          .object({
            query: z.string().max(500).optional(),
            kind: z.enum(kinds).optional(),
            limit: z.number().int().min(1).max(200).default(50),
          })
          .strict()
          .parse(args);
        const documents = deps.whiteboard.list({
          limit: input.limit,
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
        });
        remember(
          context.runId,
          documents.map((document) => document.id),
        );
        return JSON.stringify({ documents });
      },
    },
    {
      name: "whiteboard_read",
      description:
        "화이트보드 문서 하나의 Markdown 본문과 출처를 읽습니다. 목록의 정확한 id를 사용하세요.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      action: "read",
      conversation: true,
      execute: async (args, context) => {
        const input = z
          .object({ id: z.string().min(1) })
          .strict()
          .parse(args);
        const document = deps.whiteboard.read(input.id);
        if (document) remember(context.runId, [document.id]);
        return JSON.stringify(document ?? { error: "document_not_found", id: input.id });
      },
    },
    {
      name: "whiteboard_write",
      description:
        "화이트보드의 지정한 종류 루트 아래에 새 Markdown 문서를 만듭니다. 기존 경로는 덮지 않고 whiteboard_update를 씁니다.",
      parameters: {
        type: "object",
        properties: writeFields,
        required: ["path", "kind", "title", "text"],
      },
      action: "edit",
      conversation: true,
      execute: async (args, context) => {
        const input = writeSchema.parse(args);
        const document = deps.whiteboard.write({
          path: input.path,
          kind: input.kind,
          title: input.title,
          text: input.text,
          ...(input.status === undefined ? {} : { status: input.status }),
          source: { type: "agent", id: context.runId },
        });
        remember(context.runId, [document.id]);
        return JSON.stringify({ document });
      },
    },
    {
      name: "whiteboard_update",
      description:
        "사용자나 에이전트가 쓴 문서의 본문/상태를 갱신합니다. 마지막으로 읽은 hash가 현재 hash와 같아야 합니다.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          expectedHash: { type: "string" },
          text: { type: "string" },
          status: { enum: statuses },
        },
        required: ["id", "expectedHash"],
      },
      action: "edit",
      conversation: true,
      execute: async (args, context) => {
        const input = z
          .object({
            id: z.string().min(1),
            expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
            text: textSchema.optional(),
            status: z.enum(statuses).optional(),
          })
          .strict()
          .refine((value) => value.text !== undefined || value.status !== undefined)
          .parse(args);
        const current = deps.whiteboard.read(input.id);
        if (!current) throw new WhiteboardError("document_not_found");
        const owner = current.source["type"];
        if (owner !== "user" && owner !== "agent") {
          throw new WhiteboardError("operational_document_read_only");
        }
        const document = deps.whiteboard.update({
          id: input.id,
          expectedHash: input.expectedHash,
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.status === undefined ? {} : { status: input.status }),
        });
        remember(context.runId, [document.id]);
        return JSON.stringify({ document });
      },
    },
  ];
}
