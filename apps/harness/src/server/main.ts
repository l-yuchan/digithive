import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRuntime, loadConfig } from "../runtime";
import { createRegistry } from "../tools/registry";
import { settleExpiredRuns } from "../core/run-state";
import { reconcileWork } from "../surfaces/work/runner";
import { ensureCollectionWorkflows } from "../workflows/collection";
import { createApp, type AppDeps } from "./app";
import { createConversation } from "../surfaces/conversation/surface";
import { startTitleRun, titleHooks } from "../workflows/title-run";
import type { ConversationDeps } from "../surfaces/conversation/loop";

export type HarnessConfig = ReturnType<typeof loadConfig>;

/** The web build id written by `build:web`; absent or unreadable stays "unknown". */
export function readBuildId(webRoot: string): string {
  const path = resolve(webRoot, "build.json");
  if (!existsSync(path)) return "unknown";
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "string")
      return parsed.id;
  } catch {
    // a half-written or hand-edited file must never stop the server
  }
  return "unknown";
}

export { loadConfig };

export function createHarness(config: HarnessConfig): {
  deps: AppDeps;
  handler: (request: Request) => Promise<Response>;
  close: () => void;
  work: AppDeps["work"];
  conversationDeps: () => ConversationDeps;
} {
  const runtime = createRuntime(config);
  const { db, events, stream } = runtime.work;

  const summarize = async (transcript: string): Promise<string> => {
    let summary = "";
    for await (const event of stream(
      [
        {
          role: "system",
          content:
            "다음 대화를 나중에 맥락으로 쓸 수 있게 3~6문장으로 요약하세요. 사실만 남기고 추측은 넣지 마세요.",
        },
        { role: "user", content: transcript },
      ],
      [],
      { maxOutputTokens: 512, firstTokenTimeoutMs: 30_000, idleTimeoutMs: 60_000 },
    )) {
      if (event.type === "text_delta") summary += event.text;
    }
    return summary;
  };

  const conversationDeps: ConversationDeps = {
    db,
    events,
    stream,
    tools: createRegistry(runtime.work.tools.tools.filter((tool) => tool.conversation)),
    summarize,
    maxChars: config.maxChars,
  };
  const titleDeps = { db, events };
  const conversation = createConversation({
    db,
    events,
    turnDeps: () => conversationDeps,
    startTitle: (sessionId) => startTitleRun(titleDeps, deps.work, sessionId),
  });

  const deps: AppDeps = {
    db,
    events,
    conversation,
    work: {
      ...runtime.work,
      hooks: titleHooks(titleDeps),
    },
    whiteboard: runtime.whiteboard,
    google: {
      db,
      events,
      vaultSecret: config.sessionSecret,
      config: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        redirectUri: config.googleRedirectUri,
      },
    },
    canvas: { db, events, config: { baseUrl: config.canvasBaseUrl, token: config.canvasToken } },
    vapid: {
      publicKey: config.vapidPublicKey,
      privateKey: config.vapidPrivateKey,
      subject: config.vapidSubject,
    },
    webRoot: resolve(config.webRoot),
    buildId: readBuildId(config.webRoot),
    filesRoot: config.filesRoot,
    maxUploadBytes: config.maxUploadBytes,
    auth: { passphrase: config.passphrase, secret: config.sessionSecret },
  };
  return {
    deps,
    handler: createApp(deps),
    close: () => {
      conversation.close();
      runtime.close();
    },
    work: deps.work,
    /** The turn dependencies without the app's settle hook: what a single turn needs. */
    conversationDeps: () => conversationDeps,
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const harness = createHarness(config);
  const reconciled = settleExpiredRuns(harness.deps.db);
  for (const runId of reconciled) {
    harness.deps.events.append({
      kind: "run.interrupted",
      runId,
      payload: { reason: "host_restart" },
    });
  }
  setInterval(() => {
    const result = reconcileWork(harness.deps.db, harness.deps.events);
    if (result.interrupted > 0) console.log(`reconciled ${result.interrupted} interrupted run(s)`);
  }, 15_000).unref();
  // Every account needs its collection workflow, including accounts that were
  // connected while this app was not running.
  const created = ensureCollectionWorkflows(harness.deps.db, harness.deps.events);
  if (created > 0) console.log(`created ${created} collection workflow(s)`);
  // A conversation can be silent for longer than any fixed idle limit while a model
  // thinks or a tool runs; a live event stream must outlast that silence.
  const server = Bun.serve({ port: config.port, idleTimeout: 0, fetch: harness.handler });
  console.log(
    `digithive harness on http://127.0.0.1:${server.port} (model ${config.model} @ ${config.baseUrl})`,
  );
}
