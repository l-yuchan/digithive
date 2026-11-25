/**
 * 연결 자료 수집 — the app's own script job, installed beside every other script.
 *
 *   args[0]  the account id to collect (required)
 *
 * A workflow names this file as `{kind:"script", path:"jobs/collection.ts",
 * args:[accountId], capabilities:["account.read"]}`. It is a script like any other:
 * it asks for the account's *currently switched-on* sources, so turning a source
 * off stops collection at the next run instead of a stored list going stale.
 *
 * Exit 0 with a JSON summary on stdout when every read succeeded; exit 1 with the
 * summary when any source failed, which marks the run failed with the reason.
 */
import { sdk } from "../.digithive/sdk.ts";

type Account = {
  readonly id: string;
  readonly label?: string;
  readonly connected?: boolean;
  readonly sources?: readonly string[];
};

type Outcome = { readonly ok?: boolean; readonly count?: number; readonly error?: string };

function isOutcome(value: unknown): value is Outcome {
  return typeof value === "object" && value !== null;
}

function isAccountList(value: unknown): value is { readonly accounts?: readonly Account[] } {
  return typeof value === "object" && value !== null;
}

const accountId = process.argv[2] ?? "";

if (accountId.length === 0) {
  console.error("수집할 계정 id가 필요합니다. 워크플로 인자로 계정을 지정하세요.");
  process.exit(2);
}

const listed = await sdk.accounts.list(accountId);
const account = isAccountList(listed)
  ? listed.accounts?.find((candidate) => candidate.id === accountId)
  : undefined;
if (!account) {
  console.error(`계정 ${accountId} 이(가) 없습니다. 연결 탭에서 계정을 확인하세요.`);
  process.exit(1);
}

const sources = account.sources ?? [];
if (sources.length === 0) {
  console.log(
    JSON.stringify({
      accountId,
      label: account.label,
      collected: [],
      failed: [],
      note: "켜진 정보가 없어 아무것도 수집하지 않았습니다.",
    }),
  );
  process.exit(0);
}

const results: { source: string; ok: boolean; count?: number; error?: string }[] = [];
for (const source of sources) {
  try {
    const outcome = await sdk.accounts.collect(source, accountId);
    results.push({
      source,
      ok: !isOutcome(outcome) || outcome.ok !== false,
      ...(isOutcome(outcome) && typeof outcome.count === "number" ? { count: outcome.count } : {}),
      ...(isOutcome(outcome) && outcome.error ? { error: outcome.error } : {}),
    });
  } catch (error) {
    results.push({ source, ok: false, error: error instanceof Error ? error.message : "failed" });
  }
}

const failed = results.filter((result) => !result.ok);
console.log(
  JSON.stringify({
    accountId,
    label: account.label,
    collected: results.filter((result) => result.ok),
    failed,
  }),
);
if (failed.length > 0) {
  console.error(
    `일부 출처를 읽지 못했습니다: ${failed.map((item) => `${item.source}(${item.error ?? "unknown"})`).join(", ")}`,
  );
  process.exit(1);
}
