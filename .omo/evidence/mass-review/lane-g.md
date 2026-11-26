# Lane G review: workflow scripts, jobs, tests, and build/config

Scope: `apps/harness/scripts/*.ts`, `jobs/*.ts`, `scripts/jobs/*.ts`, `tests/*.ts`, `Dockerfile`, `deploy/compose.yml`, `package.json`, `tsconfig.json`, `.oxlintrc.json`, `.oxfmtrc.json`. Cross-references into `src/` were read only to judge a scoped file.

Severity: blocker = wrong result or broken deployment in normal use; major = wrong result in a reachable path, a test that proves nothing, or a broken documented workflow; minor = small local defect.

---

## 1. `jobs/briefing.ts` documents a capability set and a path that do not work together

**File:** `jobs/briefing.ts:9-12`, `jobs/briefing.ts:26`

```ts
 * A workflow names this file as `{kind:"script", path:"jobs/briefing.ts",
 * capabilities:["account.read","mail.send"]}`. The composition is the app's own
 * (`briefing_compose`), so the scheduled path and this script produce the same
 * content; this script delivers it through `mail.send`.
...
const composed = (await sdk.briefing.compose()) as Composed;
```

**Scenario (a): the compose call's capability.** `briefing.compose()` is `sdk.call("briefing_compose", {})` in the generated SDK. `tests/jobs.test.ts` pins which capability grants it:

```ts
expect([...allowedTools(["mail.send"])].toSorted()).toEqual(["briefing_compose", "push_send"]);
```

`briefing_compose` belongs to `mail.send`, not to `account.read`. The header reads as if either capability group could carry the workflow; a definition author who grants `account.read` (the group that reads account data, which is what composing is) has the job's very first call refused with `script_capability_denied`, so nothing is composed or stored.

**Scenario (b): the documented path runs a different file.** Every other job documents a `jobs/…` path (`jobs/collection.ts` header, `scripts/jobs/example-workflow.ts` header). For a non-`@builtin/` path, `resolveScriptPath` runs the *installed* copy `<scriptsRoot>/jobs/<file>` (`src/surfaces/work/script.ts` `runScriptFile` spawns it with `cwd: scriptsRoot`), and `src/jobs/install.ts` plants `JOB_FILES = ["collection.ts", "briefing.ts"]`. `src/workflows/collection.ts` therefore uses `@builtin/collection.ts` to run the shipped file directly. `jobs/briefing.ts` uses the plain `jobs/…` path, so the documented definition runs whatever `briefing.ts` sits in the owner's scripts directory, not this shipped file; against an install that has not yet planted it, the run fails with `script_not_found`.

**Why the tests miss it.** `tests/jobs.test.ts` runs a job only through `@builtin/` (`resolveScriptPath(dir, "@builtin/collection.ts")` and the `@builtin/` execution test), never through the `jobs/…` form that `jobs/briefing.ts` documents, and no test composes through the SDK (`briefing_compose` is only checked as an entry in `allowedTools`). `collection.ts` and `briefing.ts` are never executed by any test: the installed-job test runs `@builtin/collection.ts` against a missing account.

**Suggested minimal fix.** Document `{kind:"script", path:"@builtin/briefing.ts", capabilities:["mail.send"]}`, matching `src/workflows/collection.ts`, so the recipe names the file that actually runs and the group that actually grants compose.

**Severity:** major

---

## 2. A quota reset of an hour or more is shown in minutes, and the seeded failure text carries that unit

**File:** `scripts/qa-routing.ts:169-175`

```ts
"error":
  "quota_exhausted (HTTP 429): 모델 경로가 모두 실패했습니다. primary/qa-primary: quota_exhausted (HTTP 429): GoUsageLimitError primary usage limit reached (5-hour, resets in 31m)",
```

The seeded text is the shape the live failure produces: `src/providers/router.ts`'s `formatWait` returns `${minutes}분` for every value under 180 minutes, then `시간` and `일`, and `outage()` builds `"<route> 경로가 <formatWait> 후 다시 열립니다."` from `retryInMs = now() + held`. A provider reporting `resets in 2h` gives `retryInMs = 7_200_000` and the owner sees `primary 경로가 120분 후 다시 열립니다.`; a daily quota (`resets in 1d 11h`) reads `2100분`. The QA seed is what the `events <db> <runId>` and run-view checks replay, so the QA path reproduces and displays the wrong unit, and the `h`/`d` branches never fire for a reset below three hours.

**Why the tests miss it.** `tests/provider-routing.test.ts` asserts `retryInMs` millisecond values only (`expect(fallback?.retryInMs).toBe(35 * 3_600_000)`), never the rendered sentence, and the scripts (`scripts/qa-routing.ts`, `scripts/mock-provider.ts`) have no test file at all, so nothing asserts the human-readable form of a long reset.

**Suggested minimal fix.** In the formatter, branch hours before minutes (minutes only below one hour) so the message names the same unit the reset does, and keep the seed text in step with it.

**Severity:** minor

---

## Files read

- Dockerfile: read
- deploy/compose.yml: read
- package.json: read
- tsconfig.json: read
- .oxlintrc.json: read
- .oxfmtrc.json: read
- scripts/build-web.ts: read
- scripts/mock-provider.ts: read
- scripts/qa-routing.ts: read
- scripts/worker.ts: read
- jobs/briefing.ts: read
- jobs/collection.ts: read
- scripts/jobs/example-workflow.ts: read
- tests/account-briefing.test.ts: read
- tests/account-http.test.ts: read
- tests/accounts.test.ts: read
- tests/assets.test.ts: read
- tests/auth.test.ts: read
- tests/build-watch.test.ts: read
- tests/context.test.ts: read
- tests/conversation.test.ts: read
- tests/event-kinds.test.ts: read
- tests/events-http.test.ts: read
- tests/events-process.test.ts: read
- tests/events.test.ts: read
- tests/integrations.test.ts: read
- tests/jobs.test.ts: read
- tests/knowledge-http.test.ts: read
- tests/markdown-render.ts: read
- tests/markdown.test.ts: read
- tests/personal-tools-fixture.ts: read
- tests/personal-tools.test.ts: read
- tests/policy.test.ts: read
- tests/provider-routing.test.ts: read
- tests/provider.test.ts: read
- tests/push-diagnostics.test.ts: read
- tests/queue.test.ts: read
- tests/router-contract.test.ts: read
- tests/run-state.test.ts: read
- tests/schedule-execution.test.ts: read
- tests/schedules.test.ts: read
- tests/schema-upgrade.test.ts: read
- tests/store.test.ts: read
- tests/submit.test.ts: read
- tests/sync-contracts.test.ts: read
- tests/title.test.ts: read
- tests/tool-wire.test.ts: read
- tests/tree.test.ts: read
- tests/typescript-native.test.ts: read
- tests/web-utils.test.ts: read
- tests/work-contracts.test.ts: read
- tests/work-process.test.ts: read
- tests/work.test.ts: read
- tests/workflow-contract.test.ts: read
- tests/workflow-http.test.ts: read
- tests/workflow-sdk.test.ts: read
- tests/workflow-web-schema.test.ts: read
- tests/workflows.test.ts: read
- tests/workspace.test.ts: read
