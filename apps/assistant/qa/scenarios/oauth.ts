import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ensureAccessToken, GoogleAuthError, storeConnection, type GoogleConfig } from "../../src/integrations/google-auth";
import type { SecretVault } from "../../src/server/secrets";

type OAuthContext = {
  readonly db: Database;
  readonly vault: SecretVault;
  readonly evidence: string;
  readonly base: string;
  readonly cookie: string;
  readonly fixtureBase: string;
};

type TokenGrant = { grant_type: string; hasVerifier: boolean; hasRefresh: boolean };
let grants: TokenGrant[] = [];
let refreshRejects = false;
let issued = 0;

export function setOauthFixture(options: { readonly rejectRefresh?: boolean } = {}): void {
  grants = [];
  refreshRejects = options.rejectRefresh ?? false;
  issued = 0;
}

export async function oauthTokenFetch(request: Request): Promise<Response> {
  const form = await request.formData();
  const grantType = String(form.get("grant_type") ?? "");
  grants.push({
    grant_type: grantType,
    hasVerifier: form.has("code_verifier"),
    hasRefresh: form.has("refresh_token"),
  });
  if (grantType === "authorization_code") {
    issued += 1;
    return Response.json({
      access_token: `access-${issued}`, refresh_token: `refresh-${issued}`,
      expires_in: 3600, scope: "calendar.readonly gmail.readonly",
    });
  }
  if (grantType === "refresh_token") {
    if (refreshRejects) return Response.json({ error: "invalid_grant" }, { status: 400 });
    issued += 1;
    return Response.json({ access_token: `access-${issued}`, expires_in: 3600 });
  }
  return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
}

export const oauthConfig: GoogleConfig = {
  clientId: "qa-client",
  clientSecret: "qa-secret",
  redirectUri: "http://127.0.0.1:4317/api/oauth/google/callback",
  authUrl: "http://127.0.0.1:4318/oauth/auth",
  tokenUrl: "http://127.0.0.1:4318/oauth/token",
};

async function expireCredential(context: OAuthContext, connectionId: string): Promise<void> {
  const row = context.db.query("SELECT credential_ciphertext FROM connections WHERE id = ?").get(connectionId);
  const ciphertext = z.object({ credential_ciphertext: z.instanceof(Uint8Array) }).parse(row).credential_ciphertext;
  const credential = z.object({
    accessToken: z.string(), refreshToken: z.string().nullable(),
    expiresAt: z.number(), scope: z.string(),
  }).parse(JSON.parse(context.vault.decrypt(ciphertext)));
  context.db.query("UPDATE connections SET credential_ciphertext = ? WHERE id = ?")
    .run(context.vault.encrypt(JSON.stringify({ ...credential, expiresAt: 1_000 })), connectionId);
}

export async function oauthCodeRefresh(context: OAuthContext): Promise<void> {
  setOauthFixture();
  const start = await fetch(`${context.base}/api/oauth/google/start`, {
    headers: { cookie: context.cookie }, redirect: "manual",
  });
  assert.equal(start.status, 302);
  const location = start.headers.get("location");
  assert.ok(location);
  const authUrl = new URL(location);
  assert.equal(authUrl.searchParams.get("access_type"), "offline");
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  const state = authUrl.searchParams.get("state");
  assert.ok(state);

  const callback = await fetch(
    `${context.base}/api/oauth/google/callback?code=qa-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: context.cookie }, redirect: "manual" },
  );
  assert.equal(callback.status, 303);
  assert.deepEqual(grants.map((grant) => grant.grant_type), ["authorization_code"]);
  assert.equal(grants[0]?.hasVerifier, true);

  const connected = z.object({
    connections: z.array(z.object({ id: z.string(), provider: z.string(), status: z.string(), scopes: z.array(z.string()) })),
  }).parse(await (await fetch(`${context.base}/api/connections`, { headers: { cookie: context.cookie } })).json());
  const google = connected.connections.find((entry) => entry.provider === "google");
  assert.ok(google);
  assert.equal(google.status, "valid");
  assert.equal(google.scopes.some((scope) => scope.includes("calendar.readonly")), true);

  await expireCredential(context, google.id);
  const refreshed = await ensureAccessToken(context.db, context.vault, oauthConfig, google.id);
  assert.equal(refreshed.state, "refreshed");
  assert.equal(grants.filter((grant) => grant.grant_type === "refresh_token").length, 1);
  assert.equal(grants.at(-1)?.hasRefresh, true);

  const after = z.object({
    connections: z.array(z.object({ status: z.string() })),
  }).parse(await (await fetch(`${context.base}/api/connections`, { headers: { cookie: context.cookie } })).json());
  assert.equal(after.connections[0]?.status, "valid");

  await writeFile(join(context.evidence, "redacted-http.json"), `${JSON.stringify({
    startStatus: start.status,
    authorizeParams: {
      access_type: authUrl.searchParams.get("access_type"),
      prompt: authUrl.searchParams.get("prompt"),
      code_challenge_method: authUrl.searchParams.get("code_challenge_method"),
      redirect_uri: authUrl.searchParams.get("redirect_uri"),
      scope: authUrl.searchParams.get("scope"),
    },
    callbackStatus: callback.status,
    tokenGrants: grants,
    connectionStatus: google.status,
    refreshProducedToken: refreshed.state,
  }, null, 2)}\n`);
}

export async function oauthStateRevocation(context: OAuthContext): Promise<void> {
  setOauthFixture();
  const wrongState = await fetch(`${context.base}/api/oauth/google/callback?code=qa-code&state=forged`, {
    headers: { cookie: context.cookie }, redirect: "manual",
  });
  assert.equal(wrongState.status, 403);

  const start = await fetch(`${context.base}/api/oauth/google/start`, {
    headers: { cookie: context.cookie }, redirect: "manual",
  });
  const location = start.headers.get("location");
  assert.ok(location);
  const state = new URL(location).searchParams.get("state");
  assert.ok(state);
  const firstUse = await fetch(
    `${context.base}/api/oauth/google/callback?code=qa-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: context.cookie }, redirect: "manual" },
  );
  assert.equal(firstUse.status, 303);
  const replay = await fetch(
    `${context.base}/api/oauth/google/callback?code=qa-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: context.cookie }, redirect: "manual" },
  );
  assert.equal(replay.status, 403);

  const connected = z.object({ connections: z.array(z.object({ id: z.string(), status: z.string() })) })
    .parse(await (await fetch(`${context.base}/api/connections`, { headers: { cookie: context.cookie } })).json());
  const id = connected.connections[0]?.id;
  assert.ok(id);

  setOauthFixture({ rejectRefresh: true });
  await expireCredential(context, id);
  await assert.rejects(() => ensureAccessToken(context.db, context.vault, oauthConfig, id), GoogleAuthError);
  const broken = z.object({ connections: z.array(z.object({ status: z.string() })) })
    .parse(await (await fetch(`${context.base}/api/connections`, { headers: { cookie: context.cookie } })).json());
  assert.equal(broken.connections[0]?.status, "needs_reauth");

  const bodies = await Promise.all([
    fetch(`${context.base}/api/connections`, { headers: { cookie: context.cookie } }).then((r) => r.text()),
    fetch(`${context.base}/api/oauth/google/start`, { headers: { cookie: context.cookie }, redirect: "manual" })
      .then((r) => r.text()),
  ]);
  for (const body of bodies) {
    assert.equal(body.includes("qa-secret"), false);
    assert.equal(body.includes("refresh-1"), false);
  }

  await writeFile(join(context.evidence, "failures.json"), `${JSON.stringify({
    wrongState: wrongState.status, replayedState: replay.status,
    refreshGrantRejected: broken.connections[0]?.status,
    leakedSecretInResponses: false,
  }, null, 2)}\n`);
}

void storeConnection;
