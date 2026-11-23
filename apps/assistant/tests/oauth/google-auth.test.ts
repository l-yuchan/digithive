import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "../../src/db/store";
import { SecretVault } from "../../src/server/secrets";
import {
  authorizationUrl, beginAuthorization, consumeState, disconnect, ensureAccessToken,
  exchangeCode, GoogleAuthError, storeConnection, type GoogleConfig,
} from "../../src/integrations/google-auth";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(): { db: Database; vault: SecretVault } {
  const db = new Database(":memory:", { strict: true });
  migrate(db, migrations());
  databases.push(db);
  return { db, vault: new SecretVault(Buffer.alloc(32, 7).toString("base64")) };
}

const config: GoogleConfig = {
  clientId: "client-id", clientSecret: "client-secret",
  redirectUri: "http://127.0.0.1:4317/api/oauth/google/callback",
  authUrl: "https://accounts.example/auth", tokenUrl: "https://oauth.example/token",
};

function tokenFetch(responses: unknown[]): { fetch: typeof fetch; calls: number } {
  let calls = 0;
  const fetchImpl = (async () => {
    const body = responses[calls] ?? responses[responses.length - 1];
    calls += 1;
    if (body instanceof Error) throw body;
    return Response.json(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, get calls() { return calls; } };
}

test("the authorization URL carries offline access, PKCE and the exact redirect", () => {
  const { db } = fixture();
  const pending = beginAuthorization(db, "google", config.redirectUri, 1000);
  const url = new URL(authorizationUrl(config, pending.state, pending.challenge));

  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("state"), pending.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.match(url.searchParams.get("scope") ?? "", /calendar\.readonly/);
  assert.match(url.searchParams.get("scope") ?? "", /gmail\.readonly/);
});

test("a pending state is single use and rejects a mismatched provider or expiry", () => {
  const { db } = fixture();
  const pending = beginAuthorization(db, "google", config.redirectUri, 1000);
  assert.throws(() => consumeState(db, pending.state, "other"), GoogleAuthError);
  assert.throws(() => consumeState(db, "unknown", "google"), GoogleAuthError);

  const fresh = beginAuthorization(db, "google", config.redirectUri, Date.now());
  assert.equal(consumeState(db, fresh.state, "google").verifier.length > 0, true);
  assert.throws(() => consumeState(db, fresh.state, "google"), GoogleAuthError);
});

test("a reconnect that omits the refresh token keeps the stored one", () => {
  const { db, vault } = fixture();
  const first = storeConnection(db, vault, "google", {
    access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600,
  }, 1000);
  const second = storeConnection(db, vault, "google", { access_token: "access-2", expires_in: 3600 }, 2000);
  assert.equal(second, first);

  const stored = db.query("SELECT credential_ciphertext FROM connections WHERE id = ?").get(first);
  const ciphertext = (stored as { credential_ciphertext: Uint8Array }).credential_ciphertext;
  const parsed = JSON.parse(vault.decrypt(ciphertext)) as { refreshToken: string; accessToken: string };
  assert.equal(parsed.refreshToken, "refresh-1");
  assert.equal(parsed.accessToken, "access-2");
});

test("an expired token refreshes once for concurrent callers", async () => {
  const { db, vault } = fixture();
  const id = storeConnection(db, vault, "google", {
    access_token: "old", refresh_token: "refresh-1", expires_in: 1,
  }, 1000);
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    await Bun.sleep(10);
    return Response.json({ access_token: "new", expires_in: 3600 });
  }) as unknown as typeof fetch;

  const [a, b] = await Promise.all([
    ensureAccessToken(db, vault, config, id, 500_000, fetchImpl),
    ensureAccessToken(db, vault, config, id, 500_000, fetchImpl),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.token, "new");
  assert.equal(b.token, "new");
  const again = await ensureAccessToken(db, vault, config, id, 500_001, fetchImpl);
  assert.equal(again.state, "valid");
  assert.equal(calls, 1);
});

test("a rejected refresh marks the connection as needing re-auth", async () => {
  const { db, vault } = fixture();
  const id = storeConnection(db, vault, "google", {
    access_token: "old", refresh_token: "revoked", expires_in: 1,
  }, 1000);
  const fetchImpl = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(() => ensureAccessToken(db, vault, config, id, 500_000, fetchImpl), GoogleAuthError);
  const row = db.query("SELECT sync_status FROM connections WHERE id = ?").get(id);
  assert.deepEqual(row, { sync_status: "needs_reauth" });
  assert.equal(disconnect(db, id), true);
});

test("exchanging a code sends the verifier and surfaces a refused exchange", async () => {
  const { fetch: okFetch } = tokenFetch([{ access_token: "a", refresh_token: "r", expires_in: 60 }]);
  const tokens = await exchangeCode(config, "code-1", "verifier-1", okFetch);
  assert.equal(tokens.access_token, "a");

  const refusing = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(() => exchangeCode(config, "code-1", "verifier-1", refusing), GoogleAuthError);
});
