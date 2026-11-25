import { z } from "zod";

export const GMAIL_QUERY = "newer_than:7d newsletter";
const ModelBody = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string().nullable().optional() })),
  tools: z
    .array(z.object({ type: z.string().optional(), function: z.object({ name: z.string() }) }))
    .optional(),
});

export function startFakeModel(
  call: { name: string; arguments: Record<string, unknown> } = {
    name: "gmail_search",
    arguments: { query: GMAIL_QUERY, limit: 2 },
  },
  reply = "뉴스레터 요약을 마쳤습니다.",
) {
  const requests: z.infer<typeof ModelBody>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = ModelBody.parse(await request.json());
      requests.push(body);
      const choice = body.messages.some((message) => message.role === "tool")
        ? { delta: { content: reply }, finish_reason: "stop" }
        : {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-tool",
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                },
              ],
            },
            finish_reason: "tool_calls",
          };
      return new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

/** Only Google hosts are replaced; the model endpoint still uses actual HTTP. */
export function installFakeGoogle() {
  const real = globalThis.fetch;
  const calls: URL[] = [];
  const detailIds: string[] = [];
  const ids = ["m1", "m2", "m3", "m4"];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(href);
      if (url.hostname !== "gmail.googleapis.com" && url.hostname !== "oauth2.googleapis.com")
        return real(input, init);
      calls.push(url);
      if (url.hostname === "oauth2.googleapis.com")
        return Response.json({ access_token: "refreshed-at", expires_in: 3_600 });
      if (url.pathname === "/gmail/v1/users/me/messages") {
        const max = Number(url.searchParams.get("maxResults") ?? "5");
        return Response.json({ messages: ids.slice(0, max).map((id) => ({ id })) });
      }
      const match = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
      if (match) {
        const rawId = match[1];
        if (rawId === undefined) throw new Error("missing message id");
        const id = decodeURIComponent(rawId);
        detailIds.push(id);
        return Response.json({
          id,
          internalDate: "1795500000000",
          payload: {
            headers: [{ name: "Subject", value: `뉴스레터 ${id}` }],
            body: { data: Buffer.from(`본문 ${id}`).toString("base64url") },
          },
        });
      }
      return Response.json({ error: "unexpected_google_call" }, { status: 404 });
    },
    { preconnect: fetch.preconnect },
  );
  return {
    calls,
    detailIds,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}
