import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, loadConfig } from "../src/server/main";

const DocumentSchema = z.object({
  id: z.string(),
  path: z.string(),
  kind: z.enum(["record", "thread", "commitment", "watch"]),
  title: z.string(),
  text: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.string(),
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "whiteboard-http-"));
  const harness = createHarness(
    loadConfig({
      HARNESS_DB: join(root, "db.sqlite"),
      HARNESS_WORKSPACE: join(root, "workspace"),
      HARNESS_PASSPHRASE: "whiteboard-test",
      HARNESS_SESSION_SECRET: "whiteboard-secret",
    }),
  );
  const cookie = async () => {
    const response = await harness.handler(
      new Request("http://local/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "whiteboard-test" }),
      }),
    );
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  };
  const api = async (token: string, path: string, method = "GET", body?: unknown) => {
    const response = await harness.handler(
      new Request(`http://local${path}`, {
        method,
        headers: {
          cookie: token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          origin: "http://local",
          host: "local",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return response;
  };
  return {
    root,
    harness,
    cookie,
    api,
    cleanup: () => {
      harness.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("authenticated whiteboard HTTP creates and finds a Korean note", async () => {
  // Given an unauthenticated caller and the real login endpoint.
  const context = setup();
  try {
    expect((await context.api("", "/api/whiteboard")).status).toBe(401);
    const token = await context.cookie();
    // When a Korean note is created through the product API.
    const response = await context.api(token, "/api/whiteboard", "POST", {
      path: "threads/notes/current-time",
      kind: "thread",
      title: "현재 발표 시각",
      text: "발표는 14시에 시작합니다.",
    });
    expect(response.status).toBe(201);
    const { document } = z.object({ document: DocumentSchema }).parse(await response.json());
    // Then list search and the full read return the same canonical document.
    const found = await context.api(token, "/api/whiteboard?query=발표");
    expect(found.status).toBe(200);
    const listBody = z
      .object({ documents: z.array(z.object({ id: z.string() })) })
      .parse(await found.json());
    expect(listBody.documents.map((entry) => entry.id)).toContain(document.id);
    const read = await context.api(token, `/api/whiteboard/${encodeURIComponent(document.id)}`);
    expect(read.status).toBe(200);
    expect(z.object({ document: DocumentSchema }).parse(await read.json()).document).toMatchObject(
      document,
    );
  } finally {
    context.cleanup();
  }
});

test("whiteboard HTTP updates task state only from the current hash", async () => {
  // Given a commitment created through the API.
  const context = setup();
  try {
    const token = await context.cookie();
    const response = await context.api(token, "/api/whiteboard", "POST", {
      path: "commitments/notes/reading",
      kind: "commitment",
      title: "읽기 목록 정리",
      text: "논문 한 편을 읽습니다.",
    });
    const { document } = z.object({ document: DocumentSchema }).parse(await response.json());
    expect(document.status).toBe("open");
    // When its current revision moves to in_progress and that old revision is reused.
    const accepted = await context.api(
      token,
      `/api/whiteboard/${encodeURIComponent(document.id)}`,
      "PATCH",
      { expectedHash: document.hash, status: "in_progress" },
    );
    expect(accepted.status).toBe(200);
    const stale = await context.api(
      token,
      `/api/whiteboard/${encodeURIComponent(document.id)}`,
      "PATCH",
      { expectedHash: document.hash, status: "done" },
    );
    // Then the second write is a conflict and the first task state survives.
    expect(stale.status).toBe(409);
    const read = await context.api(token, `/api/whiteboard/${document.id}`);
    expect(z.object({ document: DocumentSchema }).parse(await read.json()).document.status).toBe(
      "in_progress",
    );
  } finally {
    context.cleanup();
  }
});

test("whiteboard HTTP refuses traversal without creating an outside file", async () => {
  // Given a logged-in caller.
  const context = setup();
  try {
    const token = await context.cookie();
    // When a path tries to escape the thread root.
    const response = await context.api(token, "/api/whiteboard", "POST", {
      path: "threads/../../escape",
      kind: "thread",
      title: "escape",
      text: "must not exist",
    });
    // Then the request is refused with no artifact outside the whiteboard.
    expect(response.status).toBe(422);
    expect(existsSync(join(context.root, "workspace", "escape.md"))).toBe(false);
    expect(existsSync(join(context.root, "escape.md"))).toBe(false);
  } finally {
    context.cleanup();
  }
});
