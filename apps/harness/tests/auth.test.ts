import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { createRegistry } from "../src/tools/registry";
import { createApp, type AppDeps } from "../src/server/app";
import { COOKIE_NAME, checkPassphrase, isPublicRoute, issueCookie, readCookie, verifyCookie } from "../src/server/auth";
import type { StreamFn } from "../src/providers/openai";
import type { ConversationDeps } from "../src/surfaces/conversation/loop";
import type { WorkDeps } from "../src/surfaces/work/runner";

const auth = { passphrase: "correct horse", secret: "test-secret-value" };
const idle: StreamFn = async function* () {};

function deps(overrides: { passphrase?: string } = {}): AppDeps {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const events = new EventLog(db);
  const conversation: ConversationDeps = { db, events, stream: idle, tools: createRegistry([]) };
  const work: WorkDeps = { db, events, stream: idle, tools: createRegistry([]), policy: [] };
  return {
    db,
    events,
    conversation,
    work,
    webRoot: mkdtempSync(join(tmpdir(), "harness-web-")),
    auth: { passphrase: overrides.passphrase ?? auth.passphrase, secret: auth.secret },
    google: { db, events, vaultSecret: auth.secret, config: { clientId: "id", clientSecret: "secret", redirectUri: "http://local/api/oauth/google/callback" } },
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
    const bad = await app(new Request("http://local/api/login", { method: "POST", body: JSON.stringify({ passphrase: "nope" }) }));
    expect(bad.status).toBe(401);

    const good = await app(new Request("http://local/api/login", { method: "POST", body: JSON.stringify({ passphrase: auth.passphrase }) }));
    expect(good.status).toBe(200);
    const setCookie = good.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    const cookie = readCookie(setCookie);
    expect(verifyCookie(auth, cookie)).toBe(true);

    const authed = await app(new Request("http://local/api/sessions", { headers: { cookie: `${COOKIE_NAME}=${cookie}` } }));
    expect(authed.status).toBe(200);
  });

  test("the shell stays reachable so the client can render its gate", async () => {
    const response = await app(new Request("http://local/"));
    expect(response.status).toBe(404); // no build in the temp webRoot, but not 401
  });
});
