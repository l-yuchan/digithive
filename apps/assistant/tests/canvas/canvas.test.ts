import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { migrate, migrations } from "../../src/db/store";
import {
  buildArgs, CanvasCliError, runCanvasCli, type CanvasConfig, type CliSpawn,
} from "../../src/integrations/canvas-cli";
import { collectCourse, syncCanvas } from "../../src/integrations/canvas";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function database(): Database {
  const db = new Database(":memory:", { strict: true });
  migrate(db, migrations());
  databases.push(db);
  return db;
}

/** A fake child process that answers from a route table keyed by argv[3]. */
function fakeSpawn(routes: Record<string, { stdout: string; exitCode?: number }>): CliSpawn {
  return (command) => {
    const path = command[3] ?? "";
    const key = Object.keys(routes).find((candidate) => path.startsWith(candidate)) ?? "";
    const route = routes[key] ?? { stdout: "{}", exitCode: 1 };
    const stream = (text: string): ReadableStream<Uint8Array> => new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return {
      stdout: stream(route.stdout),
      stderr: stream(""),
      exited: Promise.resolve(route.exitCode ?? 0),
      kill: () => undefined,
    };
  };
}

const config: CanvasConfig = { binary: "canvas", host: "lxp-canvas.hanyang.ac.kr", courseAllowlist: [101] };

test("only api GET on an allowlisted path is built, never a shell string or write verb", () => {
  assert.deepEqual(buildArgs("/api/v1/courses/101/assignments?per_page=100"), [
    "api", "GET", "/api/v1/courses/101/assignments?per_page=100", "--paginate", "-o", "json", "--no-cache",
  ]);
  assert.throws(() => buildArgs("/api/v1/courses/101; rm -rf /"), CanvasCliError);
  assert.throws(() => buildArgs("/login/oauth2"), CanvasCliError);
  assert.throws(() => buildArgs("/api/v1/courses/../admin"), CanvasCliError);
});

test("a two-page assignment list is merged and another course's item is ignored", async () => {
  const spawn = fakeSpawn({
    "/api/v1/courses/101/assignments": {
      stdout: JSON.stringify([
        { id: 1, name: "1주차 과제", course_id: 101, due_at: "2026-11-20T14:59:00Z", description: "제출물 A" },
        { id: 2, name: "2주차 과제", course_id: 101, due_at: "2026-11-27T14:59:00Z", description: "제출물 B" },
        { id: 9, name: "다른 과목", course_id: 999, due_at: null },
      ]),
    },
  });
  const items = await collectCourse(config, 101, spawn);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.remoteId, "assignment:101:1");
  const first = z.object({ name: z.string(), due_at: z.string().nullable() }).parse(items[0]?.content);
  assert.equal(first.name, "1주차 과제");
  assert.equal(first.due_at, "2026-11-20T14:59:00Z");
});

test("a missing binary and a failed exit are typed errors, not empty lists", async () => {
  const missing = await runCanvasCli(
    { binary: "definitely-missing-canvas", host: "h", courseAllowlist: [1] },
    "/api/v1/courses/1/assignments",
  ).catch((error: unknown) => error);
  assert.equal(missing instanceof CanvasCliError, true);

  const failed = fakeSpawn({ "/api/v1": { stdout: "Error: 403 Forbidden", exitCode: 1 } });
  await assert.rejects(
    () => runCanvasCli(config, "/api/v1/courses/101/assignments", { spawn: failed }),
    (error: unknown) => error instanceof CanvasCliError && error.kind === "forbidden",
  );
});

test("an envelope with 401 or broken JSON is refused", async () => {
  const unauthorized = fakeSpawn({ "/api/v1": { stdout: JSON.stringify({ status: 401, body: { errors: [] } }) } });
  await assert.rejects(
    () => runCanvasCli(config, "/api/v1/courses/101/assignments", { spawn: unauthorized }),
    (error: unknown) => error instanceof CanvasCliError && error.kind === "auth_required",
  );
  const broken = fakeSpawn({ "/api/v1": { stdout: "{not json" } });
  await assert.rejects(
    () => runCanvasCli(config, "/api/v1/courses/101/assignments", { spawn: broken }),
    (error: unknown) => error instanceof CanvasCliError && error.kind === "invalid_json",
  );
});

test("a sync never tombstones on a failed list and tombstones only after a complete one", async () => {
  const db = database();
  db.query("INSERT INTO connections (id,provider,scopes_json) VALUES ('c1','canvas','[]')").run();
  const source = { connectionId: "c1", courseIds: [101] };

  const ok = fakeSpawn({
    "/api/v1/courses?": { stdout: JSON.stringify([{ id: 101, name: "알고리즘" }]) },
    "/api/v1/courses/101/assignments": {
      stdout: JSON.stringify([{ id: 1, name: "1주차", course_id: 101, due_at: "2026-11-20T14:59:00Z" }]),
    },
    "/api/v1/courses/101/discussion_topics": { stdout: "[]" },
  });
  const first = await syncCanvas(db, config, source, () => 1_000, ok);
  assert.equal(first.stored, 2);

  const failing = fakeSpawn({
    "/api/v1/courses?": { stdout: JSON.stringify({ status: 403, body: {} }) },
  });
  await assert.rejects(() => syncCanvas(db, config, source, () => 2_000, failing));
  assert.equal(z.object({ n: z.number() }).parse(
    db.query("SELECT count(*) AS n FROM source_versions WHERE tombstone = 1").get(),
  ).n, 0, "a failed list must not look like a deletion");

  const empty = fakeSpawn({
    "/api/v1/courses?": { stdout: JSON.stringify([{ id: 101, name: "알고리즘" }]) },
    "/api/v1/courses/101/assignments": { stdout: "[]" },
    "/api/v1/courses/101/discussion_topics": { stdout: "[]" },
  });
  const third = await syncCanvas(db, config, source, () => 3_000, empty);
  assert.equal(third.tombstoned, 1, "a complete empty list tombstones the missing assignment");
});
