# MASS review — whole codebase, 2026-11-26

Seven read-only lanes read every file under `apps/harness` (server, work layer and SDK,
store/core/events/files/knowledge, integrations/providers/scheduler, tools/workflows/
conversation, web client, scripts/jobs/tests/config). The lane reports are the evidence
under `.omo/evidence/mass-review/lane-*.md`. Every finding was re-checked in the main
session before it was fixed or recorded here.

Status: **fixed** (with the commit that fixed it) · **kept** (proven real and reachable;
recorded for the next round because the fix needs a decision about intended behavior) ·
**dropped** (the lane's reading did not hold up, or the behavior is intended).

## The reported defect, and what it uncovered

| # | Finding | Status |
|---|---|---|
| R1 | An `@builtin/*` job imported `../.digithive/sdk.ts`, a path the deployed image never has, so every collection run failed | fixed a426956 |
| R2 | `jobTools` was registered only when `installJobs` returned written files — never on a normal start — so a job's first tool call answered `unknown_tool` | fixed e98d90f |
| R3 | A fresh checkout (CI) had no generated SDK, so lint and typecheck read it as a missing module | fixed a303ec7 |
| R4 | Bun reports "Cannot find module" for a file that exists when its path holds a space | explained in the script's stderr |

## Lane A — server routes & auth (`src/server`)

| # | Finding | Status |
|---|---|---|
| A1 | `PATCH/DELETE /api/accounts/:id/sources/:source` decoded the already-decoded pathname; a literal `%` threw URIError → bodyless 500 | fixed 1fd3801 |
| A2 | `/api/runs/:id/cancel` returns the whole `RunRow` while the client schema declares three fields | kept — Zod strips the extras; no failure today |
| A3 | The workflow search route ignores `limit`, so every HTTP search returns 20 | kept |
| A4 | `/api/workflows/:id/runs` stops at 30 runs with no cursor | kept |
| A5 | One malformed `executor_json` breaks `GET /api/accounts` (`JSON.parse` outside a guard) | kept |
| A6 | Deleting an account during an OAuth callback leaves a collection workflow the API refuses to save | kept — narrow race |
| A7 | `DELETE /api/files/:id` threw when the bytes were already gone instead of clearing the row | fixed 1fd3801 |
| A8 | `POST /api/files` holds the upload twice in memory before the size check | kept — bounded by the 10 MB limit |
| A9 | `isPublicRoute` never says what protects the public Google callback | kept — comment only |
| A10 | `sse()` assigns `cleanup` after starting its ping interval | kept — error path only |
| A11 | `/delegate` accepts an already-settled parent run | kept |

## Lane B — work execution & the script SDK (`src/surfaces/work`, `src/sdk`)

| # | Finding | Status |
|---|---|---|
| B1 | A delegated run's `maxToolCalls` fails the run as `tool_budget_exceeded` | kept |
| B2 | Tool-call arguments that are not valid JSON fail the whole run | kept |
| B3 | Job tools never registered (R2) | fixed e98d90f |
| B4 | An inline `workflow_run` is committed `queued` first, so the worker can claim it too | kept — needs a claim guard |
| B5 | A rejected approval leaves its `tool_calls` row pending; the approved one loses `decision_by` | kept |
| B6 | `parseState` drops an approval pause when the stored messages do not match the schema | kept |
| B7 | The run-log text filter treated `%`/`_` as LIKE wildcards | fixed 1fd3801 |
| B8 | Provider diagnostics emit event kinds the event contract does not declare | kept |
| B9 | A mid-stream provider failure drops the model's partial answer | kept |
| B10 | An inline child cancelled by something other than its caller is reported as a result | kept |
| B11 | A collection run's account comes from `process.argv`, so a params-driven run collects nothing | kept |
| B12 | `keepLease` mixes the injected clock and the real one | kept |
| B13 | `budget_json` holds three different shapes | kept |
| B14 | `saveState`/`settle` no-op silently on a zero-row update | kept |
| B15 | `@builtin/.` and Windows case variants pass the builtin-name check | kept |
| B16 | The script SDK's per-call timeout floors at 1 s past an expired ticket | kept |
| B17 | `runWorkflowInline` reports a failure under a succeeded-shaped result | kept |

## Lane C — store, core, events, files, knowledge

| # | Finding | Status |
|---|---|---|
| C1 | A throwing subscriber was re-offered forever and its exception escaped `append` (the SSE encoder can throw) | fixed e98d90f |
| C2 | A two-word search that matches a message returned nothing | fixed b4fce03 — measured wider: the `trigram` index matched no Korean word at all, and its 2-character fallback matched JSON keys (`id`) |
| C3 | `remember` returned untruncated text while the row holds 4000 characters | fixed 1fd3801 |
| C4 | `correctMemory` parsed `source_json` without the guard every reader uses | fixed 1fd3801 |
| C5 | Recovery overwrote `cancel_intent='user'` with `host_restart` | fixed 1fd3801 |
| C6 | A `leaf_id` naming no entry showed an empty conversation over intact history | fixed 1fd3801 |
| C7 | `forkSession` commits the session and its entries in separate transactions | kept |
| C8 | `storeFile` leaves an orphan file when the row insert fails | kept |
| C9 | `takeNext` selects then deletes without a transaction | kept — bites only with two drains on one session |
| C10 | A fresh database's `migrate` is not guarded against two processes | kept |

## Lane D — integrations, providers, scheduler

| # | Finding | Status |
|---|---|---|
| D1 | Reconnecting the seeded Google account looks up its email before a token exists | kept — first connection only |
| D2 | An identity without `email_verified === "true"` is reported unverified | kept |
| D3 | A streamed provider error frame is reported as `truncated` | kept |
| D4 | The usage probe ignores the caller's abort signal | kept |
| D5 | A `null` in any calendar field fails the page, and the kept cursor replays the same failure | kept — the most consequential of this lane |
| D6 | `hydrateGoogleEmail` swallows every error, so a dead credential reads as an identity problem | kept |
| D7 | Gmail rows are never pruned | kept |
| D8 | `normalizeCalendarEvent` can persist an empty primary key | kept |
| D9 | Re-enabling a schedule does not re-check its args against its workflow | kept |
| D10 | `usageResumeOf` suspends a half-full route for the whole window | kept |
| D11 | A reasoning-only completion is discarded and rerouted | kept |
| D12 | Push subscriptions validate only the endpoint | kept |
| D13 | A `WorkflowError` at enqueue disables the schedule with no visible reason | kept |

## Lane E — tools, workflows, conversation

| # | Finding | Status |
|---|---|---|
| E1 | A `force` edit can store a definition its own bindings cannot run; the schedule then dies on its next tick | kept |
| E2 | Tool text advertises a shipped briefing workflow that nothing creates | kept |
| E3 | The naming-run guard is one slot shared by every conversation | kept |
| E4 | Deleting a conversation bypasses `dropQueue` and never cancels its live turn | kept |
| E5 | The workflow depth guard measures one path, so sibling fan-out is unbounded | kept |

## Lane F — web client (`web/src`)

| # | Finding | Status |
|---|---|---|
| F1 | The Work tab's run detail is fetched once and can show another run's events | kept |
| F2 | `useCollection` keeps one `pending` slot for overlapping actions | kept |
| F3 | Saving a workflow never loads the saved definition's detail | kept |
| F4 | Both save forms register an error reporter that cannot run | kept |
| F5 | A failing poll can contradict the save notice | kept |
| F6 | `App.tsx` interpolates ids into URLs raw beside encoded ones | kept |
| F7 | The composer is not disabled while a submit is pending; a double Enter sends twice | kept |
| F8 | A tool result ordered before its call renders two cards | kept |
| F9 | `AccountsPanel.load` never rejects, so its error wrappers are dead | kept |
| F10 | `waitForActiveWorker` watches a captured worker | kept |
| F11 | The push panel keeps internal steps in its visible state | kept |
| F12 | The queue poll swallows every failure | kept |
| F13 | Session-list reloads accept out-of-order responses | kept |
| F14 | The Workflows tab polls accounts every 20 s for an error nothing consumes | kept |
| F15 | The schedule toggle sends a negated prop instead of the checkbox value | kept |

## Lane G — scripts, jobs, tests, build & config

| # | Finding | Status |
|---|---|---|
| G1 | `jobs/briefing.ts` documents a path (`jobs/…`) and a capability set (`account.read`) that do not compose | kept — documentation |
| G2 | A quota reset over an hour is rendered in minutes | kept |

## Why the kept items are kept

Each one is a real defect on a reachable path, but fixing it changes behavior someone
depends on (a budget rule, an approval protocol, a schedule's lifecycle, a screen's
loading model) or needs a new column or endpoint. They are listed here so the next round
starts from a checked list instead of a re-review.
