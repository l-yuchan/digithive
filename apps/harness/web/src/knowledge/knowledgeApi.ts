import { z } from "zod";
import { apiUrl, getJson } from "../api";

export const MemoryKindSchema = z.enum([
  "interest",
  "fact",
  "hypothesis",
  "commitment",
  "delegation",
]);
export const kindLabels: Record<z.infer<typeof MemoryKindSchema>, string> = {
  interest: "관심",
  fact: "사실",
  hypothesis: "가설",
  commitment: "약속",
  delegation: "위임",
};

export const MemorySchema = z.object({
  id: z.string(),
  kind: MemoryKindSchema,
  text: z.string(),
  source: z.unknown(),
  supersededBy: z.string().nullable(),
  createdAt: z.string(),
});
export type Memory = z.infer<typeof MemorySchema>;

const FileSchema = z.object({
  id: z.string(),
  name: z.string(),
  bytes: z.number(),
  mime: z.string(),
  sha256: z.string(),
  origin: z.string(),
  createdAt: z.string(),
});
export type FileRecord = z.infer<typeof FileSchema>;

export async function listMemories(includeSuperseded: boolean) {
  const suffix = includeSuperseded ? "?includeSuperseded=1" : "";
  return (await getJson(`/api/memories${suffix}`, z.object({ memories: z.array(MemorySchema) })))
    .memories;
}

export async function listFiles() {
  return (await getJson("/api/files", z.object({ files: z.array(FileSchema) }))).files;
}

export async function uploadFile(file: File) {
  const response = await fetch(apiUrl(`/api/files?name=${encodeURIComponent(file.name)}`), {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (response.status === 413) {
    const detail = z.object({ limit: z.number() }).safeParse(await response.json());
    throw new Error(
      detail.success
        ? `파일이 너무 큽니다. ${detail.data.limit.toLocaleString("ko-KR")}바이트 이하의 파일을 선택하세요.`
        : "파일이 너무 큽니다. 더 작은 파일을 선택하세요.",
    );
  }
  if (!response.ok)
    throw new Error(`파일 업로드 실패 (${response.status}): ${await response.text()}`);
  return FileSchema.parse(await response.json());
}
