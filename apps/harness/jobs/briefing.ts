/**
 * 브리핑 생성 — the app's own script job, installed beside every other script.
 *
 *   args  none
 *
 * A workflow names this file as `{kind:"script", path:"jobs/briefing.ts",
 * capabilities:["account.read","mail.send"]}`. The composition is the app's own
 * (`briefing_compose`), so the scheduled path and this script produce the same
 * content; this script delivers it through `mail.send`.
 *
 * Exit 0 when composed and stored (or already stored for this slot). A failed push
 * does not fail the run: the briefing exists and the reason is reported, since a
 * phone that is offline should not turn the day's briefing into a failed run.
 */
import { sdk } from "../.digithive/sdk.ts";

type Composed = {
  readonly slot: string;
  readonly stored: boolean;
  readonly text: string | null;
  readonly prompt: { readonly title: string; readonly body: string } | null;
};

const composed = (await sdk.briefing.compose()) as Composed;

if (!composed.stored || composed.prompt === null) {
  console.log(JSON.stringify({ slot: composed.slot, stored: false, pushed: false }));
  process.exit(0);
}

let push: {
  readonly sent?: number;
  readonly failed?: number;
  readonly errors?: readonly string[];
} = {};
let warning: string | null = null;
try {
  const reply = await sdk.mail.send(composed.prompt.title, composed.prompt.body);
  push = typeof reply === "object" && reply !== null ? reply : {};
} catch (error) {
  const detail = error instanceof Error ? error.message : "push_failed";
  push = { errors: [detail] };
  warning = detail;
}
const pushed = (push.sent ?? 0) > 0;
if (!pushed) {
  // The briefing exists; only the notification is missing, and the run is not failed
  // for it. The reason is in the output either way.
  warning = `브리핑은 저장했지만 알림을 보내지 못했습니다: ${(push.errors ?? ["도달한 기기 없음"]).join(", ")}`;
}
console.log(
  JSON.stringify({
    slot: composed.slot,
    stored: true,
    pushed,
    push,
    ...(warning === null ? {} : { warning }),
  }),
);
