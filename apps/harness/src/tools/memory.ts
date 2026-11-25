import type { Database } from "bun:sqlite";
import { z } from "zod";
import { remember, correctMemory, recallMemories } from "../knowledge/memory";
import type { ToolRuntime } from "./registry";

export function memoryTools(db: Database): ToolRuntime[] {
  return [
    {
      name: "memory_note",
      description:
        "사용자가 말한 사실 또는 가설을 출처와 함께 기억합니다. 관심·약속·위임 분류는 사람이 화면에서 선택합니다. 추측을 사실로 저장하지 마세요.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["fact", "hypothesis"] },
          text: { type: "string", maxLength: 4000 },
        },
        required: ["kind", "text"],
      },
      action: "edit",
      conversation: true,
      execute: async (args, context) => {
        const input = z
          .object({
            kind: z.enum(["fact", "hypothesis"]),
            text: z.string().trim().min(1).max(4000),
          })
          .parse(args);
        return JSON.stringify(
          remember(db, { ...input, source: { runId: context.runId, origin: "assistant" } }),
        );
      },
    },
    {
      name: "memory_recall",
      description: "살아 있는 기억을 검색합니다. 정정된 이전 내용은 반환하지 않습니다.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      action: "read",
      conversation: true,
      execute: async (args) =>
        JSON.stringify(
          recallMemories(db, z.object({ query: z.string().max(1000) }).parse(args).query),
        ),
    },
    {
      name: "memory_correct",
      description:
        "사용자가 정정을 요청한 기억의 내용을 교체하며 원본 이력을 보존합니다. 종류는 바꾸지 않습니다.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" } },
        required: ["id", "text"],
      },
      action: "edit",
      conversation: true,
      execute: async (args) =>
        JSON.stringify(
          correctMemory(
            db,
            z.object({ id: z.string(), text: z.string().trim().min(1).max(4000) }).parse(args),
          ),
        ),
    },
  ];
}
