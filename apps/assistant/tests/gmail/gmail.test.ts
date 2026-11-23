import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { migrate, migrations } from "../../src/db/store";
import { SecretVault } from "../../src/server/secrets";
import { storeConnection, type GoogleConfig } from "../../src/integrations/google-auth";
import { gmailCursor, GmailSyncError, syncGmail } from "../../src/integrations/gmail";
import { extractMail, htmlToText } from "../../src/knowledge/mail-body";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const config: GoogleConfig = {
  clientId: "c", clientSecret: "s", redirectUri: "http://127.0.0.1:4317/cb",
  authUrl: "https://auth.example", tokenUrl: "https://token.example",
};

function fixture(): { db: Database; vault: SecretVault; connectionId: string } {
  const db = new Database(":memory:", { strict: true });
  migrate(db, migrations());
  databases.push(db);
  const vault = new SecretVault(Buffer.alloc(32, 9).toString("base64"));
  const connectionId = storeConnection(db, vault, "google", {
    access_token: "good", refresh_token: "refresh", expires_in: 100_000,
  }, 1000);
  return { db, vault, connectionId };
}

const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

const multipart = {
  id: "m1", threadId: "t1", labelIds: ["INBOX"], internalDate: "1762000000000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "Subject", value: "과제 안내" },
      { name: "From", value: "교수 <prof@example.com>" },
      { name: "To", value: "me@example.com" },
      { name: "Date", value: "Tue, 3 Nov 2026 09:00:00 +0900" },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: encode("12월 1일까지 제출하세요.") } },
      { mimeType: "text/html", body: { data: encode("<p>12월 1일까지 제출하세요.</p>") } },
    ],
  },
};

const htmlOnly = {
  id: "m2", labelIds: ["INBOX"],
  payload: {
    mimeType: "text/html",
    headers: [{ name: "Subject", value: "뉴스레터" }],
    body: {
      data: encode("<style>.x{}</style><p>오늘의 소식 <script>alert('x')</script> 끝 <b>강조</b></p>"),
    },
  },
};

test("plain text beats HTML and HTML is reduced without executing anything", () => {
  const mail = extractMail(multipart);
  assert.equal(mail.subject, "과제 안내");
  assert.equal(mail.text, "12월 1일까지 제출하세요.");
  assert.equal(mail.hasHtmlOnly, false);

  const newsletter = extractMail(htmlOnly);
  assert.equal(newsletter.hasHtmlOnly, true);
  assert.equal(newsletter.text.includes("alert"), false);
  assert.equal(newsletter.text.includes(".x{}"), false);
  assert.match(newsletter.text, /오늘의 소식/);
  assert.match(newsletter.text, /강조/);
});

test("a quoted command inside a mail stays data and long bodies are bounded", () => {
  const long = { ...htmlOnly, payload: { mimeType: "text/plain", body: { data: encode("rm -rf / \n" + "가".repeat(50_000)) } } };
  const mail = extractMail(long);
  assert.equal(mail.truncated, true);
  assert.equal(mail.text.length <= 40_000, true);
  assert.match(htmlToText("<a href=\"https://x\">링크</a>"), /링크/);
});

test("the first collection stores messages and catches up on arrivals", async () => {
  const { db, vault, connectionId } = fixture();
  const calls: string[] = [];
  const fetchFn = (async (input: URL | Request) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "1000" });
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m1" }] });
    if (url.pathname.endsWith("/messages/m1")) return Response.json(multipart);
    if (url.pathname.endsWith("/history")) {
      return Response.json({ historyId: "1005", history: [{ id: "1", messagesAdded: [{ message: { id: "m3" } }] }] });
    }
    if (url.pathname.endsWith("/messages/m3")) return Response.json({ ...multipart, id: "m3" });
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  const source = { connectionId, query: "newer_than:30d in:inbox", labelIds: ["INBOX"] };

  const result = await syncGmail(db, vault, config, source, fetchFn, () => 2_000);
  assert.equal(result.full, true);
  assert.equal(result.stored, 2);
  assert.equal(gmailCursor(db, source), "1005");
  assert.equal(calls.some((call) => call.includes("startHistoryId=1000")), true);
  const stored = z.object({ n: z.number() }).parse(db.query("SELECT count(*) AS n FROM source_items").get()).n;
  assert.equal(stored, 2);
});

test("an incremental sync stores only the changed message and advances the cursor", async () => {
  const { db, vault, connectionId } = fixture();
  let phase = 0;
  const fetchFn = (async (input: URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "1000" });
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m1" }] });
    if (url.pathname.endsWith("/messages/m1")) {
      return Response.json(phase >= 2 ? { ...multipart, labelIds: ["INBOX", "STARRED"] } : multipart);
    }
    if (url.pathname.endsWith("/history")) {
      phase += 1;
      if (phase === 1) return Response.json({ historyId: "1005", history: [] });
      return Response.json({
        historyId: "1010",
        history: [{ id: "2", labelsAdded: [{ message: { id: "m1" }, labelIds: ["STARRED"] }] }],
      });
    }
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  const source = { connectionId, query: "newer_than:30d in:inbox", labelIds: ["INBOX"] };
  await syncGmail(db, vault, config, source, fetchFn, () => 2_000);
  const second = await syncGmail(db, vault, config, source, fetchFn, () => 3_000);
  assert.equal(second.full, false);
  const versions = z.object({ n: z.number() }).parse(db.query("SELECT count(*) AS n FROM source_versions").get()).n;
  assert.equal(versions, 2, "a label change updates the message state once");
  const latest = z.object({ content_json: z.string() }).parse(
    db.query("SELECT content_json FROM source_versions ORDER BY observed_at DESC LIMIT 1").get(),
  );
  assert.match(latest.content_json, /STARRED/);
  assert.equal(gmailCursor(db, source), "1010");
});

test("an expired history id triggers a bounded full resync", async () => {
  const { db, vault, connectionId } = fixture();
  const source = { connectionId, query: "newer_than:30d in:inbox", labelIds: ["INBOX"] };
  let historyCalls = 0;
  const fetchFn = (async (input: URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "2000" });
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m2" }] });
    if (url.pathname.endsWith("/messages/m2")) return Response.json(htmlOnly);
    if (url.pathname.endsWith("/history")) {
      historyCalls += 1;
      if (historyCalls === 2) return Response.json({ error: "notFound" }, { status: 404 });
      return Response.json({ historyId: historyCalls === 1 ? "1005" : "2005", history: [] });
    }
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;

  await syncGmail(db, vault, config, source, fetchFn, () => 2_000);
  const result = await syncGmail(db, vault, config, source, fetchFn, () => 3_000);
  assert.equal(result.full, true);
  assert.equal(gmailCursor(db, source), "2005");
});

test("a failed message detail leaves the cursor and versions untouched", async () => {
  const { db, vault, connectionId } = fixture();
  const source = { connectionId, query: "newer_than:30d in:inbox", labelIds: ["INBOX"] };
  const fetchFn = (async (input: URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "3000" });
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m1" }, { id: "m9" }] });
    if (url.pathname.endsWith("/messages/m1")) return Response.json(multipart);
    if (url.pathname.endsWith("/history")) return Response.json({ historyId: "3005", history: [] });
    return Response.json({ error: "boom" }, { status: 500 });
  }) as unknown as typeof fetch;

  await assert.rejects(() => syncGmail(db, vault, config, source, fetchFn, () => 2_000), GmailSyncError);
  assert.equal(gmailCursor(db, source), undefined);
  assert.equal(z.object({ n: z.number() }).parse(db.query("SELECT count(*) AS n FROM source_items").get()).n, 0);
});
