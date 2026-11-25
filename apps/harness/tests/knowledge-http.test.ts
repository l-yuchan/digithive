import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, loadConfig } from "../src/server/main";
import { recallMemories, remember, correctMemory } from "../src/knowledge/memory";
import { createSession } from "../src/core/sessions";
import { runTurn } from "../src/surfaces/conversation/loop";

const root = mkdtempSync(join(tmpdir(), "knowledge-http-"));
const harness = createHarness(
  loadConfig({
    HARNESS_DB: join(root, "db.sqlite"),
    HARNESS_WORKSPACE: join(root, "workspace"),
    HARNESS_FILES: join(root, "files"),
  }),
);
const request = (path: string, init?: RequestInit) =>
  harness.handler(new Request(`http://local${path}`, init));

test("HTTP-created memory can be corrected without resurrecting stale rows", async () => {
  const response = await request("/api/memories", {
    method: "POST",
    body: JSON.stringify({ kind: "fact", text: "회의 화요일" }),
  });
  expect(response.status).toBe(201);
  const original = z.object({ id: z.string() }).parse(await response.json());
  const corrected = await request(`/api/memories/${original.id}/correct`, {
    method: "POST",
    body: JSON.stringify({ text: "회의 수요일" }),
  });
  expect(corrected.status).toBe(200);
  expect(recallMemories(harness.deps.db, "다음 회의 일정")).toMatchObject([
    { text: "회의 수요일" },
  ]);
  const stale = await request(`/api/memories/${original.id}/correct`, {
    method: "POST",
    body: JSON.stringify({ text: "회의 금요일" }),
  });
  expect(stale.status).toBe(404);
  const history = await request("/api/memories?includeSuperseded=1");
  expect(
    z.object({ memories: z.array(z.unknown()) }).parse(await history.json()).memories,
  ).toHaveLength(2);
});

test("uploaded bytes round trip and deletion removes the stored file", async () => {
  const bytes = new TextEncoder().encode("자료 원문\n");
  const response = await request("/api/files?name=../../sample.txt", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: bytes,
  });
  expect(response.status).toBe(201);
  const file = z.object({ id: z.string(), name: z.string() }).parse(await response.json());
  expect(file.name).not.toContain("/");
  const downloaded = await request(`/api/files/${file.id}/content`);
  expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  expect(downloaded.headers.get("content-disposition")).toContain("attachment");
  const row = harness.deps.db
    .query<{ path: string }, [string]>("SELECT path FROM files WHERE id = ?")
    .get(file.id);
  expect(row?.path.startsWith(join(root, "files"))).toBe(true);
  expect((await request(`/api/files/${file.id}`, { method: "DELETE" })).status).toBe(200);
  expect(row && existsSync(row.path)).toBe(false);
  expect((await request(`/api/files/${file.id}/content`)).status).toBe(404);
});

test("upload byte limit applies even when content length is absent", async () => {
  const response = await request("/api/files?name=large.txt", {
    method: "POST",
    body: new Uint8Array(10 * 1024 * 1024 + 1),
  });
  expect(response.status).toBe(413);
  expect(harness.deps.db.query("SELECT id FROM files").all()).toEqual([]);
});

test("model cannot create a commitment through its note tool", async () => {
  const tool = harness.work.tools.get("memory_note");
  expect(tool).toBeDefined();
  if (!tool) throw new Error("missing memory tool");
  const rejected = await tool
    .execute({ kind: "commitment", text: "예약한다" }, { runId: "qa" })
    .then(
      () => false,
      (error: unknown) => error instanceof z.ZodError,
    );
  expect(rejected).toBe(true);
  expect(harness.deps.db.query("SELECT id FROM memories WHERE kind = 'commitment'").all()).toEqual(
    [],
  );
});

test("a conversation receives live relevant memories but not corrected content", async () => {
  const memory = remember(harness.deps.db, { kind: "fact", text: "독서 모임은 화요일" });
  correctMemory(harness.deps.db, { id: memory.id, text: "독서 모임은 수요일" });
  const session = createSession(harness.deps.db, "회상 경계");
  let system = "";
  await runTurn(
    {
      ...harness.conversationDeps(),
      stream: async function* (messages) {
        system = messages.find((message) => message.role === "system")?.content ?? "";
        yield { type: "text_delta", text: "확인" };
      },
    },
    { sessionId: session.id, text: "독서 모임 일정" },
  );
  expect(system).toContain("독서 모임은 수요일");
  expect(system).not.toContain("독서 모임은 화요일");
});

afterAll(() => {
  harness.close();
  rmSync(root, { recursive: true, force: true });
});
