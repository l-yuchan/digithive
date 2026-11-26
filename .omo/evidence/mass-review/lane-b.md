# Lane B review — work surfaces, SDK, jobs, runtime

Scope: `apps/harness/src/surfaces/work/*.ts`, `apps/harness/src/sdk/*.ts`, `apps/harness/src/jobs/*.ts`,
`apps/harness/src/runtime.ts`. Every file in scope was read in full; cross-references were opened wherever a judgment
needed one. Findings marked **reproduced** were confirmed with a throwaway `bun test` probe kept outside the repository
(`%TEMP%/review/probe.test.ts`); no repository file was modified.

Method note on cited tests: `tests/work.test.ts` and `tests/workflows.test.ts` use `scripted([...])` /
`workDeps(...)` stubs, so several work-path behaviours are exercised only through those stubs; the test-gap statements below
say what each existing test actually asserts.

---

## 1. A delegated run's declared tool-call budget turns a compliant run into `failed`

**File:** `src/surfaces/work/agent-run.ts:77` and `src/surfaces/work/agent-run.ts:101-107`

```ts
  const maxToolCalls = contract.budget?.maxToolCalls ?? contract.maxToolCalls ?? Infinity;
```
```ts
  const consumeTool = () => {
    assertActive();
    if ((state.toolCallsUsed ?? 0) >= maxToolCalls) throw new Error("tool_budget_exceeded");
    state.toolCallsUsed = (state.toolCallsUsed ?? 0) + 1;
    saveState(deps.db, run, state);
  };
```

**Scenario.** `POST /api/runs/:id/delegate` validates `budget: { maxMicroUsd, maxToolCalls }` (`runner.ts:75-84`) and
`enqueueRun` stores the whole delegation object, so `contract.budget.maxToolCalls` is honoured (`agent-run.ts:60`). With
`maxToolCalls: 1` and a model that asks for two tools in one assistant turn (a perfectly normal parallel tool call):

1. round 0, call `t1`: `consumeTool` → `0 >= 1`? no → `toolCallsUsed = 1`, `t1` executes;
2. round 0, call `t2`: `consumeTool` → `1 >= 1` → `throw new Error("tool_budget_exceeded")`;
3. the catch settles the run `failed` with `{"error":"tool_budget_exceeded"}` and no assistant text is returned.

The budget was not violated; the model was never told its budget was spent. Every other refusal path (policy
`deny`, approval rejected) pushes a `tool` message so the model can conclude, but this one aborts the run.
**Reproduced:** probe enqueues a delegation run with `budget.maxToolCalls = 1`, a stream yielding two allowed tool
calls in one round → `outcome failed`, `result_json {"error":"tool_budget_exceeded"}`.

A second, related off-by-one: `consumeTool` checks *before* incrementing and the round loop streams again before the
round-end guard (`agent-run.ts:178`), so a run that spends exactly its budget also streams one extra model round it can
never use. The failure above happens first, so the extra round is only cost, not correctness.

**Why tests miss it.** `tests/work.test.ts` never enqueues a run with a `delegation` object (its delegation test only
checks `validateDelegation` and `run.progress` forwarding); no test asserts `tool_budget_exceeded` or
`tool_round_limit` anywhere.

**Minimal fix.** When the budget is spent, push a `tool` result such as `"도구 호출 예산이 소진되었습니다."` for the
remaining calls of the round and let the loop continue to the answer round, instead of throwing.

**Severity:** major

---

## 2. Any tool call whose arguments are not valid JSON fails the whole run and records nothing

**File:** `src/surfaces/work/tool.ts:8-10` (called from `agent-run.ts:51` in the approval-resume path and `agent-run.ts:188` in the normal path)

```ts
function argumentsOf(call: Call): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(call.arguments || "{}"));
}
```
```ts
  const args = argumentsOf(call);          // tool.ts:41 — before the try block at tool.ts:64
```

**Scenario.** The provider truncates a tool call at `maxOutputTokens` (`WORK_LIMITS.maxOutputTokens = 2048`) and streams
`arguments: '{"path":"notes/'`. `executeTool`'s `argumentsOf` throws **before** it inserts the `tool_calls` row and
**before** its `try`/`catch`; the error reaches `executeAgent`'s catch, which settles the run `failed` with
`{"error":"JSON Parse error: Unexpected EOF"}`. No `tool_calls` row exists, no `tool.result` event is emitted, and a
1-hour work run dies on a single malformed generation that a one-line tool message would have let the model correct.
The same happens on the approval-resume path, because `agent-run.ts:113` calls `toolDecision` (which parses arguments)
outside any per-call catch.
**Reproduced:** probe streams one tool call with `arguments: '{"path":'` → `outcome failed`, `result_json {"error":"JSON Parse error: Unexpected EOF"}`.

**Why tests miss it.** Every work test builds tool calls with `JSON.stringify({...})` (`tests/work.test.ts`,
`tests/workflows.test.ts`), so `argumentsOf` never sees anything but well-formed JSON.

**Minimal fix.** Do the parse inside `executeTool`'s `try` (or catch a `SyntaxError` at the call site) and return a `failed`
tool output `도구 인자 형식이 올바르지 않습니다.` the way a thrown tool does.

**Severity:** major

---

## 3. Job tools are never registered on any start except one where a job file changed

**File:** `src/runtime.ts:181-184`

```ts
    ...(installJobs(config.scriptsRoot)
      ? jobTools({ db, events, google: googleDeps, canvas: canvasDeps, push: pushConfig })
      : []),
```

**Scenario.** `installJobs` returns *the files it wrote* (`install.ts:54-67`), not a success flag. `createRuntime` already
called `installJobs` at line 116, so by line 181 everything exists and the second call returns `[]` — falsy — on every
start of a healthy install. `jobTools` (which provides `account_list`, `source_collect`, `briefing_compose`, `push_send`)
is therefore never added to the registry, so `SdkBridge` answers every job script's call with 403 `script_capability_denied`
(`bridge.ts:130-141`, because `this.deps.tools.get(name)` is undefined and `allow.has(name)` is checked against the
capability map, which does list them) — and every `@builtin/collection.ts` run created by `ensureCollectionWorkflows`
fails at its first `sdk.accounts.list()`.

Sequence on a fresh install: line 116 plants `jobs/*.ts` + SDK and returns 3 paths (discarded); line 181 sees no changes →
`[]` → no job tools. On the next start: line 116 changes nothing, line 181 `[]` → still no job tools. The only way the
tools appear is a restart where a job file content changed *between* line 116 and line 181, which cannot happen.

**Why tests miss it.** `tests/jobs.test.ts` builds the registry as `createRegistry(jobTools({...}))` explicitly and never
calls `createRuntime`; `tests/runtime` does not exist. No test asserts the runtime registry contains `account_list`.

**Minimal fix.** Register `jobTools` unconditionally (they are reachable only through the SDK allow list and script paths,
not through `specs(registry)` for agent runs because the model's tool list is granted by policy, not presence), or gate on
the existence of the jobs (`JOB_FILES.every(f => existsSync(join(scriptsRoot, "jobs", f)))`).

**Severity:** blocker

---

## 4. An inline `workflow_run` is written as `queued` first and can be claimed by the worker, running it twice

**File:** `src/surfaces/work/inline-run.ts:49-67`

```ts
  const prepared = enqueueWorkflowRun(deps, input.workflowId, { ... });   // writes status 'queued'
  ...
  deps.db
    .query(
      "UPDATE runs SET status='running', lease_owner=?, lease_expires_at=?, attempt=attempt+1 WHERE id=? AND status='queued'",
    )
```

**Scenario.** `enqueueWorkflowRun` commits the row as `queued` (`runner.ts:117-131`). Between that commit and the
`UPDATE … WHERE status='queued'` at line 56, the separate worker process (`scripts/worker.ts` → `claimNext`,
`runner.ts:174-178`) can claim the same row and start `executeRun` with its own owner. The inline caller then runs the
`UPDATE`: it matches zero rows (`status` is now `running`), but the code never checks `changed.changes`; it emits a second
`run.started` for the row and calls `executeRun(deps, claimed, …)` on its own pre-update snapshot. Two executors run the
same run: the worker's `keepLease` heartbeat and the inline executor's re-claim fight over `lease_owner`, one of them aborts
with `lease_lost`, but both may have started the script / streamed a model response, and the tool slot accounting
(`maxConcurrent`) is bypassed. The tool's own description says inline runs bypass the queue on purpose "so waiting for it
cannot deadlock the two-slot queue" (`inline-run.ts:31-34`) — the current two-step claim defeats that on the window.

**Why tests miss it.** All inline tests run against a DB with no worker (`tests/workflows.test.ts` "inline execution"), so
`claimNext` never competes for the `queued` row.

**Minimal fix.** Insert the child as already `running` under the inline owner in `enqueueWorkflowRun` (a flag), or `UPDATE`
with `AND status='queued'` and throw `run_already_claimed` when `changed.changes === 0`.

**Severity:** major

---

## 5. A rejected approval leaves its `tool_calls` row `pending` forever, and an approved one loses `decision_by='user'`

**File:** `src/surfaces/work/runner.ts:221-225`

```ts
      deps.db
        .query(
          "UPDATE tool_calls SET decision_by = 'user', decision = ? WHERE run_id = ? AND status = 'pending'",
        )
        .run(status, input.runId);
```

**Scenario.** On pause, `agent-run.ts:183-198` inserts the call `status='pending'`, `decision='ask'`.

- **Approve:** the resumed executor finds the approval approved and calls `executeTool` (`agent-run.ts:117`), which runs
  `INSERT OR REPLACE INTO tool_calls (… decision …)` with `"allow"` and no `decision_by` (`tool.ts:46-63`). The REPLACE
  deletes the row and inserts a new one, so `decision_by='user'` is gone: the history says the policy allowed it, not the
  owner. This is the audit trail the approval exists for.
- **Reject:** the executor pushes a `tool` message and deletes `state.pending` (`agent-run.ts:126-141`) but never touches
  `tool_calls`, so the row stays `status='pending'` with no `ended_at` for the life of the run. Any view that lists
  pending calls (the schema's `tool_calls_*` indexes, `cancelRun`'s `WHERE status IN ('pending','running')`) sees a call
  that will never run.

**Why tests miss it.** `tests/work.test.ts` "rejecting an approval…" asserts only the resumed status and the `tool` message
content; "approving resumes…" asserts the run succeeded. Neither re-reads `tool_calls`.

**Minimal fix.** In `decideApproval`, write `status = 'approved'`/`'rejected'` and `ended_at` to the pending call; in
`executeTool`, `UPDATE` the existing row (or `INSERT … ON CONFLICT(id) DO UPDATE` excluding `decision_by`) instead of
`INSERT OR REPLACE`.

**Severity:** major

---

## 6. `parseState` silently drops a run's approval pause when the persisted messages do not match `ChatMessageSchema`

**File:** `src/surfaces/work/run-state-json.ts:23-31`

```ts
export function parseState(run: RunRow): WorkState {
  if (!run.stateJson) return { messages: [{ role: "user", content: run.goal }] };
  try {
    return WorkStateSchema.parse(JSON.parse(run.stateJson));
  } catch {
    return { messages: [{ role: "user", content: run.goal }] };
  }
}
```

**Scenario.** `state.pending` and `state.remaining` are written by one version of the code and read after an upgrade or by
a resumed worker. If `messages` contains one assistant message whose `toolCalls[].arguments` is not a string, or a `tool`
message without `toolCallId` (both shapes an upgrade of `ChatMessageSchema` or a provider adapter change can produce),
`WorkStateSchema.parse` throws on `messages` and the catch returns a state with **no `pending`** — discarding the
approval pause and all prior turns. The run was re-queued by `decideApproval` with `status='queued'` and a pending
approval row still `approved`; the resumed executor streams the goal again from scratch, asks for the same tool again,
inserts a **second** approval, and the owner is prompted twice for the same action. Nothing is logged about the lost state.

**Why tests miss it.** Every persisted state in the tests is produced by the same code that reads it
(`tests/work.test.ts` approval tests), so the parse cannot fail.

**Minimal fix.** Parse `pending`/`remaining`/counters separately from `messages` and merge, or on failure emit a
`run.state_unreadable` event and settle `interrupted` rather than silently restarting.

**Severity:** major

---

## 7. `listRuns`' text filter is a `LIKE` pattern, so `%`/`_` in the operator's query match everything

**File:** `src/surfaces/work/record.ts:94-101`

```ts
  if (options.query && options.query.trim().length > 0) {
    const like = `%${options.query.trim()}%`;
    where.push("(goal LIKE ? OR id LIKE ? OR result_json LIKE ?)");
```
```ts
  /** Substring of the goal, the run id, or the recorded result. */
```

**Scenario.** The execution-history search documents a literal substring. The binding is a raw `LIKE` pattern: typing `%`
lists every run, `_` matches any single character, and a goal containing `100%` cannot be searched for literally. The
parameterisation prevents SQL injection; the missing escape makes the documented filter wrong.
**Existing tests:** none call `listRuns` with a `query` (no `listRuns` usage in `tests/` apart from via HTTP routes, which
do not search with `%`).

**Minimal fix.** `const like = \`%\${query.replace(/[\\%_]/g, (c) => \`\\\\\${c}\`)}%\`` and append `ESCAPE '\\'` to the clause.

**Severity:** minor

---

## 8. Provider diagnostics map to event kinds the log's own contract rejects

**File:** `src/surfaces/work/stream-diagnostics.ts:12-38`

```ts
      kind: diagnostic.kind === "provider.fallback" ? "provider.fallback" : diagnostic.kind,
      payload: {
        level: diagnostic.kind === "provider.exhausted" ? "error" : "warning",
```

**Scenario.** `ProviderDiagnostic.kind` includes `provider.exhausted` and `provider.recovered`
(`src/providers/router.ts:55-59`), while `src/events/log.ts:24-30` documents `provider.retry`/`provider.fallback` as the
routing kinds and lists other names as "legacy kinds … nothing emits these any more". `EventLog.append` does **not**
validate the kind (`log.ts:106-127` accepts `kind: string`), so this is not a crash. It is restore-drift: a persisted
`provider.exhausted` row is read back by the log's own kinds contract as an undeclared kind, and `WorkPanel.tsx:116-117`
classifies events by the raw payload string `"level":"error"`, so the only consumer that will render it is a heuristic.
The `level === "error"` branch is then the only signal that the primary route is dead, and it lives in a payload the schema
does not describe.

**Why tests miss it.** `tests/provider-routing.test.ts` feeds diagnostics into a collector callback, never into
`runStream` + `EventLog`.

**Minimal fix.** Emit one declared kind (e.g. `provider.fallback`) with `decision: diagnostic.kind` in the payload, or add
`provider.exhausted`/`provider.recovered` to the declared list beside the other routing kinds.

**Severity:** minor

---

## 9. A provider exhaustion in the *middle* of a work stream aborts the run without the model's partial answer

**File:** `src/surfaces/work/stream-diagnostics.ts:40-43`

```ts
  for await (const event of deps.stream(messages, tools, { ...options, onDiagnostic: report })) {
    yield event;
  }
```

**Scenario.** The routing stream (`router.ts:285`) switches to a fallback only before the first text delta; once text has
started, a mid-stream provider failure propagates out of this generator. `executeAgent` catches it, `saveState` and
`settle(failed)` keep the state, but `text` accumulated in the loop variable (`agent-run.ts:97,149`) is not part of
`payload` for the `failed` branch — only `{ error }` and `provider.body` are stored — so the user's run history loses every
token the model produced. A partial answer is exactly what a reader wants on a provider failure.

**Why tests miss it.** `tests/work.test.ts`'s `scripted()` stream never throws.

**Minimal fix.** On a non-cancel failure, settle with `{ error: message, text }` (and the state already holds the
messages), so the partial answer survives in the run's result.

**Severity:** minor

---

## 10. An inline child rejected by a *different* run's cancellation is reported as if the caller cancelled

**File:** `src/surfaces/work/inline-run.ts:73-76`

```ts
  const settled: RunRow = getRun(deps.db, prepared.run.id) ?? claimed;
  const result = parseResult(settled.resultJson);
  if (settled.status === "interrupted" && input.signal?.aborted) {
    throw input.signal.reason ?? new Error("run_cancelled");
  }
```

**Scenario.** `executeRun`'s `cancelPoll` aborts the child with `Error("run_cancelled")` when **the child's own row** is
cancelled (`execution.ts:34-36`), and `input.signal` belongs to the *parent*. If a parent tool slot is cancelled
(`cancelRun(parent)`) while the inline child runs, `onCallerAbort` (`execution.ts:39-42`) aborts the child with the
parent's reason — fine. But if something else cancels or interrupts the **child** (approval expiry → reconcile, a
`workflow_delete` cascade is not one, a second worker, or the inline lease expiring under a slow tool), the child settles
`interrupted` while `input.signal` is not aborted: the branch does not throw and the function returns
`{ status: "interrupted", result: { error: … } }` to the model as a successful tool call whose payload is an interrupt. The
tool's own doc (`tools/workflows.ts:262`) says the child runs inside the caller's turn, and every intended interrupt of a
child in that window is a caller cancel — so the one case that reaches the return path reports success for an interrupted
child.
**Reproduced (indirect):** `tests/workflows.test.ts` "the caller's abort stops the inline child…" covers only the
`input.signal.aborted` case and asserts `interrupted` is returned, not thrown, so the contract is already ambiguous.

**Minimal fix.** Throw on any non-`succeeded`/non-`failed`-with-result status (or return `result` verbatim for every
status and let the caller inspect `status`), and distinguish the caller reason from `run_cancelled`.

**Severity:** minor

---

## 11. `executeNonAgent` takes the script's arguments from `executor.args` while the *job* script reads its account from `process.argv` — a run whose params carry the account and whose args are empty collects nothing

**File:** `src/surfaces/work/executor-branch.ts:40-62`

```ts
    const params = parseArgs(run.paramsJson);
    const ticket = deps.sdk?.issue({
      runId: run.id,
      workflowId: run.workflowId,
      workflowTitle: run.workflowTitle,
      params,
      capabilities: executor.capabilities ?? [],
      deadlineAt: now + run.timeoutSeconds * 1_000,
    });
    ...
      result = await runScriptFile({
        scriptsRoot: deps.scriptsRoot,
        path: executor.path,
        args: executor.args,
```

**Scenario.** `workflow_run` takes `args` that `enqueueWorkflowRun` resolves into `params_json`, and those params reach the
script only through `DIGITHIVE_PARAMS` (the SDK context). The shipped collection job does not read the SDK context for
its account; it reads `process.argv[2]` (`jobs/collection.ts:33` `const accountId = process.argv[2] ?? "";`) and exits 2
when it is empty. A workflow defined with `params: [{name: "accountId"}]` and called as
`workflow_run(id, { accountId: "acct-a" })` runs with `args: []`, so the job answers `수집할 계정 id가 필요합니다` and the run
fails — while the workflow form promises the parameter is what the definition uses. The two paths agree only when the
caller also hard-codes `executor.args`, which the parameters exist to avoid. **Verified at the code level:** the ticket's
`params` are used only for `DIGITHIVE_PARAMS`/`/sdk/context` (`bridge.ts:100-107`), and the job never calls
`sdk.context()`; the resume path uses `parseArgs`, which is also why the `params_json` shape is permissive.

**Why tests miss it.** `tests/jobs.test.ts` starts the builtin with `collectionExecutor("acct-missing")`, i.e. `args`
already carries the account, and `tests/workflows.test.ts`'s script workflows print a constant.

**Minimal fix.** Pass the declared parameters to the script (`args: [...executor.args, ...paramsFromDefinition]`) or make
the job read `sdk.context()`; either way, one contract.

**Severity:** major

---

## 12. `keepLease` compares lease expiry against the injected clock, so a clock that is frozen renews forever and a clock that jumps aborts a live run

**File:** `src/surfaces/work/lease.ts:36-53`

```ts
  const heartbeat = setInterval(
    () => {
      const time = now();
      const changed = db
        .query(
          "UPDATE runs SET lease_expires_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_expires_at>?",
        )
        .run(leaseExpiry(time, leaseMs), run.id, run.leaseOwner, new Date(time).toISOString());
```

**Scenario.** `executeRun` builds `now = () => (deps.now ?? Date.now)()` (`execution.ts:23`) and
`claimNext`'s `now` argument is a separate caller choice. Where the two disagree by more than `leaseMs`, the first
heartbeat (at `leaseMs/3`) sees the row's `lease_expires_at` in the past and aborts a healthy run with `lease_lost`.
`tests/work.test.ts` "a dead worker's run is settled as interrupted" claims at `2026-11-24T05:00:00Z` and then never
executes; an executor built with `deps.now` on the real clock for that claimed row would abort immediately. The mirror case
is a frozen `now` (tests): the `lease_expires_at > time` predicate is always true, so ownership never expires and a
stalled executor's slot is never reclaimed by `reconcileWork` while the DB clock and the injected clock diverge.
`WorkDeps.now` is production-visible through `createRuntime`'s `work` object, and `main.ts` runs `reconcileWork` on
`Date.now()` — the two clocks must agree, and nothing enforces it.

**Why tests miss it.** No test runs `executeRun` long enough for a heartbeat (every work test settles in milliseconds with
stub streams), so the heartbeat line never executes in CI.

**Minimal fix.** Arm the lease from the claim's own `now` (`claimNext` returns the row with `leaseExpiresAt`; compare
against `Date.parse(leaseExpiresAt)`), or stamp `deps.now` into the row and reject mismatched clocks at claim time.

**Severity:** minor

---

## 13. `enqueueRun` stores the whole delegation contract under `budget_json`

**File:** `src/surfaces/work/runner.ts:129-135`

```ts
    JSON.stringify(input.delegation ?? input.budget ?? {}),
```

**Scenario.** The column is read as a budget by `BudgetSchema` (`agent-run.ts:60`), but a delegation run stores
`{ goal, inputRefs, permissionProfile, budget, completionCondition }` and a conversation turn stores
`{ maxOutputTokens }` (`conversation/loop.ts:137`). Three shapes, one name; `BudgetSchema` tolerates the extra keys, so the
drift is silent, but any consumer treating `budget_json` as "the budget" (as the column name and `kind: 'budget'` in the
migrations imply) sees `maxToolCalls` undefined on a delegation row and a raw number nowhere. `maxMicroUsd` is validated
and stored but never read by any executor (`grep maxMicroUsd` → `runner.ts`, `agent-run.ts`, `app.ts` only), so the cost
half of the delegation budget is purely decorative.

**Why tests miss it.** No test asserts `budget_json`'s shape.

**Minimal fix.** Store `JSON.stringify(input.budget ?? {})`; keep the delegation contract out of the budget column (and
enforce or drop `maxMicroUsd`).

**Severity:** minor

---

## 14. `saveState` and `settle` silently no-op on a zero-row update, hiding lost cancel results

**File:** `src/surfaces/work/run-state-json.ts:33-37`, `src/surfaces/work/settle.ts:42-45`

```ts
export function saveState(db: Database, run: RunRow, state: WorkState): void {
  db.query(
    "UPDATE runs SET state_json = ? WHERE id = ? AND status='running' AND lease_owner=?",
  ).run(JSON.stringify(state), run.id, run.leaseOwner);
}
```
```ts
    if (changed.changes === 0) return;
```

**Scenario.** `cancelRun` sets `status='cancelled'` and `run.result_json = COALESCE(result_json, '{"error":"cancelled"}')`
in its own transaction. The executor's poll then throws `run_cancelled`, `cancelledOutcome` calls `settle(…, "cancelled", …)`,
whose guard `status IN ('running','awaiting_approval')` matches zero rows **and returns before appending the
`run.cancelled` event** — the event was already written by `cancelRun`, so that is consistent. The inconsistent case is a
cancel that races the executor's own settlement: `settle(…, "succeeded")` writes the row, then `cancelRun`'s guarded
`UPDATE … WHERE status IN ('queued','running','awaiting_approval')` still writes `status='cancelled'` **after** the success
(its guard is evaluated on the fresh row inside the transaction, and the terminal-status check at `cancel.ts:29` happens
before the update but the row is terminal by then, so it returns `changed: false` — fine). The genuinely lost write is
`saveState` in `executeAgent`'s error path: when the failure is `lease_lost` or the reconciler already marked the run
`interrupted`, the update matches zero rows and the error state is dropped with no trace. The silent no-op makes all of
this undiagnosable.

**Why tests miss it.** Tests never save state or settle outside `running` ownership.

**Minimal fix.** Return `changed.changes > 0` from `saveState` and log/emit when false; in `settle`, when the update matches
zero rows, append a `run.settle_skipped` event instead of returning silently.

**Severity:** minor

---

## 15. `resolveScriptPath` accepts a builtin name that is actually a directory, and on Windows accepts a case variant

**File:** `src/surfaces/work/script.ts:15-22, 49-56`

```ts
  return file.length === 0 || file.includes("/") || file.includes("\\") || file.includes("..")
    ? null
    : file;
```
```ts
    const target = resolve(JOB_SOURCE_ROOT, file);
    if (!existsSync(target)) throw new Error("script_not_found");
    return realpathSync(target);
```

**Scenario.** `@builtin/.` → `builtinFile` returns `"."` (no `/`, `\`, `..`) → `resolve(JOB_SOURCE_ROOT, ".")` is the jobs
`directory`, `existsSync` is true, `realpathSync` returns the directory, and `Bun.spawn([process.execPath, <dir>])` runs
Bun on a directory — a confusing error at best, an EISDIR at worst — instead of `script_not_found`. On Windows,
`@builtin/COLLECTION.TS` resolves to the shipped `collection.ts` because the filesystem is case-insensitive, so a path
the manifest never names runs the builtin. The docstring promises "the file a `@builtin/…` path names".

**Why tests miss it.** `tests/jobs.test.ts` checks `"@builtin/nested/job.ts"`, `"@builtin/"`, `"@builtin/../src/server/main.ts"`
— none of which exercise a directory name or a case variant.

**Minimal fix.** `if (!statSync(target).isFile()) throw new Error("script_not_found")`, and on `win32` compare
`realpathSync(target)` against `realpathSync(join(JOB_SOURCE_ROOT, file))` computed from the manifest entry (exact case).

**Severity:** minor

---

## 16. The SDK bridge's per-call timeout floors at 1 s even when the ticket has already expired

**File:** `src/sdk/bridge.ts:148-152`

```ts
      const remaining = Math.max(1_000, Math.min(ticket.expiresAt - this.now(), 60_000));
      const result = await tool.execute(args, {
        runId: ticket.runId,
        signal: AbortSignal.timeout(remaining),
      });
```

**Scenario.** The token check (`ticketFor`) refuses an expired ticket, so at the moment of the check `expiresAt - now > 0`,
but a clock tick between the check and line 148 (or a ticket issued with a sub-millisecond lead) yields `remaining < 1_000`
and the `Math.max` extends the tool's life past the run's deadline: the script may have been SIGKILLed
(`script.ts:126`) while a `source_collect` network call keeps running in the server for up to another second after the
run's `deadlineAt`. Small, but the token's whole premise is "expires with the run".

**Why tests miss it.** `tests/workflow-sdk.test.ts` uses a 10 s deadline and never checks the bound.

**Minimal fix.** `Math.max(0, Math.min(ticket.expiresAt - this.now(), 60_000))` and answer `sdk_ticket_expired` (401) when
it is 0.

**Severity:** minor

---

## 17. `runWorkflowInline` returns a failure's `result` under a `succeeded`-shaped contract, and its `?? { error: status }` fallback reports the stale pre-settlement status

**File:** `src/surfaces/work/inline-run.ts:78-87`

```ts
  const result = parseResult(settled.resultJson);
  if (settled.status === "interrupted" && input.signal?.aborted) {
    throw input.signal.reason ?? new Error("run_cancelled");
  }
  return {
    ...
    result: outcome === "succeeded" ? result : (result ?? { error: settled.status }),
```

**Scenario.** `settle` always writes `result_json` when its guarded update matches (`settle.ts:55-62`), so
`parseResult(settled.resultJson)` is the settled payload for every outcome; the `outcome === "succeeded" ? result : …`
branch is dead because both arms return `result` unless it is `null`. `result` is `null` exactly when the update matched
zero rows and `settled` is the pre-settlement `claimed` snapshot — in that case `settled.status` is `"running"` and the
model is handed `{ error: "running" }`, a value no executor ever produces. The cancellation branch keys on
`input.signal?.aborted` (the *caller's* signal) rather than on the settled run's own cancel intent, so a child cancelled by
anything else (reconcile, a second worker) is reported as an ordinary result (see finding 10).

**Why tests miss it.** `tests/workflows.test.ts` only asserts `status` and `result.text`/`result` of a succeeded script.

**Minimal fix.** Return `result` (no branch), and on a non-success outcome throw a `WorkflowError` carrying
`{ status, result }`, so the tool's `failure(error)` path reports it consistently.

**Severity:** minor

---

## Suspicions

### S1 — `SdkBridge.close()` may leak a loopback listener when `stop(true)` throws synchronously
`bridge.ts:66-72` calls `this.server.stop(true).catch(…)`, but `.catch` only handles a rejected promise; I did not verify
whether Bun's `stop(true)` can throw synchronously (it is declared to return a Promise). If it can, `runtime.close()`
would never reach `db.close()`. **Confirm** by calling `close()` twice in a probe.

### S2 — `reconcileWork`'s approval sweep re-queues a run whose second approval is still pending
`reconcile.ts:20-37` expires *every* pending approval whose `requested_at` is older than the TTL and re-queues the run.
After finding 6, a run with an older stale approval and a newer live one would be re-queued while still waiting for the
live approval, and `agent-run.ts:101-124` would then answer the *stale* call with `approval?.status === 'rejected' ? … :
"승인이 만료되어 실행하지 않았습니다."` — correct for that call, but the live approval is abandoned. Only reachable if two
approvals coexist, which finding 6 makes possible. **Confirm** by inserting two `pending` approvals for one run.

### S3 — `settle` hard-codes `cancel_intent = 'user'` for every `cancelled` outcome
`settle.ts:48`. Today only `run_cancelled`-reasoned aborts reach that branch (the `cancelRun` path already wrote the row,
so the guard returns early), so the value is correct by construction rather than by intent; a second producer of
`"cancelled"` (e.g. policy) would record the wrong actor. **Confirm** by settling a `running` row whose `cancel_intent` is
already `'policy'`.

### S4 — `executeRun`'s `extra.totalMs` cannot outlive the tool slot
For an inline child, `totalMs` is the parent's remaining budget, but the parent's `tool.execute` (`tool.ts:70-76`) races the
child tool against its own 30 s `toolMs` unless `tool.selfDeadline` is true; `workflow_run` is (`tools/workflows.ts:276`).
Any future self-deadlined tool that forgets the flag will be cut at 30 s with `tool_timeout` while a longer budget is
configured. Not a defect today.

### S5 — `briefing.ts` `dueSlot` vs `composeStoredBriefing`
`composeStoredBriefing` (`jobs/briefing.ts:215-252`) takes `runId: string | null` and always writes the slot as
`HH:MM`; the store's unique index `briefings_slot_day` excludes rows with a `run_id` (`migrations.ts:199`), and the
`composeStoredBriefing` branch stores `{...content, runId: input.runId}` **only when** `input.runId !== null`. A call with
`runId: null` (a script started outside the queue, per `tools/jobs.ts:108-113`) therefore competes on `briefings_slot_day`
with the scheduled path's `run_id IS NULL` rows and returns `duplicate: true` with `text: null` — the caller cannot tell
"already sent" from "failed to store because another stand-alone briefing of the same minute exists". Low impact; moved
here rather than to a finding because the caller is the only one that can distinguish them.

---

## Files read

- `src/surfaces/work/agent-run.ts` — read
- `src/surfaces/work/cancel.ts` — read
- `src/surfaces/work/execution.ts` — read
- `src/surfaces/work/executor-branch.ts` — read
- `src/surfaces/work/inline-run.ts` — read
- `src/surfaces/work/lease.ts` — read
- `src/surfaces/work/reconcile.ts` — read
- `src/surfaces/work/record.ts` — read
- `src/surfaces/work/runner.ts` — read
- `src/surfaces/work/run-state-json.ts` — read
- `src/surfaces/work/script.ts` — read
- `src/surfaces/work/settle.ts` — read
- `src/surfaces/work/stream-diagnostics.ts` — read
- `src/surfaces/work/tool.ts` — read
- `src/sdk/bridge.ts` — read
- `src/sdk/capabilities.ts` — read
- `src/sdk/generated.ts` — read
- `src/sdk/ticket.ts` — read
- `src/jobs/briefing.ts` — read
- `src/jobs/install.ts` — read
- `src/runtime.ts` — read

Cross-read for judgment only (out of scope): `src/core/run-state.ts`, `src/core/executor.ts`, `src/core/policy.ts`,
`src/store/migrations.ts` (runs/tool_calls/approvals/briefings), `src/events/log.ts`, `src/providers/router.ts`,
`src/providers/openai.ts` (options), `src/tools/jobs.ts`, `src/tools/files.ts`, `src/tools/registry.ts`,
`src/tools/workflows.ts`, `src/workflows/workflow-run.ts`, `src/workflows/workflow-store.ts`, `src/workflows/title-run.ts`,
`src/scheduler/schedule-types.ts`, `src/surfaces/conversation/loop.ts` (run insert), `src/server/app.ts`
(briefing/delegation/runs routes), `src/server/main.ts`, `jobs/collection.ts` (argv contract), `jobs/briefing.ts`,
`tests/jobs.test.ts`, `tests/work.test.ts`, `tests/workflows.test.ts` (inline section), `tests/account-briefing.test.ts`,
`tests/workflow-sdk.test.ts` (bridge fixture).
