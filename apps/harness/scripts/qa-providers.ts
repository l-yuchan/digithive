/**
 * Two local OpenAI-compatible endpoints for provider-routing QA, free and offline.
 *
 *   :8796 primary  answers the first N requests with a quota envelope (HTTP 429,
 *                  "usage limit reached") and then streams normally
 *   :8797 backup   always streams a marked answer, and counts its calls
 *
 * It prints one JSON line per request so the QA run proves which route answered.
 */
const PRIMARY_PORT = Number(process.env["QA_PRIMARY_PORT"] ?? "8796");
const BACKUP_PORT = Number(process.env["QA_BACKUP_PORT"] ?? "8797");
const QUOTA_TIMES = Number(process.env["QA_QUOTA_TIMES"] ?? "1000");

function streamAnswer(label: string): Response {
  const encoder = new TextEncoder();
  const frame = (payload: unknown): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame({ choices: [{ delta: { content: `[${label}] ` } }] }));
      controller.enqueue(
        frame({ choices: [{ delta: { content: "연결된 경로에서 답했습니다." } }] }),
      );
      controller.enqueue(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const quota = (label: string) =>
  new Response(
    JSON.stringify({
      type: "GoUsageLimitError",
      message: `${label} usage limit reached (5-hour, resets in 31m)`,
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );

let primaryCalls = 0;

function handler(label: string, reply: () => Response) {
  return (request: Request): Response => {
    if (new URL(request.url).pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }
    const response = reply();
    console.log(
      JSON.stringify({
        route: label,
        method: request.method,
        status: response.status,
        at: Date.now(),
      }),
    );
    return response;
  };
}

const primary = Bun.serve({
  port: PRIMARY_PORT,
  fetch: handler("primary", () => {
    primaryCalls += 1;
    return primaryCalls <= QUOTA_TIMES ? quota("primary") : streamAnswer("primary");
  }),
});
const backup = Bun.serve({
  port: BACKUP_PORT,
  fetch: handler("backup", () => streamAnswer("backup")),
});

console.log(
  JSON.stringify({
    ready: true,
    primary: primary.port,
    backup: backup.port,
    quotaTimes: QUOTA_TIMES,
  }),
);

async function stop(): Promise<void> {
  await primary.stop(true);
  await backup.stop(true);
}
const shutdown = (): void => {
  stop().catch((error: unknown) => console.error("qa-providers stop failed", error));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
