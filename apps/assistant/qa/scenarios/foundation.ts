import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { Health } from "../../src/contracts/api";
import { migrate, schemaVersion } from "../../src/db/store";

export type FoundationContext = {
  readonly db: Database;
  readonly evidence: string;
  readonly fixtureBase: string;
};

async function record(evidence: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
}

export async function foundationHealth(context: FoundationContext): Promise<void> {
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

export async function foundationBadMigration(context: FoundationContext): Promise<void> {
  const now = new Date(0).toISOString();
  const version = schemaVersion(context.db);
  context.db.query("INSERT INTO settings (key,value_json,updated_by,updated_at) VALUES (?,?,?,?)")
    .run("survivor", '"original"', "qa", now);
  let rejected = false;
  try {
    migrate(context.db, [{
      version: version + 1,
      sql: "UPDATE settings SET value_json = '\"changed\"' WHERE key = 'survivor'; INSERT INTO missing_table VALUES (1);",
    }]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    rejected = true;
  }
  const row = context.db.query("SELECT value_json FROM settings WHERE key = 'survivor'").get();
  assert.equal(rejected, true);
  assert.deepEqual(row, { value_json: '"original"' });
  assert.equal(schemaVersion(context.db), version);
  await record(context.evidence, "rollback.json", { migrationFailed: rejected, row, version });
}

export async function foundationFixtureFailure(context: FoundationContext): Promise<void> {
  const response = await fetch(`${context.fixtureBase}/health`);
  const payload: unknown = await response.json();
  Health.parse(payload);
}

export async function authOriginAndExpiry(context: FoundationContext): Promise<void> {
  const url = "http://127.0.0.1:4317";
  const wrongOrigin = await fetch(`${url}/api/conversations`, {
    method: "POST",
    headers: { origin: "https://evil.invalid" },
  });
  assert.equal(wrongOrigin.status, 403);
  const malformed = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: "{broken",
  });
  assert.equal(malformed.status, 422);
  const loggedIn = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "qa-only-long-passphrase" }),
  });
  assert.equal(loggedIn.status, 200);
  const sessionCookie = loggedIn.headers.get("set-cookie")?.split(";")[0];
  assert.ok(sessionCookie);
  const sessionToken = sessionCookie.slice(sessionCookie.indexOf("=") + 1);
  const sessionTokenInBody = (await loggedIn.text()).includes(sessionToken);
  assert.equal(sessionTokenInBody, false);
  context.db.exec("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
  const expired = await fetch(`${url}/api/conversations`, { headers: { cookie: sessionCookie } });
  assert.equal(expired.status, 401);
  const failures: number[] = [];
  for (let index = 0; index < 6; index++) {
    const result = await fetch(`${url}/api/session`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "wrong" }),
    });
    failures.push(result.status);
  }
  assert.deepEqual(failures, [401, 401, 401, 401, 401, 429]);
  await record(context.evidence, "auth-http.json", {
    wrongOrigin: wrongOrigin.status,
    malformed: malformed.status,
    expired: expired.status,
    loginThrottle: failures,
    sessionTokenInBody,
  });
}
