import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { Health } from "../src/contracts/api";
import { migrate, openDatabase, schemaVersion } from "../src/db/store";
import { handler } from "../src/server/main";

const Arguments = z.object({
  scenario: z.enum(["foundation-health", "foundation-bad-migration", "foundation-fixture-failure"]),
  evidence: z.string().min(1),
});
type Context = {
  readonly db: Database;
  readonly evidence: string;
  readonly fixtureBase: string;
};

function options(args: readonly string[]): z.infer<typeof Arguments> {
  const pairs: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (item === "--") continue;
    if (item !== "--scenario" && item !== "--evidence") {
      throw new QaArgumentError(`Unknown option: ${item}`);
    }
    pairs[item.slice(2)] = args[++index];
  }
  const parsed = Arguments.safeParse(pairs);
  if (!parsed.success) throw new QaArgumentError("Unknown scenario or missing evidence path");
  return parsed.data;
}

class QaArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaArgumentError";
  }
}

async function record(evidence: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
}

async function portReleased(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

async function foundationHealth(context: Context): Promise<void> {
  const response = await fetch("http://127.0.0.1:4317/health");
  const body: unknown = await response.json();
  assert.equal(response.status, 200);
  const health = Health.parse(body);
  assert.equal(health.schemaVersion, schemaVersion(context.db));
  await record(context.evidence, "http.json", {
    request: "GET /health",
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: health,
  });
  await record(context.evidence, "db.json", {
    version: schemaVersion(context.db),
    foreignKeys: context.db.query("PRAGMA foreign_keys").get(),
    journalMode: context.db.query("PRAGMA journal_mode").get(),
    synchronous: context.db.query("PRAGMA synchronous").get(),
  });
}

async function foundationBadMigration(context: Context): Promise<void> {
  const now = new Date(0).toISOString();
  context.db.query("INSERT INTO settings (key,value_json,updated_by,updated_at) VALUES (?,?,?,?)")
    .run("survivor", '"original"', "qa", now);
  let rejected = false;
  try {
    migrate(context.db, [{
      version: 2,
      sql: "UPDATE settings SET value_json = '\"changed\"' WHERE key = 'survivor'; INSERT INTO missing_table VALUES (1);",
    }]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    rejected = true;
  }
  const row = context.db.query("SELECT value_json FROM settings WHERE key = 'survivor'").get();
  assert.equal(rejected, true);
  assert.deepEqual(row, { value_json: '"original"' });
  assert.equal(schemaVersion(context.db), 1);
  await record(context.evidence, "rollback.json", {
    migrationFailed: rejected,
    row,
    version: schemaVersion(context.db),
  });
}

async function foundationFixtureFailure(context: Context): Promise<void> {
  const response = await fetch(`${context.fixtureBase}/health`);
  const payload: unknown = await response.json();
  Health.parse(payload);
}

async function run(): Promise<void> {
  const input = options(process.argv.slice(2));
  const evidence = resolve(input.evidence);
  await mkdir(evidence, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "digithive-qa-"));
  let db: Database | undefined;
  let app: ReturnType<typeof Bun.serve> | undefined;
  let fixture: ReturnType<typeof Bun.serve> | undefined;
  try {
    db = openDatabase(join(temporary, "assistant.sqlite"));
    app = Bun.serve({ hostname: "127.0.0.1", port: 4317, fetch: handler(db) });
    fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 4318,
      fetch: () => Response.json({ ok: false, schemaVersion: -1 }),
    });
    const context = { db, evidence, fixtureBase: "http://127.0.0.1:4318" };
    switch (input.scenario) {
      case "foundation-health":
        await foundationHealth(context);
        break;
      case "foundation-bad-migration":
        await foundationBadMigration(context);
        break;
      case "foundation-fixture-failure":
        await foundationFixtureFailure(context);
        break;
      default:
        throw new QaArgumentError("Unknown scenario");
    }
    console.log(`PASS ${input.scenario}`);
  } finally {
    fixture?.stop(true);
    app?.stop(true);
    db?.close();
    await rm(temporary, { recursive: true, force: true });
    await record(evidence, "cleanup.json", {
      applicationPortClosed: await portReleased(4317),
      fixturePortClosed: await portReleased(4318),
      temporaryRemoved: !existsSync(temporary),
    });
  }
}

try {
  await run();
} catch (error) { // no-excuse-ok: catch
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Unknown QA failure");
  process.exitCode = error instanceof QaArgumentError ? 2 : 1;
}
