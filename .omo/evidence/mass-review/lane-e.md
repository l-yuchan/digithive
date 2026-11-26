# Lane E review — tools, workflows, conversation surface

Scope: `apps/harness/src/tools/*.ts`, `apps/harness/src/workflows/*.ts`, `apps/harness/src/surfaces/conversation/*.ts`.
Read-only review. Each scenario was traced in the code. The ones marked **(reproduced)** were confirmed by running the real modules from a throwaway script under `C:/Users/chabun/AppData/Local/Temp/lane-e/` (in-memory DB, `bun run`); nothing in the repository was modified. One candidate (a `safePath` failure on a fresh workspace) was tested and **refuted** — `workspace_write` and `workspace_read` work on a non-existent root — so it is not reported.

---

## Finding 1 — A `force` workflow edit stores a definition its own bindings cannot run, and the schedule dies on its next tick

**File:** `src/workflows/workflow-store.ts:172-194` (reachable from `src/tools/workflows.ts:236-259`, `force: true`).

```ts
for (const binding of bindings) {
  const resolution = resolveWorkflowParams(params, binding.args);
  if (resolution.ok) continue;
  if (options.force) {
    const keep: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(binding.args)) {
      const declared = params.find((param) => param.name === key);
      if (declared && valueMatchesParamType(declared.type, value)) keep[key] = value;
    }
    rebind.set(binding.id, keep);
  } else broken.push({ id: binding.id, errors: resolution.errors });
}
```

**Scenario (reproduced).** Workflow declares `params: [{ name: "who", type: "string", required: true }]`; one interval binding has `args: { who: "me" }`. The model calls

```
workflow_edit({ id, delta: { params: [
  { name: "who",   type: "string", required: true },
  { name: "topic", type: "string", required: true } ] }, force: true })
```

and gets `{ workflow, rebound: ["<binding>"] }`. The binding row is still `{"who":"me"}`, and the new definition now requires `topic`, so `resolveWorkflowParams(newParams, binding.args)` = `{ ok: false, errors: ["missing_param:topic"] }`. On the next due tick `dispatchDueSchedules` → `enqueueWorkflowRun` throws `invalid_params` (`src/workflows/workflow-run.ts:67-68`), and `src/scheduler/schedule-dispatch.ts:82-94` then runs `UPDATE schedules SET enabled = 0, next_run_at = NULL` and logs `schedule.updated { reason: "invalid_params" }`. The schedule is silently switched off.

The rest of the system treats "a binding is always runnable" as an invariant: `requireValidArgs` in `schedule-store.ts` ("A binding must be runnable the moment it is saved") and the non-force branch of this very function. `force` only makes sense for values that can be *dropped*; a newly **required** parameter cannot be, so after `force` the owner receives no indication which parameter to fill and no enabled schedule to fill it into.

**Why tests miss it.** `tests/workflows.test.ts` covers `updateWorkflow` and the depth guard, but has no `force: true` case; nothing asserts that the bindings `updateWorkflow` keeps still resolve against `merged.params` when it returns.

**Minimal fix:** after computing `keep`, run `resolveWorkflowParams(params, keep)`; if it fails, treat the binding as `broken` (the same refusal as the non-force path) instead of rebinding it.

**Severity:** major.

---

## Finding 2 — Tool text tells the model the app ships a briefing workflow, but nothing creates one

**File:** `src/tools/workflows.ts:38-42`, against `src/workflows/collection.ts` (the only `ensure*Workflow` the app runs at startup).

```ts
const ExecutorDescription =
  "{kind:'agent'} | {kind:'script',path,args?,capabilities?}. path가 '@builtin/'으로 시작하면 앱이 직접 싣는 작업입니다: 연결 자료 수집 {kind:'script',path:'@builtin/collection.ts',args:[accountId],capabilities:['account.read']}, 브리핑 생성 {kind:'script',path:'@builtin/briefing.ts',capabilities:['account.read','mail.send']}";
```

**Scenario.** `src/server/main.ts:136` calls only `ensureCollectionWorkflows`; nothing creates a `@builtin/briefing.ts` definition or schedule (`grep` over `src/` finds no other caller of `shippedExecutor("briefing")`). On a fresh install the owner says "매일 아침 7시에 브리핑 보내줘". The model is told that briefing is one of the two jobs the app itself plugs in, and — with the collection template as its only example, whose args are a per-account id — it either copies the collection shape (an interval schedule with `args: [accountId]`; the briefing job takes no args, `jobs/briefing.ts:4 "args  none"`) or reads the briefing as an already-installed workflow and only creates a schedule for an id that does not exist. The result is a mail-collection schedule or a `workflow_not_found`, never a briefing; the tool answer records the schedule happily and the user waits for a morning briefing that no run produces.

The same paragraph's claim that anything starting with `@builtin/` is "직접 싣는" is also loose: `resolveScriptPath` (`src/surfaces/work/script.ts:47-52`) maps `@builtin/<file>` to `jobs/<file>`, and `installJobs` plants only `collection.ts` and `briefing.ts` (`src/jobs/install.ts:24`). A model that creates `{kind:"script", path:"@builtin/collect.ts"}` gets `script_not_found` at run time, after `workflow_create` accepted it.

**Why tests miss it.** `tests/schedule-execution.test.ts:382` exercises the workflow tools only with `{kind:"script", path:"jobs/mark.ts"}`; no test asserts a shipped briefing definition exists or that the description matches startup.

**Minimal fix:** create the briefing definition (and its daily schedule) at startup beside `ensureCollectionWorkflows` — `shippedExecutor("briefing")` already exists — or remove the briefing sentence from `ExecutorDescription` so the model is not told a job exists that nothing schedules.

**Severity:** major.

---

## Finding 3 — The naming-run guard is a single slot shared by every conversation

**File:** `src/surfaces/conversation/surface.ts:163-189`.

```ts
const naming: { timer?: ReturnType<typeof setTimeout>; sessionId: string | null } = {
  sessionId: null,
};
const watchNaming = (sessionId: string) => {
  naming.sessionId = sessionId;
  if (naming.timer) clearTimeout(naming.timer);
  naming.timer = setTimeout(() => {
    if (naming.sessionId === sessionId) drain(sessionId, false);
  }, deps.titleGuardMs ?? 90_000);
  naming.timer.unref?.();
};
const unsubscribe = events.subscribe((event) => {
  if (event.kind !== "session.title_settled") return;
  const ended = z.string().safeParse(event.sessionId);
  if (!ended.success) return;
  if (naming.timer) clearTimeout(naming.timer);
  naming.sessionId = null;
  drain(ended.data, false);
});
```

**Scenario.** Conversation A's first answer is stored → `drain(A, true)` → `startTitle(A)` → `watchNaming(A)` (timer armed for A). While A's naming run is still going (up to `TITLE_GUARD_MS`), conversation B's first answer is stored → `watchNaming(B)` **clears A's timer** and stores `sessionId = "B"`. A's naming run now hangs (the model stream stalls past the 60 s run budget without the settle hook appending `session.title_settled` — a lease lost to `reconcileWork` does exactly that: it writes `run.interrupted` and calls no hook, `src/surfaces/work/reconcile.ts`). A's own guard no longer exists, so nothing calls `drain(A, …)`. A's next queued question (typed while the first answer was arriving) stays in `session_queue` until the owner presses resume, although A is not paused and has no live run. The comment on `TITLE_GUARD_MS`, "A naming run that has not settled by this point no longer holds the queue", is defeated for A by any other conversation naming in the same window.

**Why tests miss it.** `tests/queue.test.ts:173-206` uses one conversation and ends the naming run through the `session.title_settled` event; only `tests/queue.test.ts:209` has a second session and it never reaches naming.

**Minimal fix:** keep one timer per session (`Map<string, ReturnType<typeof setTimeout>>`), armed with that session's id; the `session.title_settled` handler clears only the ended session's timer.

**Severity:** minor.

---

## Finding 4 — Deleting a conversation drops its queue inline and leaves `dropQueue` and its "never runs it" rule unused

**File:** `src/surfaces/conversation/surface.ts:228-229` (`discard`), against `src/core/queue.ts` `dropQueue`.

```ts
discard: (sessionId) =>
  db.query("DELETE FROM session_queue WHERE session_id = ?").run(sessionId).changes,
```

**Scenario.** `src/core/queue.ts` exports and documents `dropQueue` with the rule "A removed conversation keeps its queued text readable but never runs it: its turns were cancelled with the session", and `app.ts:609-613` calls `deps.conversation.discard(id)` right after `softDeleteSession`. The surface re-implements the delete inline instead of using `dropQueue`, so `dropQueue` has no production caller (dead exported symbol), and the second half of the rule — "its turns were cancelled with the session" — is not performed by the surface at all: `discard` does not stop a live turn or naming run for the session. The route's `getSession` filter hides the session, so the deleted id cannot receive new text, but the live run files its entries and its `session.title_settled` event still reaches the subscription, which then drains a session that no longer exists in the list.

**Why tests miss it.** No test calls `conversation.discard` (`grep -rn discard tests` is empty).

**Minimal fix:** have `discard` call `dropQueue` and cancel the session's live conversation runs (the statement `softDeleteSession` already runs) so the settle hooks see a dead session.

**Severity:** minor.

---

## Finding 5 — The workflow depth guard measures the path, not the tree, so fan-out is unbounded

**File:** `src/workflows/workflow-run.ts:35-52, 70-74`; used by `src/tools/workflows.ts:270-299`.

```ts
export function runChainDepth(db: Database, runId: string | null | undefined): number {
  let depth = 0;
  let current = runId ?? null;
  while (current) { ...; depth += 1; current = row.parent_run_id; }
  return depth;
}
...
if (parentRunId && runChainDepth(deps.db, parentRunId) >= MAX_WORKFLOW_DEPTH) {
  throw new WorkflowError("workflow_depth_exceeded", { depth: MAX_WORKFLOW_DEPTH });
}
```

**Scenario (reproduced).** A run A creates B1, B2, B3 with `parentRunId = A` — each sees `runChainDepth(A) = 1` and is accepted. Each Bi creates Ci1..Ci3 (`runChainDepth(Bi) = 2`), each Ci creates Di… (`runChainDepth = 3`), and no single chain grows past 3, so no call is ever refused. A single agent turn that emits three `workflow_run({ async: true })` calls, or a "spawn a helper workflow" definition that calls itself, multiplies runs by 3 per level against one worker with `maxConcurrent: 2`: the `runs` table and the agent-stream work grow without bound. The docstring ("A workflow chain may nest three deep: A calls B calls C, and C calling D stops") describes a limit on the tree; the code enforces it on one branch only.

**Why tests miss it.** `tests/workflows.test.ts:276-297` builds one linear chain (root → second → third) and asserts the fourth is refused; nothing creates sibling children, and `workflow-routes.ts` / `schedule-routes.ts` pass no `parentRunId`.

**Minimal fix:** also count live siblings (`SELECT count(*) FROM runs WHERE parent_run_id = ? AND status IN ('queued','running','awaiting_approval')`) and refuse a `tool`-triggered child once that count reaches a small cap, or budget the total descendants of the root run.

**Severity:** minor.

---

## Suspicions

### S1 — A title reply cut off by the output-token cap is recorded as `unusable_reply` and never retried

`startTitleRun` (`src/workflows/title-run.ts:101-127`) enqueues the title workflow with `{kind:"agent"}` and does **not** set `maxOutputTokens` in the run budget (`enqueueWorkflowRun` passes only `params` and `permissionProfile`, `src/workflows/workflow-run.ts:78-83`), so the agent run uses the work limits' cap. The material can be ~1,800 characters plus the instruction, and a model that restates the material before the JSON can reach the cap; the stream then ends at `length`, the run "succeeds", `parseTitle` returns null, and the code records `session.title_failed { reason: "unusable_reply" }` and never retries (by design, line 20). **What would confirm it:** run a title run against a small model with a long first answer and inspect the `reply` field of the failure event — a truncated JSON prefix means the cap, not a bad model. Not covered by `tests/title.test.ts` (it tests `parseTitle` only). Minimal fix: set a small `maxOutputTokens` on the title run's budget, or treat `finishReason: "length"` as its own reason.

### S2 — `resumePending` is never called by the app, although its contract says it resumes after a restart

`surface.ts:223-226` documents `resumePending` as "After a restart: resume every conversation that still has queued text". `src/server/main.ts` never calls it (`grep -rn resumePending src` → only `surface.ts`), so after a crash or restart a conversation with queued text and no live run is drained only when the owner sends another message or presses resume. **What would confirm it:** restart the server with a non-empty `session_queue` and observe that the queue stays full. The web client's send path (`web/src/chat/ChatView.tsx`) does drain on the next message via `send`, so it may be an accepted product decision — hence a suspicion, not a finding.

### S3 — Concurrent starts of the same conversation can both pass the `busy` check

`send` (`surface.ts:200-217`) reads `busy(sessionId)` and then calls `run(sessionId, text)`, which does `void runTurn(...)`; the `running` row is inserted only inside `prepareTurn` (`loop.ts:120-150`) after the first `await`. Two `POST /api/sessions/:id/messages` requests that interleave before either `prepareTurn` runs would both see `busy === false`, both start a turn, and both branch from the same leaf (`loop.ts:206-233`), so `turnRunInFlight` would then report two live runs for the session and the second answer would overwrite the leaf. `send` is synchronous up to `run(...)`, so a single JS thread cannot interleave them unless the route's `await request.json()` puts the two posts on different microtask boundaries. **What would confirm it:** fire two posts in the same tick with a stream that never yields and count user entries. Reported as a suspicion because it depends on runtime scheduling and was not reproduced.

---

## Files read

| File | Status |
|---|---|
| src/tools/files.ts | read |
| src/tools/registry.ts | read |
| src/tools/memory.ts | read |
| src/tools/builtins.ts | read |
| src/tools/schedules.ts | read |
| src/tools/jobs.ts | read |
| src/tools/personal.ts | read |
| src/tools/workflows.ts | read |
| src/workflows/workflow-params.ts | read |
| src/workflows/workflow-search.ts | read |
| src/workflows/workflow-run.ts | read |
| src/workflows/title.ts | read |
| src/workflows/collection.ts | read |
| src/workflows/title-run.ts | read |
| src/workflows/workflow-types.ts | read |
| src/workflows/workflow-store.ts | read |
| src/surfaces/conversation/queue-executor.ts | read |
| src/surfaces/conversation/surface.ts | read |
| src/surfaces/conversation/loop.ts | read |

Cross-referenced to judge the items above (not in scope of the findings): `src/runtime.ts`, `src/server/main.ts`, `src/server/app.ts` (session, queue, delete routes), `src/server/schedule-routes.ts`, `src/server/workflow-routes.ts`, `src/core/queue.ts`, `src/core/policy.ts`, `src/core/run-state.ts`, `src/core/sessions.ts`, `src/surfaces/work/{inline-run,execution,lease,settle,tool,agent-run,reconcile,script,executor-branch}.ts`, `src/scheduler/{schedule-store,schedule-dispatch}.ts`, `src/store/{db,migrations}.ts`, `src/jobs/{install,briefing}.ts`, `jobs/{collection,briefing}.ts`, `src/knowledge/memory.ts`, `web/src/chat/ChatView.tsx`, and `tests/{queue,title,workflows,schedule-execution,conversation}.test.ts`. Reproductions live in `C:/Users/chabun/AppData/Local/Temp/lane-e/` (throwaway, outside the repo).
