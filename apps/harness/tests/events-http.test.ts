import { expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, loadConfig } from "../src/server/main";
import { createSession } from "../src/core/sessions";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "events-http-"));
  const harness = createHarness(
    loadConfig({
      HARNESS_DB: join(root, "db.sqlite"),
      HARNESS_WORKSPACE: join(root, "workspace"),
      HARNESS_SESSION_SECRET: "test-secret",
    }),
  );
  return {
    harness,
    cleanup: () => {
      harness.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Reads one complete SSE frame. */
async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ frame: string; done: boolean }> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const next = await reader.read();
    if (next.done) return { frame: buffer, done: true };
    buffer += decoder.decode(next.value, { stream: true });
    const boundary = buffer.indexOf("\n\n");
    if (boundary !== -1) return { frame: buffer.slice(0, boundary), done: false };
  }
}

test("an event stream opens with the current snapshot and never replays old deltas", async () => {
  const { harness, cleanup } = setup();
  try {
    const session = createSession(harness.deps.db, "스트림");
    harness.deps.events.append({
      kind: "message.delta",
      sessionId: session.id,
      payload: { entryId: "old-entry", text: "과거 응답" },
    });

    const response = await harness.handler(
      new Request(`https://app.example/api/events?session=${encodeURIComponent(session.id)}`),
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("event stream has no body");
    const first = await readFrame(reader);
    expect(first.frame).toContain("event: snapshot");
    // The snapshot already reflects the past event; replaying its delta would
    // append the same text to an answer that is already on screen.
    expect(first.frame).not.toContain("과거 응답");

    const appended = harness.deps.events.append({
      kind: "message.delta",
      sessionId: session.id,
      payload: { entryId: "new-entry", text: "새 응답" },
    });
    const live = await readFrame(reader);
    expect(live.frame).toContain(`id: ${appended.seq}`);
    expect(live.frame).toContain("event: message.delta");
    expect(live.frame).toContain("새 응답");

    await reader.cancel();
  } finally {
    cleanup();
  }
});

test("the served build id is exposed so a stale tab can notice a deploy", async () => {
  const { harness, cleanup } = setup();
  try {
    const response = await harness.handler(new Request("https://app.example/api/version"));
    expect(response.status).toBe(200);
    const body = z.object({ build: z.string() }).parse(await response.json());
    expect(typeof body.build).toBe("string");
    expect(body.build).toBe(harness.deps.buildId);
  } finally {
    cleanup();
  }
});
