import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EventLog } from "../src/events/log";
import { handleWorkflowRequest } from "../src/server/workflow-routes";
import { migrate } from "../src/store/db";
import { WorkflowsResponseSchema } from "../web/src/workflows/workflowTypes";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  db.query("DELETE FROM schedules").run();
  db.query("DELETE FROM workflows").run();
  db.query("DELETE FROM workflows_fts").run();
  const events = new EventLog(db);
  return { deps: { db, events } };
}

function request(method: string, path: string, payload?: unknown): Request {
  return new Request(`http://harness.local${path}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  });
}

// The screen is only as good as its schema: every payload the server actually sends
// for a search mode must parse. A nullable score (keyword, regex, plain listing)
// once failed here and left the whole tab showing a load error instead of the list.
describe("workflow web schema", () => {
  test("parses the list for every search mode the server offers", async () => {
    const { deps } = setup();
    const created = await handleWorkflowRequest(
      request("POST", "/api/workflows", {
        title: "아침 정리",
        instruction: "받은 편지를 정리한다",
        executor: { kind: "agent" },
      }),
      deps,
    );
    expect(created?.status).toBe(201);

    for (const query of ["", "?keyword=편지", "?regex=편지", "?bm25=편지를"]) {
      const response = await handleWorkflowRequest(request("GET", `/api/workflows${query}`), deps);
      const parsed = WorkflowsResponseSchema.safeParse(await response?.json());
      expect({ query, ok: parsed.success, issues: parsed.error?.issues ?? null }).toMatchObject({
        query,
        ok: true,
      });
      expect(parsed.data?.workflows).toHaveLength(1);
    }
  });
});
