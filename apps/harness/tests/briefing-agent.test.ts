import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createWhiteboardStore } from "../src/whiteboard";
import { openDatabase } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { enqueueRun } from "../src/surfaces/work/runner";
import { jobTools } from "../src/tools/jobs";
import { createWhiteboardEvidence } from "../src/tools/whiteboard-evidence";
import { latestAgentBriefing } from "../src/workflows/briefing-store";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "briefing-agent-"));
  const db = openDatabase(":memory:");
  const events = new EventLog(db);
  const whiteboard = createWhiteboardStore(db, join(root, "whiteboard"));
  const evidence = createWhiteboardEvidence();
  const tools = jobTools({
    db,
    events,
    google: {
      db,
      events,
      vaultSecret: "test-secret",
      config: { clientId: "", clientSecret: "", redirectUri: "" },
    },
    canvas: { db, events, config: { baseUrl: "", token: "" } },
    briefingSources: evidence,
    refreshWhiteboard: () => whiteboard.refresh(),
  });
  const publish = tools.find((tool) => tool.name === "briefing_publish");
  if (!publish) throw new Error("briefing_publish missing");
  const run = enqueueRun(db, events, { goal: "agent briefing" });
  const source = whiteboard.write({
    path: "threads/notes/current-presentation",
    kind: "thread",
    title: "발표 시각",
    text: "발표는 14시입니다.",
    source: { type: "user", id: "test" },
  });
  return {
    db,
    events,
    whiteboard,
    evidence,
    publish,
    run,
    source,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("briefing_publish persists full natural text with retrieved sources and run identity", async () => {
  // Given a current whiteboard source retrieved by this run.
  const context = setup();
  try {
    context.evidence.record(context.run.id, [context.source.id]);
    const text = "오늘 오후 2시에 발표가 있습니다. 자료를 미리 확인하세요.";
    // When the agent publishes its own natural-language briefing.
    const raw = await context.publish.execute(
      { text, sourceIds: [context.source.id], slot: "07:30" },
      { runId: context.run.id },
    );
    const published = z
      .object({ stored: z.boolean(), duplicate: z.boolean(), id: z.string() })
      .parse(JSON.parse(raw));
    expect(published).toMatchObject({ stored: true, duplicate: false });
    // Then the latest row keeps every character, citation, and run link.
    expect(latestAgentBriefing(context.db)).toMatchObject({
      slot: "07:30",
      content: { runId: context.run.id, text, references: [context.source.id] },
    });
    const projected = context.whiteboard
      .list({ query: "발표" })
      .find((document) => document.source["briefingId"] === published.id);
    expect(projected).toBeDefined();
    expect(projected ? context.whiteboard.read(projected.id)?.text : null).toContain(text);
  } finally {
    context.cleanup();
  }
});

test("briefing_publish rejects unseen sources and empty text without a row", async () => {
  // Given a run that has not retrieved a citation it tries to claim.
  const context = setup();
  try {
    await expect(
      context.publish.execute(
        { text: "근거 없는 브리핑", sourceIds: ["wb_notretrieved"] },
        { runId: context.run.id },
      ),
    ).rejects.toThrow("sources_not_retrieved");
    // When the agent returns whitespace instead of a briefing, that also cannot publish.
    await expect(
      context.publish.execute(
        { text: "  ", sourceIds: [context.source.id] },
        { runId: context.run.id },
      ),
    ).rejects.toThrow();
    // Then neither call inserted a successful briefing.
    expect(context.db.query("SELECT count(*) AS count FROM briefings").get()).toEqual({ count: 0 });
  } finally {
    context.cleanup();
  }
});

test("legacy briefing JSON remains readable with no source references", () => {
  // Given a row written before references existed.
  const context = setup();
  try {
    context.db
      .query("INSERT INTO briefings (id,slot,content_json,created_at,run_id) VALUES (?,?,?,?,NULL)")
      .run(
        "legacy",
        "21:00",
        JSON.stringify({
          slot: "21:00",
          generatedAt: "2026-01-01T00:00:00.000Z",
          events: [],
          assignments: [],
          mail: [],
          text: "기존 브리핑",
        }),
        "2026-01-01T00:00:00.000Z",
      );
    // When the current reader loads it, the added field defaults to an empty list.
    expect(latestAgentBriefing(context.db)?.content.references).toEqual([]);
  } finally {
    context.cleanup();
  }
});
