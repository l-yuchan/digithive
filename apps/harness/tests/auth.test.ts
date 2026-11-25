import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { createRegistry } from "../src/tools/registry";
import { createApp, type AppDeps } from "../src/server/app";
import { createConversation } from "../src/surfaces/conversation/surface";
import {
  COOKIE_NAME,
  checkPassphrase,
  isPublicRoute,
  issueCookie,
  readCookie,
  verifyCookie,
} from "../src/server/auth";
import type { StreamFn } from "../src/providers/openai";

import { enqueueRun, type WorkDeps } from "../src/surfaces/work/runner";

const auth = { passphrase: "correct horse", secret: "test-secret-value" };
const idle: StreamFn = async function* () {};
const resources: { db: Database; webRoot: string; close: () => void }[] = [];
afterAll(() => {
  for (const resource of resources) {
    resource.close();
    resource.db.close();
    rmSync(resource.webRoot, { recursive: true, force: true });
  }
});

function deps(overrides: { passphrase?: string } = {}): AppDeps {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const events = new EventLog(db);
  const conversation = createConversation({
    db,
    events,
    turnDeps: () => ({ db, events, stream: idle, tools: createRegistry([]) }),
  });
  const work: WorkDeps = { db, events, stream: idle, tools: createRegistry([]), policy: [] };
  const webRoot = mkdtempSync(join(tmpdir(), "harness-web-"));
  resources.push({ db, webRoot, close: conversation.close });
  return {
    db,
    events,
    conversation,
    work,
    webRoot,
    buildId: "test-build",
    auth: { passphrase: overrides.passphrase ?? auth.passphrase, secret: auth.secret },
    google: {
      db,
      events,
      vaultSecret: auth.secret,
      config: {
        clientId: "id",
        clientSecret: "secret",
        redirectUri: "http://local/api/oauth/google/callback",
      },
    },
    canvas: { db, events, config: { baseUrl: "", token: "" } },
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@local" },
  };
}

describe("auth primitives", () => {
  test("passphrase comparison is exact", () => {
    expect(checkPassphrase(auth, "correct horse")).toBe(true);
    expect(checkPassphrase(auth, "correct horse ")).toBe(false);
    expect(checkPassphrase({ ...auth, passphrase: "" }, "anything")).toBe(true);
  });

  test("cookies verify, reject tampering, and expire", () => {
    const now = Date.parse("2026-11-24T00:00:00Z");
    const cookie = issueCookie(auth, now);
    expect(verifyCookie(auth, cookie, now)).toBe(true);
    expect(verifyCookie(auth, `${cookie}x`, now)).toBe(false);
    expect(verifyCookie(auth, null, now)).toBe(false);
    const expired = issueCookie({ ...auth, ttlMs: -1 }, now);
    expect(verifyCookie(auth, expired, now)).toBe(false);
  });

  test("the cookie parser handles a real header", () => {
    expect(readCookie(`other=1; ${COOKIE_NAME}=abc.def; tail=2`)).toBe("abc.def");
    expect(readCookie("other=1")).toBeNull();
  });

  test("only the shell and session endpoints are public", () => {
    expect(isPublicRoute("/", "GET")).toBe(true);
    expect(isPublicRoute("/api/session", "GET")).toBe(true);
    expect(isPublicRoute("/api/login", "POST")).toBe(true);
    expect(isPublicRoute("/api/sessions", "GET")).toBe(false);
    expect(isPublicRoute("/api/runs", "POST")).toBe(false);
  });
});

describe("auth gate on the server", () => {
  const app = createApp(deps());

  test("an API call without a cookie is rejected", async () => {
    const response = await app(new Request("http://local/api/sessions"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  test("a wrong passphrase is rejected and the right one sets an HttpOnly cookie", async () => {
    const bad = await app(
      new Request("http://local/api/login", {
        method: "POST",
        body: JSON.stringify({ passphrase: "nope" }),
      }),
    );
    expect(bad.status).toBe(401);

    const good = await app(
      new Request("http://local/api/login", {
        method: "POST",
        body: JSON.stringify({ passphrase: auth.passphrase }),
      }),
    );
    expect(good.status).toBe(200);
    const setCookie = good.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    const cookie = readCookie(setCookie);
    expect(verifyCookie(auth, cookie)).toBe(true);

    const authed = await app(
      new Request("http://local/api/sessions", { headers: { cookie: `${COOKIE_NAME}=${cookie}` } }),
    );
    expect(authed.status).toBe(200);
  });

  test("the Google start endpoint redirects the browser instead of returning JSON", async () => {
    const authed = createApp(deps());
    const login = await authed(
      new Request("http://local/api/login", {
        method: "POST",
        body: JSON.stringify({ passphrase: auth.passphrase }),
      }),
    );
    const cookie = readCookie(login.headers.get("set-cookie"));
    const response = await authed(
      new Request("http://local/api/oauth/google/start", {
        headers: { cookie: `${COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    expect(location).toContain("redirect_uri=http%3A%2F%2Flocal%2Fapi%2Foauth%2Fgoogle%2Fcallback");
  });

  test("the shell stays reachable so the client can render its gate", async () => {
    const fixture = deps();
    const shell = await Bun.file(join(import.meta.dir, "../web/index.html")).text();
    await Bun.write(join(fixture.webRoot, "index.html"), shell);
    // "/" now names the chat tab, so the shell is reached through its own path.
    const root = await createApp(fixture)(new Request("http://local/"));
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/chat");
    const response = await createApp(fixture)(new Request("http://local/chat"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe(shell);
  });

  test("delegation API rejects missing and non-finite budgets instead of creating a child", async () => {
    const fixture = deps({ passphrase: "" });
    const delegationApp = createApp(fixture);
    // Runs start from conversation and schedule execution; the API path is the
    // delegation endpoint the test is about.
    const body = enqueueRun(fixture.db, fixture.events, { goal: "parent", origin: "work" });
    for (const budget of [undefined, {}, { maxMicroUsd: -1, maxToolCalls: 1 }]) {
      const result = await delegationApp(
        new Request(`http://local/api/runs/${body.id}/delegate`, {
          method: "POST",
          body: JSON.stringify({
            goal: "child",
            inputRefs: ["mail:1"],
            completionCondition: "done",
            permissionProfile: "read-only",
            budget,
          }),
        }),
      );
      expect(result.status).toBe(422);
    }
    expect(
      fixture.db.query("SELECT count(*) AS n FROM runs WHERE origin='delegation'").get(),
    ).toEqual({ n: 0 });
  });
});
