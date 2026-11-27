import { z } from "zod";

/** The stand-in model provider the settings QA points the app at. */

/** An OpenAI list of model ids, as a plain compatible server answers `/models`. */
export const QaModels = {
  object: "list",
  data: [{ id: "qa-model-fast" }, { id: "qa-model-strong" }, { id: "qa-model-broken" }],
};

/** The model the fixture refuses, so a failure can be shown verbatim. */
export const QA_BROKEN_MODEL = "qa-model-broken";

/** Every upstream call the fixture answered, in order. */
export type ProviderCall = { path: string; method: string; authorization: string | null };

const ChatBody = z.object({ model: z.string().optional() });

/**
 * One answer from the fixture. A GET `/models` lists ids; a POST `/chat/completions`
 * answers a short completion for any model except the broken one, which answers with an
 * OpenAI-shaped error. Anything else is a 404, so an unexpected call shows up as a failure
 * rather than as silence.
 */
export async function answerProviderCall(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/models") return Response.json(QaModels);
  if (url.pathname === "/v1/chat/completions") {
    const body = ChatBody.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return Response.json({ error: { message: "invalid body" } }, { status: 400 });
    if (body.data.model === QA_BROKEN_MODEL)
      return Response.json(
        {
          error: {
            message: `${QA_BROKEN_MODEL} is retired (fixture)`,
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      );
    return Response.json({
      id: "qa-1",
      choices: [{ message: { role: "assistant", content: "확인" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });
  }
  return new Response("not found", { status: 404 });
}
