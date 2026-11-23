import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import type { ServerConfig } from "../../src/contracts/config";
import { migrate, migrations } from "../../src/db/store";
import { AuthGate, hashPassphrase } from "../../src/server/auth";
import { handler } from "../../src/server/main";
import { SecretVault } from "../../src/server/secrets";
import { authorized } from "../../src/server/policy";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(): { db: Database; gate: AuthGate; base: string } {
  const db = new Database(":memory:", { strict: true });
  databases.push(db);
  migrate(db, migrations());
  const base = "http://127.0.0.1:4317";
  const config: ServerConfig = {
    origin: base,
    passphraseHash: hashPassphrase("qa-only-long-passphrase"),
    sessionKey: "qa-only-session-key-exactly-32-bytes",
    encryptionKey: Buffer.alloc(32, 1).toString("base64"),
  };
  return { db, gate: new AuthGate(db, config), base };
}

test("rejects cross-origin mutation with an exact host and port check", async () => {
  const { db, gate, base } = setup();
  const serve = handler(db, gate);
  const accepted = await serve(new Request(`${base}/api/session`, {
    method: "POST",
    headers: { host: "127.0.0.1:4317", origin: base, "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "qa-only-long-passphrase" }),
  }));
  const rejected = await serve(new Request(`${base}/api/session`, {
    method: "POST",
    headers: { host: "127.0.0.1:4317", origin: "https://evil.invalid", "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "qa-only-long-passphrase" }),
  }));
  const wrongPort = await serve(new Request(`${base}/api/session`, {
    method: "POST",
    headers: { host: "127.0.0.1:9999", origin: base, "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "qa-only-long-passphrase" }),
  }));
  assert.equal(accepted.status, 200);
  assert.equal(rejected.status, 403);
  assert.equal(wrongPort.status, 403);
});

test("stores only a hash and refuses an expired session", async () => {
  const { db, gate, base } = setup();
  const response = await gate.login(new Request(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "qa-only-long-passphrase" }),
  }), 1000);
  const token = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(token);
  const rawToken = token.slice(token.indexOf("=") + 1);
  const matched = z.object({ count: z.number() }).parse(db.query("SELECT count(*) AS count FROM sessions WHERE token_hash = ?")
    .get(rawToken));
  assert.equal(matched.count, 0);
  assert.equal(gate.authenticated(new Request(base, { headers: { cookie: token } }), 1001), true);
  assert.equal(gate.authenticated(new Request(base, { headers: { cookie: token } }), 1000 + 31 * 24 * 3600 * 1000), false);
});

test("encrypted credentials authenticate and reject tampering", () => {
  const vault = new SecretVault(Buffer.alloc(32, 2).toString("base64"));
  const ciphertext = vault.encrypt("private-credential");
  assert.equal(ciphertext.includes(Buffer.from("private-credential")), false);
  assert.equal(vault.decrypt(ciphertext), "private-credential");
  ciphertext[30] = (ciphertext[30] ?? 0) ^ 1;
  assert.throws(() => vault.decrypt(ciphertext));
});

test("allows only consented source scopes and active tool versions", async () => {
  const { db, gate, base } = setup();
  const response = await gate.login(new Request(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "qa-only-long-passphrase" }),
  }));
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const request = new Request(base, { headers: { cookie } });
  db.query("INSERT INTO connections (id,provider,scopes_json) VALUES (?,?,?)")
    .run("calendar", "google", '["calendar.read"]');
  db.query("INSERT INTO tool_versions (id,tool_id,artifact_digest,active,approved_by) VALUES (?,?,?,?,?)")
    .run("v1", "summary", "sha256:qa", 1, "user");

  assert.equal(authorized(db, gate, request, { kind: "source", connectionId: "calendar", scope: "calendar.read" }), true);
  assert.equal(authorized(db, gate, request, { kind: "source", connectionId: "calendar", scope: "calendar.write" }), false);
  assert.equal(authorized(db, gate, request, { kind: "tool", toolId: "summary", versionId: "v1" }), true);
  assert.equal(authorized(db, gate, request, { kind: "tool", toolId: "summary", versionId: "unapproved" }), false);
  assert.equal(authorized(db, gate, request, { kind: "external_write" }), false);
  assert.equal(authorized(db, gate, request, { kind: "environment_change" }), false);
});
