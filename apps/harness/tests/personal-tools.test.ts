import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness } from "../src/server/main";
import { loadConfig } from "../src/runtime";
import { createSession, listEntries } from "../src/core/sessions";
import { saveTokens } from "../src/integrations/google";
import { runTurn } from "../src/surfaces/conversation/loop";
import { GMAIL_QUERY, installFakeGoogle, startFakeModel } from "./personal-tools-fixture";

const SECRET = "personal-tools-test-secret";

const GmailSearchResult = z.object({
  query: z.string(),
  messages: z.array(z.object({ id: z.string(), title: z.string(), detail: z.string() })),
  hasMore: z.boolean(),
});

const PersonalSearchResult = z.object({
  source: z.string(),
  state: z
    .object({
      ok: z.number(),
      last_sync_at: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  items: z.array(
    z.object({
      item_id: z.string(),
      title: z.string(),
      at: z.string().nullable(),
      detail: z.string().nullable(),
      url: z.string().nullable(),
      updated_at: z.string(),
    }),
  ),
});

function temporaryRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "personal-tools-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function harnessAt(root: string, baseUrl: string) {
  return createHarness(
    loadConfig({
      HARNESS_DB: join(root, "harness.db"),
      HARNESS_WORKSPACE: join(root, "workspace"),
      HARNESS_SESSION_SECRET: SECRET,
      MODEL_BASE_URL: baseUrl,
      MODEL_NAME: "fake-model",
    }),
  );
}

test("a createHarness conversation offers and executes gmail_search over the Google wire protocol", async () => {
  const google = installFakeGoogle();
  const model = startFakeModel();
  const { root, cleanup } = temporaryRoot();
  const harness = harnessAt(root, model.url);
  try {
    saveTokens(harness.deps.db, SECRET, {
      accessToken: "fake-access-token",
      refreshToken: null,
      expiresAt: Date.now() + 3_600_000,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    });
    const session = createSession(harness.deps.db, "뉴스레터");

    const result = await runTurn(harness.deps.conversation, {
      sessionId: session.id,
      text: "지난주 뉴스레터 찾아줘",
    });
    expect(result.status).toBe("succeeded");
    expect(result.text).toBe("뉴스레터 요약을 마쳤습니다.");

    const offered = model.requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(offered).toContain("gmail_search");
    expect(offered).toContain("personal_data_search");

    const list = google.calls.find((url) => url.pathname === "/gmail/v1/users/me/messages");
    expect(list?.searchParams.get("q")).toBe(GMAIL_QUERY);
    expect(list?.searchParams.get("maxResults")).toBe("2");
    expect(google.detailIds).toEqual(["m1", "m2"]);

    const toolMessage = model.requests[1]?.messages.find((message) => message.role === "tool");
    const parsed: unknown = JSON.parse(toolMessage?.content ?? "{}");
    const output = GmailSearchResult.parse(parsed);
    expect(output.query).toBe(GMAIL_QUERY);
    expect(output.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(output.messages.map((message) => message.detail)).toEqual(["본문 m1", "본문 m2"]);

    const assistant = listEntries(harness.deps.db, session.id).find(
      (entry) => entry.role === "assistant",
    );
    expect(assistant?.parts.find((part) => part.type === "tool_result")).toMatchObject({
      type: "tool_result",
      name: "gmail_search",
    });
  } finally {
    google.restore();
    harness.close();
    await model.stop();
    cleanup();
  }
});

test("gmail_search without stored Google tokens returns an actionable error to the model", async () => {
  const google = installFakeGoogle();
  const model = startFakeModel();
  const { root, cleanup } = temporaryRoot();
  const harness = harnessAt(root, model.url);
  try {
    const session = createSession(harness.deps.db, "연결 안 됨");
    const result = await runTurn(harness.deps.conversation, {
      sessionId: session.id,
      text: "메일 찾아줘",
    });
    expect(result.status).toBe("succeeded");

    const toolMessage = model.requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toBe("도구 실행 실패: google_not_connected");
    expect(google.calls).toEqual([]);
  } finally {
    google.restore();
    harness.close();
    await model.stop();
    cleanup();
  }
});

test("personal_data_search stays inside one cached source and treats the query as text", async () => {
  const { root, cleanup } = temporaryRoot();
  const harness = harnessAt(root, "http://127.0.0.1:1/v1");
  try {
    const insert = harness.deps.db.query(
      "INSERT INTO sync_items (account_id,source,item_id,title,at,detail,url,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    insert.run(
      "google-default",
      "calendar",
      "cal-1",
      "팀 회의",
      "2026-11-24T10:00:00.000Z",
      "회의록",
      null,
      "2026-11-25T00:00:00.000Z",
    );
    insert.run(
      "google-default",
      "gmail",
      "mail-1",
      "팀 회의 안내",
      "2026-11-25T10:00:00.000Z",
      "회의 일정",
      null,
      "2026-11-25T00:00:00.000Z",
    );
    insert.run(
      "canvas-default",
      "canvas",
      "canvas-1",
      "회의 과제",
      "2026-11-26T10:00:00.000Z",
      "회의 제출",
      null,
      "2026-11-25T00:00:00.000Z",
    );
    harness.deps.db
      .query(
        "UPDATE account_sources SET ok=1, last_sync_at='2026-11-25T00:00:00.000Z' WHERE account_id='google-default' AND source='calendar'",
      )
      .run();

    const tool = harness.work.tools.get("personal_data_search");
    if (!tool) throw new Error("personal_data_search is not registered in the work runtime");
    const search = async (source: string, query: string) => {
      const raw: unknown = JSON.parse(await tool.execute({ source, query }, { runId: "test-run" }));
      return PersonalSearchResult.parse(raw);
    };

    const calendar = await search("calendar", "회의");
    expect(calendar.source).toBe("calendar");
    expect(calendar.items.map((item) => item.item_id)).toEqual(["cal-1"]);
    expect(calendar.state?.ok).toBe(1);

    expect((await search("gmail", "회의")).items.map((item) => item.item_id)).toEqual(["mail-1"]);
    expect((await search("canvas", "회의")).items.map((item) => item.item_id)).toEqual([
      "canvas-1",
    ]);

    expect((await search("calendar", "' OR 1=1 --")).items).toEqual([]);
    expect((await search("calendar", "%")).items).toEqual([]);
  } finally {
    harness.close();
    cleanup();
  }
});

test("a createHarness conversation runs personal_data_search from the runtime registry and reads seeded cache", async () => {
  const model = startFakeModel(
    { name: "personal_data_search", arguments: { source: "gmail", query: "회의" } },
    "캐시 검색을 마쳤습니다.",
  );
  const { root, cleanup } = temporaryRoot();
  const harness = harnessAt(root, model.url);
  try {
    const insert = harness.deps.db.query(
      "INSERT INTO sync_items (account_id,source,item_id,title,at,detail,url,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    insert.run(
      "google-default",
      "gmail",
      "mail-1",
      "팀 회의 안내",
      "2026-11-25T10:00:00.000Z",
      "회의 일정 원문",
      null,
      "2026-11-25T00:00:00.000Z",
    );
    insert.run(
      "google-default",
      "calendar",
      "cal-1",
      "팀 회의",
      "2026-11-24T10:00:00.000Z",
      "회의록",
      null,
      "2026-11-25T00:00:00.000Z",
    );

    const session = createSession(harness.deps.db, "캐시 검색");
    const result = await runTurn(harness.deps.conversation, {
      sessionId: session.id,
      text: "저장된 메일에서 회의 찾아줘",
    });
    expect(result.status).toBe("succeeded");
    expect(result.text).toBe("캐시 검색을 마쳤습니다.");

    const offered = model.requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(offered).toContain("personal_data_search");

    const toolMessage = model.requests[1]?.messages.find((message) => message.role === "tool");
    const parsed: unknown = JSON.parse(toolMessage?.content ?? "{}");
    const output = PersonalSearchResult.parse(parsed);
    expect(output.source).toBe("gmail");
    expect(output.items.map((item) => item.item_id)).toEqual(["mail-1"]);
    expect(output.items[0]?.detail).toBe("회의 일정 원문");
  } finally {
    harness.close();
    await model.stop();
    cleanup();
  }
});

test("loadConfig refuses Google credentials without a shared session secret", () => {
  expect(() => loadConfig({ GOOGLE_CLIENT_ID: "client-id" })).toThrow(/HARNESS_SESSION_SECRET/);
  const config = loadConfig({ GOOGLE_CLIENT_ID: "client-id", HARNESS_SESSION_SECRET: SECRET });
  expect(config.sessionSecret).toBe(SECRET);
  expect(config.googleClientId).toBe("client-id");
});
