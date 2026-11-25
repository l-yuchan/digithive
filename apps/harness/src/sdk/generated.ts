/**
 * The single-file SDK written into the scripts root at startup. A script is a
 * separate process, so it cannot import the harness: it talks to the run-scoped
 * loopback bridge through the two environment variables the bridge injects.
 *
 * Generated — do not edit the copy under `<scriptsRoot>/.digithive/sdk.ts`.
 */
export const SCRIPT_SDK_SOURCE = `/**
 * digithive script SDK (generated at startup; do not edit).
 *
 *   import { sdk } from "../.digithive/sdk.ts";
 *
 *   const context = await sdk.context();
 *   const hits = await sdk.memory.recall("회의");
 *   console.log(JSON.stringify(hits));
 *
 * Only the tools granted to this workflow's capabilities are reachable; anything
 * else answers with an error instead of running.
 */
const baseUrl = process.env["DIGITHIVE_SDK_URL"] ?? "";
const token = process.env["DIGITHIVE_SDK_TOKEN"] ?? "";

export type ToolInfo = { name: string; description: string; parameters: unknown };
export type WorkflowContext = {
  runId: string;
  workflowId: string | null;
  workflowTitle: string | null;
  params: Record<string, unknown>;
  expiresAt: string;
};

type Json = Record<string, unknown>;

async function request(path: string, init?: RequestInit): Promise<Json> {
  if (baseUrl.length === 0 || token.length === 0) {
    throw new Error("DIGITHIVE_SDK_TOKEN: 이 스크립트는 워크플로 실행으로 시작되지 않았습니다.");
  }
  const response = await fetch(\`\${baseUrl}\${path}\`, {
    ...init,
    headers: {
      authorization: \`Bearer \${token}\`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: Json = {};
  try {
    body = JSON.parse(text) as Json;
  } catch {
    body = { error: text };
  }
  if (!response.ok || body["ok"] === false) {
    throw new Error(\`\${path} 실패: \${JSON.stringify(body)}\`);
  }
  return body;
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export const sdk = {
  tools: async (): Promise<ToolInfo[]> => (await request("/sdk/tools"))["tools"] as ToolInfo[],
  context: (): Promise<WorkflowContext> => request("/sdk/context") as Promise<WorkflowContext>,
  call: async (name: string, args: Json = {}): Promise<unknown> => {
    const body = await request("/sdk/call", {
      method: "POST",
      body: JSON.stringify({ name, args }),
    });
    return parse(body["result"]);
  },
  workflow: {
    list: (query: Json = {}) => sdk.call("workflow_list", query),
    detail: (id: string, filter?: string[]) =>
      sdk.call("workflow_detail", filter === undefined ? { id } : { id, filter }),
    create: (input: Json) => sdk.call("workflow_create", input),
    edit: (id: string, delta: Json, force = false) => sdk.call("workflow_edit", { id, delta, force }),
    delete: (id: string, cascade = false) => sdk.call("workflow_delete", { id, cascade }),
    run: (id: string, args: Json = {}, options: { async?: boolean } = {}) =>
      sdk.call("workflow_run", { id, args, async: options.async ?? false }),
  },
  schedule: {
    list: (workflowId?: string) => sdk.call("schedule_list", workflowId ? { workflowId } : {}),
    detail: (id: string) => sdk.call("schedule_detail", { id }),
    create: (input: Json) => sdk.call("schedule_create", input),
    edit: (id: string, delta: Json) => sdk.call("schedule_edit", { id, delta }),
    delete: (id: string) => sdk.call("schedule_delete", { id }),
  },
  memory: {
    recall: (query: string) => sdk.call("memory_recall", { query }),
    note: (kind: "fact" | "hypothesis", text: string) => sdk.call("memory_note", { kind, text }),
    correct: (id: string, text: string) => sdk.call("memory_correct", { id, text }),
  },
  mail: {
    search: (query: string, options: { limit?: number; accountId?: string } = {}) =>
      sdk.call("gmail_search", { query, ...options }),
    send: (title: string, body: string) => sdk.call("push_send", { title, body }),
  },
  accounts: {
    list: (accountId?: string) =>
      sdk.call("account_list", accountId ? { accountId } : {}),
    collect: (source: string, accountId: string) =>
      sdk.call("source_collect", { source, accountId }),
  },
  briefing: {
    compose: () => sdk.call("briefing_compose", {}),
  },
  files: {
    list: () => sdk.call("stored_file_list", {}),
    read: (id: string) => sdk.call("stored_file_read", { id }),
  },
};

export default sdk;
`;

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function sdkFilePath(scriptsRoot: string): string {
  return join(scriptsRoot, ".digithive", "sdk.ts");
}

/** Rewrites the generated SDK only when its content changed. */
export function syncSdkFile(scriptsRoot: string): string {
  const path = sdkFilePath(scriptsRoot);
  mkdirSync(join(scriptsRoot, ".digithive"), { recursive: true });
  if (!existsSync(path) || readFileSync(path, "utf8") !== SCRIPT_SDK_SOURCE) {
    writeFileSync(path, SCRIPT_SDK_SOURCE, "utf8");
  }
  return path;
}
