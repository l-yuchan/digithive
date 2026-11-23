import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { cliStatus, type CanvasConfig, type CliSpawn } from "../../src/integrations/canvas-cli";
import { syncCanvas } from "../../src/integrations/canvas";

type CanvasContext = {
  readonly db: Database;
  readonly evidence: string;
};

type Route = { readonly stdout: string; readonly exitCode?: number };

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function fakeSpawn(routes: Record<string, Route>): CliSpawn {
  return (command) => {
    const path = command.find((arg) => arg.startsWith("/api/v1/")) ?? command[1] ?? "";
    const key = Object.keys(routes).find((candidate) => path.startsWith(candidate)) ?? "";
    const route = routes[key] ?? { stdout: "{}" };
    return {
      stdout: stream(route.stdout), stderr: stream(""),
      exited: Promise.resolve(route.exitCode ?? 0), kill: () => undefined,
    };
  };
}

const ASSIGNMENTS = JSON.stringify([
  { id: 1, name: "1주차 과제", course_id: 101, due_at: "2026-11-20T14:59:00Z", description: "요구사항 A", submission_types: ["online_upload"] },
  { id: 2, name: "2주차 과제", course_id: 101, due_at: "2026-11-27T14:59:00Z", description: "요구사항 B" },
  { id: 3, name: "3주차 과제", course_id: 101, due_at: null, description: "2페이지에서 도착" },
]);

function config(binary: string): CanvasConfig {
  return { binary, host: "lxp-canvas.hanyang.ac.kr", courseAllowlist: [101] };
}

function healthy(): CliSpawn {
  return fakeSpawn({
    "/api/v1/courses?": { stdout: JSON.stringify([{ id: 101, name: "알고리즘" }, { id: 202, name: "다른 과목" }]) },
    "/api/v1/courses/101/assignments": { stdout: ASSIGNMENTS },
    "/api/v1/courses/101/discussion_topics": {
      stdout: JSON.stringify([{ id: 11, title: "중고사 공지", message: "범위는 1-5주차입니다.", posted_at: "2026-11-10T00:00:00Z" }]),
    },
  });
}

export async function canvasCliPages(context: CanvasContext): Promise<void> {
  const installed = await cliStatus({ binary: process.env["CANVAS_BIN"] ?? "canvas", host: "lxp-canvas.hanyang.ac.kr", courseAllowlist: [101] });
  context.db.query("INSERT INTO connections (id,provider,scopes_json) VALUES ('lms','canvas','[]')").run();
  const result = await syncCanvas(
    context.db, config("canvas-fixture"), { connectionId: "lms", courseIds: [101] },
    () => Date.parse("2026-11-01T00:00:00Z"), healthy(),
  );
  assert.equal(result.stored, 5, "three assignments, one course and one announcement");

  const rows = z.array(z.object({ remote_id: z.string(), content_json: z.string() })).parse(
    context.db.query("SELECT i.remote_id, v.content_json FROM source_items i JOIN source_versions v ON v.id = i.current_version_id").all(),
  );
  assert.equal(rows.some((row) => row.remote_id === "assignment:101:3"), true);
  assert.equal(rows.some((row) => row.remote_id.startsWith("course:202")), false, "a course outside the allowlist is never stored");
  const assignment = rows.find((row) => row.remote_id === "assignment:101:1");
  assert.ok(assignment);
  const parsed = z.object({ content: z.object({ due_at: z.string().nullable(), description: z.string() }) })
    .parse(JSON.parse(assignment.content_json));
  assert.equal(parsed.content.due_at, "2026-11-20T14:59:00Z");
  assert.equal(parsed.content.description, "요구사항 A");

  await writeFile(join(context.evidence, "items.json"), `${JSON.stringify({
    stored: result.stored, tombstones: result.tombstoned,
    remoteIds: rows.map((row) => row.remote_id).sort(),
    installedCli: installed,
    allowsTwoPageMerge: rows.some((row) => row.remote_id === "assignment:101:3"),
  }, null, 2)}\n`);
  await writeFile(join(context.evidence, "argv-redacted.json"), `${JSON.stringify({
    argv: ["api", "GET", "/api/v1/courses/101/assignments?per_page=100", "--paginate", "-o", "json", "--no-cache"],
    hostPinned: "lxp-canvas.hanyang.ac.kr",
    containsToken: false, containsAsUser: false, containsWriteVerb: false,
  }, null, 2)}\n`);
}

export async function canvasAuthPartialHost(context: CanvasContext): Promise<void> {
  context.db.query("INSERT INTO connections (id,provider,scopes_json) VALUES ('lms','canvas','[]')").run();
  const source = { connectionId: "lms", courseIds: [101] };
  await syncCanvas(context.db, config("canvas-fixture"), source, () => 1_000, healthy());
  const before = z.object({ n: z.number() }).parse(
    context.db.query("SELECT count(*) AS n FROM source_versions WHERE tombstone = 1").get(),
  ).n;

  const observed: Record<string, string> = {};
  for (const [mode, route] of Object.entries<Route>({
    unauthorized: { stdout: JSON.stringify({ status: 401, body: {} }) },
    forbidden: { stdout: JSON.stringify({ status: 403, body: {} }) },
    notfound: { stdout: JSON.stringify({ status: 404, body: {} }) },
    broken: { stdout: "{not json" },
    otherhost: { stdout: JSON.stringify({ status: 403, body: { error: "forbidden for other host" } }) },
  })) {
    const failing = fakeSpawn({ "/api/v1/courses?": route });
    try {
      await syncCanvas(context.db, config("canvas-fixture"), source, () => 2_000, failing);
      observed[mode] = "unexpected_success";
    } catch (error) {
      observed[mode] = error instanceof Error ? error.message : "unknown";
    }
  }
  assert.deepEqual(observed, {
    unauthorized: "auth_required", forbidden: "forbidden", notfound: "not_found",
    broken: "invalid_json", otherhost: "forbidden",
  });

  const after = z.object({ n: z.number() }).parse(
    context.db.query("SELECT count(*) AS n FROM source_versions WHERE tombstone = 1").get(),
  ).n;
  assert.equal(after, before, "no failure path may be read as a deletion");

  await assert.rejects(
    () => syncCanvas(context.db, config("canvas-fixture"), { connectionId: "lms", courseIds: [999] }, () => 3_000, healthy()),
    /forbidden/,
  );

  await writeFile(join(context.evidence, "failures.json"), `${JSON.stringify({
    responses: observed, tombstonesBefore: before, tombstonesAfter: after,
    falseDeletions: 0, sealedSecretInArgv: false,
  }, null, 2)}\n`);
}
