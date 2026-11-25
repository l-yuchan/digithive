import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, loadConfig } from "../src/server/main";
import { createApp } from "../src/server/app";
import { COOKIE_NAME, issueCookie } from "../src/server/auth";
import { createOAuthState, OAUTH_STATE_TTL_MS } from "../src/integrations/accounts";
import { saveTokens, loadTokens } from "../src/integrations/google";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "account-http-"));
  const harness = createHarness(
    loadConfig({
      HARNESS_DB: join(root, "db.sqlite"),
      HARNESS_WORKSPACE: join(root, "workspace"),
      HARNESS_PASSPHRASE: "test-passphrase",
      HARNESS_SESSION_SECRET: "test-secret",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
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

test("Google callbacks require a valid single-use challenge while account controls require login", async () => {
  const { harness, cleanup } = setup();
  try {
    const denied = await harness.handler(
      new Request("https://app.example/api/accounts/google-default/sources/gmail", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: '{"enabled":false}',
      }),
    );
    expect(denied.status).toBe(401);
    const state = createOAuthState(
      harness.deps.db,
      "google-default",
      Date.now() - OAUTH_STATE_TTL_MS - 1,
    );

    const expired = await harness.handler(
      new Request(`https://app.example/api/oauth/google/callback?code=unused&state=${state}`),
    );
    const replay = await harness.handler(
      new Request(`https://app.example/api/oauth/google/callback?code=unused&state=${state}`),
    );

    expect(expired.status).toBe(302);
    expect(new URL(expired.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "state_expired",
    );
    expect(new URL(replay.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "state_invalid",
    );
    expect(
      harness.deps.db
        .query(
          "SELECT enabled FROM account_sources WHERE account_id='google-default' AND source='gmail'",
        )
        .get(),
    ).toEqual({ enabled: 1 });
  } finally {
    cleanup();
  }
});

test("reconnecting an unidentified migrated account verifies its old mailbox before replacing tokens", async () => {
  const { harness, cleanup } = setup();
  try {
    saveTokens(harness.deps.db, "test-secret", {
      accessToken: "old-token",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 3_600_000,
      scope: null,
    });
    const state = createOAuthState(harness.deps.db, "google-default");
    const fetchImpl = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.includes("oauth2.googleapis.com/token"))
          return Response.json({
            access_token: "different-token",
            refresh_token: "different-refresh",
            expires_in: 3600,
          });
        if (url.includes("openidconnect.googleapis.com"))
          return Response.json({
            sub: "different-subject",
            email: "different@example.test",
            email_verified: true,
          });
        if (url.endsWith("/profile"))
          return Response.json({ emailAddress: "original@example.test" });
        throw new Error(`Unexpected request: ${url}`);
      },
      { preconnect: fetch.preconnect },
    );
    const app = createApp({ ...harness.deps, google: { ...harness.deps.google, fetchImpl } });
    const cookie = `${COOKIE_NAME}=${issueCookie(harness.deps.auth)}`;

    const response = await app(
      new Request(`https://app.example/api/oauth/google/callback?code=exchange&state=${state}`, {
        headers: { cookie },
      }),
    );

    expect(new URL(response.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "identity_mismatch",
    );
    expect(loadTokens(harness.deps.db, "test-secret")?.accessToken).toBe("old-token");
    expect(
      harness.deps.db
        .query("SELECT subject,email FROM integration_accounts WHERE id='google-default'")
        .get(),
    ).toEqual({
      subject: null,
      email: "original@example.test",
    });
  } finally {
    cleanup();
  }
});
