import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "../../src/db/store";
import { appendMessage, conversationRuns, createConversation, listConversations, messages } from "../../src/server/routes/conversations";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function database(): Database {
  const db = new Database(":memory:", { strict: true });
  migrate(db, migrations());
  databases.push(db);
  return db;
}

test("a repeated client request id returns the same message and run", () => {
  const db = database();
  const conversation = createConversation(db, "첫 대화");
  const requestId = crypto.randomUUID();
  const first = appendMessage(db, conversation.id, { text: "안녕", clientRequestId: requestId }, 1000);
  const second = appendMessage(db, conversation.id, { text: "안녕", clientRequestId: requestId }, 1001);

  assert.deepEqual(second, first);
  assert.equal(messages(db, conversation.id).length, 1);
  assert.equal(conversationRuns(db, conversation.id).length, 1);
});

test("a message for an unknown conversation is refused without writing a run", () => {
  const db = database();
  assert.throws(() => appendMessage(db, crypto.randomUUID(), { text: "x", clientRequestId: crypto.randomUUID() }));
  assert.equal(conversationRuns(db, crypto.randomUUID()).length, 0);
});

test("conversations list newest first and messages keep their order", () => {
  const db = database();
  const older = createConversation(db, "older", 1000);
  createConversation(db, "newer", 2000);
  appendMessage(db, older.id, { text: "first", clientRequestId: crypto.randomUUID() }, 1001);
  appendMessage(db, older.id, { text: "second", clientRequestId: crypto.randomUUID() }, 1002);

  assert.deepEqual(listConversations(db).map((row) => row.title), ["newer", "older"]);
  assert.deepEqual(messages(db, older.id).map((row) => row.content), ["first", "second"]);
  assert.equal(messages(db, older.id)[0]?.run_id !== null, true);
});
