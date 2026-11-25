import type { Database } from "bun:sqlite";
import { z } from "zod";
import { listFiles, readStoredFile } from "../files/store";
import type { ToolRuntime } from "./registry";

export function fileTools(db: Database): ToolRuntime[] {
  return [
    {
      name: "stored_file_list",
      description: "사용자가 저장한 파일의 ID와 이름을 조회합니다.",
      parameters: { type: "object", properties: {} },
      action: "read",
      conversation: true,
      execute: async () => JSON.stringify(listFiles(db).map(({ path: _path, ...file }) => file)),
    },
    {
      name: "stored_file_read",
      description: "저장된 텍스트 파일을 최대 12000자 읽습니다. 바이너리는 읽지 않습니다.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      action: "read",
      conversation: true,
      execute: async (args) => {
        const { id } = z.object({ id: z.string() }).parse(args);
        const file = readStoredFile(db, id);
        if (!file) return JSON.stringify({ error: "file_not_found" });
        if (!file.meta.mime.startsWith("text/") && file.meta.mime !== "application/json")
          return JSON.stringify({ error: "binary_file", name: file.meta.name });
        const content = new TextDecoder().decode(file.bytes);
        return JSON.stringify({
          id,
          name: file.meta.name,
          text: content.slice(0, 12000),
          truncated: content.length > 12000,
        });
      },
    },
  ];
}
