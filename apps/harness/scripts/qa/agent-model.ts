import { z } from "zod";

export type AgentFixtureMessage = { readonly role: string; readonly content: string };
export type AgentFixtureStep =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly args: Record<string, unknown> };

const MessagesSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});
const encoder = new TextEncoder();

function stream(chunks: readonly unknown[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } },
  );
}

function assistantRole() {
  return { choices: [{ delta: { role: "assistant" }, finish_reason: null }] };
}

function usage(text: string) {
  return {
    choices: [],
    usage: { prompt_tokens: 20, completion_tokens: Math.max(1, text.length / 4) },
  };
}

export function modelToolCall(name: string, args: Record<string, unknown>): AgentFixtureStep {
  return { kind: "tool", name, args };
}

export function modelText(text: string): AgentFixtureStep {
  return { kind: "text", text };
}

/** Real wire transport, deterministic model decisions, and inspectable request history. */
export function startAgentModel(
  decide: (messages: readonly AgentFixtureMessage[], call: number) => AgentFixtureStep,
) {
  const requests: { readonly call: number; readonly messages: readonly AgentFixtureMessage[] }[] =
    [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return new Response(null, { status: 404 });
      }
      const body = MessagesSchema.parse(await request.json());
      const call = requests.length + 1;
      requests.push({ call, messages: body.messages });
      const step = decide(body.messages, call);
      if (step.kind === "tool") {
        return stream([
          assistantRole(),
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `fixture-call-${call}`,
                      function: { name: step.name, arguments: JSON.stringify(step.args) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          usage(step.name),
        ]);
      }
      return stream([
        assistantRole(),
        { choices: [{ delta: { content: step.text }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        usage(step.text),
      ]);
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("model_fixture_no_port");
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => {
      const previous = server.port;
      await server.stop(true);
      if (previous === undefined) throw new Error("model_fixture_missing_port");
      const rebound = Bun.serve({ port: previous, fetch: () => new Response(null) });
      await rebound.stop(true);
      return { portReleased: true };
    },
  };
}
