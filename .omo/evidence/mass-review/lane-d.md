# Lane D review — integrations, providers, scheduler

Repo: `apps/harness` (every path below is relative to it). Read-only review: all 23 in-scope files were read in full; cross-references (`account-routes`, `personal`, `workflow-store`, `workflow-params`, `migrations`, `runtime`, `worker`, tests) were read only to judge the in-scope code.

Behavioural claims marked **verified by probe** were reproduced with throw-away `bun` scripts that imported the shipped modules; the scripts were deleted afterwards. Every file:line below was re-checked against the source after writing.

## Findings

### 1. Reconnecting the seeded Google account cannot pick up its email: `hydrateGoogleEmail` runs before any token exists

**File:line** `src/integrations/google-auth.ts:239-277` (the early return is line 247); its only caller is `src/server/account-routes.ts:170` (out of scope, quoted for the scenario).

**Code**
```ts
export async function hydrateGoogleEmail(
  deps: GoogleDeps,
  accountId: string,
): Promise<string | null> {
  const target = resolveAccountId(accountId);
  const account = getAccount(deps.db, target);
  if (!account || account.email) return account?.email ?? null;
  const tokens = loadTokens(deps.db, deps.vaultSecret, target);
  if (!tokens) return null;
```
The function is documented as "Best-effort legacy email hydration for one bound account, from its Gmail profile", i.e. it exists to fill `email` on the seeded row, whose `subject` is NULL and whose email was never captured.

**Scenario**
In `handleOAuthCallback` the reconnect branch does:
```ts
      if (!target.subject) await hydrateGoogleEmail(deps.google, target.id);
      const bound = bindGoogleIdentity(deps.google.db, target.id, identity);
      ...
      saveTokens(deps.google.db, deps.google.vaultSecret, target.id, tokens);
```
`hydrateGoogleEmail` is called *before* `saveTokens`, but it can only call Gmail with a token already in `oauth_tokens`. The seeded row (`DEFAULT_GOOGLE_ACCOUNT_ID`, `migrations.ts:297-302`) has no `oauth_tokens` row on a fresh install (verified against the dev DB `data/harness.db`: `oauth_tokens` empty, seed `subject:null,email:null`). So the first connect of the seed always takes `if (!tokens) return null`, the email stays `null`, and `bindGoogleIdentity` (`account-identity.ts:82-84`) returns `identity_unverified` whenever the identity carries no verified email (finding 2) — a valid Google sign-in is rejected. The hydration written to rescue exactly this case is structurally unable to run on the one request it exists for.

**Why the tests would not catch it**: `grep -n hydrateGoogleEmail tests/` finds nothing, and every userinfo fixture (`tests/account-http.test.ts:103`, `tests/accounts.test.ts:421,473,523`) carries `email_verified: true` with a real email, so `bindGoogleIdentity` never reaches its `identity_unverified` branch.

**Suggested fix**: in the reconnect branch, store the freshly exchanged tokens for `target.id` before binding, or give `hydrateGoogleEmail` an optional access-token argument and pass `tokens.accessToken`.

**Severity**: major

---

### 2. `fetchGoogleIdentity` silently turns a valid identity into "no email" when `email_verified` is absent or not the exact string `"true"`

**File:line** `src/integrations/google-auth.ts:225-232`

**Code**
```ts
const UserInfoSchema = z.object({
  sub: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.string()]).optional(),
});
```
```ts
  const verified = body.email_verified === true || body.email_verified === "true";
  return { subject: body.sub, email: verified && body.email ? body.email : null };
```

**Scenario**
The schema deliberately accepts a string, but the comparison accepts only lower-case `"true"`. **Verified by probe**: `fetchGoogleIdentity` over `{sub:"1", email:"owner@x.com"}` → `{subject:"1", email:null}`; the same with `email_verified:false`; `"True"`/`"1"` likewise. Downstream: `upsertGoogleAccount` skips legacy adoption (`account-identity.ts:32-44` requires `identity.email`), so a second row is created for the same person; the seed reconnect fails with `identity_unverified` (finding 1). Nothing distinguishes "Google says unverified" from "the field was missing" — both become `null`.

**Why the tests would not catch it**: all fixtures use boolean `true`; no fixture omits the field or uses a string.

**Suggested fix**: `String(body.email_verified ?? "").toLowerCase() === "true"` and fall back to the Gmail profile (finding 1's hydration) when the field is absent.

**Severity**: minor

---

### 3. A streamed provider error frame aborts the rest of the stream and is later reported as `truncated`

**File:line** `src/providers/openai.ts:206-223` (frame loop) with `src/providers/openai.ts:272-273` (the checks the throw skips)

**Code**
```ts
            const parsed = decodeBody(data);
            if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
              throw responseError(response.status, data, parsed);
            }
            const frameResult = StreamFrameSchema.safeParse(parsed);
            if (!frameResult.success) {
              throw new ProviderError(
                "malformed",
                response.status,
                "unrecognised stream frame",
                data,
              );
            }
```
and
```ts
      if (finishReason === "length") throw new ProviderError("truncated");
      if (finishReason === null) throw new ProviderError("truncated");
```

**Scenario**
`errors.ts:52-58` documents `responseError` as classifying "a non-2xx response **or an in-stream error frame**". A 200 `text/event-stream` that ends with an error frame (`data: {"error":{"message":"internal"},"type":"server_error"}`) throws from inside the generator: every remaining line of the frame, any buffered frame, and the end-of-stream checks (`finish_reason`-based `truncated`) never run. **Verified by probe** through `createRoutingStream`: the router's fallback diagnostic for that route recorded `reason: "truncated"`, `error: "truncated"` — not `http_5xx`. The recovery happens (the router does fall back), but `lastError` and the owner-visible diagnostic under `provider.exhausted` (`router.ts:241-246` joins `lastError` messages) state a truncation for an upstream server error, and `suspendFor` (`router.ts:190-191`) would never see `quota_exhausted` from a streamed quota frame, so a streamed quota error does not suspend the route.

**Why the tests would not catch it**: `tests/provider-routing.test.ts:209-228` covers a JSON 200 error envelope (handled by the `content-type` check at `openai.ts:163-168`) and `tests/provider.test.ts` covers `length`/`null` finish reasons, but no SSE body in `tests/` contains `{"error"`.

**Suggested fix**: throw the frame's own classification (`responseError(statusFromFrame(parsed) ?? response.status, data, parsed)`) and add a routing test asserting the fallback diagnostic keeps `reason: "http_5xx"`/`"quota_exhausted"` for an in-stream error frame.

**Severity**: major

---

### 4. The usage probe ignores the caller's abort signal, so a cancelled reply keeps suspending its route and probing `/usage` for up to 5 s

**File:line** `src/providers/router.ts:186-193` (probe call) and `src/providers/router.ts:34-37` (the signal parameter that is never passed)

**Code**
```ts
  readonly usageProbe?: (
    route: ProviderRouteConfig,
    signal?: AbortSignal,
  ) => Promise<UsageResume | null>;
```
```ts
  const suspendFor = async (route: Route, error: ProviderError): Promise<number> => {
    if (error.kind !== "quota_exhausted") return cooldownMs;
    const named = namedResetMs(error.detail ?? "");
    if (named !== null) return named;
    if (!options.usageProbe) return cooldownMs;
    const resume = await options.usageProbe(route).catch(() => null);
```
`fetchUsageResume` (`usage.ts:59-62`) only honours its own controller, aborted by its own 5 s timer.

**Scenario**
Sequence: a reply hits `quota_exhausted` on the primary with no "resets in …" text; the user cancels while that token request is in flight; the adapter surfaces `quota_exhausted` (verified by probe: the failure kind reaching the router is `quota_exhausted`, not `aborted`), the router's guard at `router.ts:287` sees `streamOptions.signal?.aborted` only *after* `suspendFor` (`router.ts:293`) has awaited an un-signalled network probe. A cancelled conversation therefore holds its generator and one HTTP request for up to 5 s and writes a cooldown (and route state) from a reply the user abandoned. The declared `signal` parameter of `usageProbe` is dead — no caller can cancel the probe.

**Why the tests would not catch it**: `tests/provider-routing.test.ts:196-206` ("cancellation is not retried or rerouted") aborts inside the transport before a response is returned, so `router.ts:263` stops it; no test aborts while a probe or retry sleep is in flight or asserts the probe's second argument.

**Suggested fix**: `await options.usageProbe(route, streamOptions.signal)`; in `runtime.ts` pass the signal into `fetchUsageResume`, which should abort on `AbortSignal.any([input.signal, controller.signal])`.

**Severity**: minor

---

### 5. A `null` in any calendar event field fails the whole page, and the saved stale cursor makes the same page fail forever

**File:line** `src/integrations/normalize.ts:83-93` and `src/integrations/google-calendar.ts:67-74` / `91-99`

**Code**
```ts
export const CalendarEventPayloadSchema = z.object({
  id: z.string().optional(),
  summary: z.string().nullish(),
  description: z.string().nullish(),
  htmlLink: z.string().nullish(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
  end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
  recurringEventId: z.string().optional(),
  status: z.string().optional(),
});
```
```ts
      const body = z
        .object({
          items: z.array(CalendarEventPayloadSchema).optional(),
          nextSyncToken: z.string().optional(),
          nextPageToken: z.string().optional(),
        })
        .parse(await response.json());
```
`summary`/`description`/`htmlLink` are `nullish`, but `start`, `end`, `recurringEventId` and `status` are not.

**Scenario**
Google Calendar sends `null` for fields it has no value for (e.g. `"start": null` on some reservation/working-location/series-reservation items, `"recurringEventId": null` explicitly for non-recurring instances). One such event makes `z.array(...).parse` throw for the **whole page**, which lands in the outer catch (`google-calendar.ts:91-99`) → `recordOutcome(ok:false, cursor:null)`. `recordOutcome` coalesces the cursor (`sync-store.ts:97`: `cursor=COALESCE(excluded.cursor, account_sources.cursor)`), so the previous `syncToken` survives; the next tick retrieves the same delta containing the same event and fails identically. Because the full-resync fallback only triggers on 400/410 (`google-calendar.ts:49`), not on a parse error, the account is wedged. Verified by probe that a single event with `start: null` makes the page parse throw while the rest of the page is valid.

**Why the tests would not catch it**: no fixture in `tests/integrations.test.ts` contains a `null` `start`/`recurringEventId`.

**Suggested fix**: make `start`, `end`, `recurringEventId` and `status` `.nullish()`; parse items one by one (`safeParse`, skip and count bad items) instead of failing the page; on a parse failure of a token-based request, clear the cursor so the next run does a full sync.

**Severity**: major

---

### 6. `hydrateGoogleEmail` swallows every error, so a dead credential is reported to the user as an identity problem

**File:line** `src/integrations/google-auth.ts:249-260` (the `try`/`catch` around the Gmail profile request)

**Code**
```ts
  try {
    const response = await (deps.fetchImpl ?? fetch)(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { authorization: `Bearer ${await accessToken(deps, target)}` } },
    );
    if (!response.ok) return null;
    const body = z.object({ emailAddress: z.string().optional() }).parse(await response.json());
    if (!body.emailAddress) return null;
    applyAccountEmail(deps.db, target, body.emailAddress);
    return body.emailAddress;
  } catch {
    return null;
  }
```

**Scenario**
When the stored token is expired with no refresh token, `accessToken` throws `google_refresh_missing`; on network failure it throws `transport`. Both collapse into `null`, and the caller then binds and reports `identity_unverified` — the redirect tells the user their identity could not be verified while the real cause is a dead credential that needs a reconnect. The caller uses `null` as a decision input, so a swallowed reason reaches a user-facing code.

**Why the tests would not catch it**: no test reaches `hydrateGoogleEmail`.

**Suggested fix**: return a discriminated result (or rethrow), and give `account-routes` a distinct reason such as `hydrate_failed` for it.

**Severity**: minor

---

### 7. Full Gmail sync replaces the table with a 7-day window, incremental sync deletes only what history reports, and nothing prunes older rows

**File:line** `src/integrations/google-gmail.ts:46-49` (full-sync delete) and `:31` (`q=newer_than:7d`)

**Code**
```ts
  return deps.db.transaction(() => {
    deps.db.query("DELETE FROM sync_items WHERE account_id=? AND source='gmail'").run(accountId);
    saveItems(deps.db, accountId, "gmail", items, now);
```
```ts
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=newer_than:7d",
```

**Scenario**
The full sync deletes every gmail row for the account and re-inserts only the last 7 days. The incremental path (`google-gmail.ts:101-151`) inserts `messagesAdded` and deletes `messagesDeleted` history entries, but a message deleted while the server was down before the history window expired is not always reported, and rows captured by a previous full sync that are now older than 7 days are never checked again (the listing query never looks at them). Nothing in `sync-store.ts` prunes by age. The result is stale rows that `gmail_search` (`personal.ts:158-171`, keyed on the first 1 000 characters of `detail`, mirroring the full body stored at `sync-store.ts:33` as `detail.slice(0, 2_000)`) still returns, plus rows that `src/jobs/briefing.ts:104` returns when the window reaches them, and a table that grows without bound.

**Why the tests would not catch it**: no test runs two full syncs with a row aged past the window and then an incremental sync.

**Suggested fix**: after `saveItems` on the full path, delete rows for the account/source with `updated_at < iso` (the upsert already stamps `updated_at`), or prune by `at < now - retention`.

**Severity**: minor

---

### 8. `normalizeCalendarEvent` can persist an empty primary key

**File:line** `src/integrations/normalize.ts:97-108`

**Code**
```ts
  return {
    id: event.id ?? "",
    source: "calendar",
```
and the caller `src/integrations/google-calendar.ts:71-74`:
```ts
      for (const raw of body.items ?? []) {
        if (raw.status === "cancelled" && raw.id) deleted.push(raw.id);
        else items.push(normalizeCalendarEvent(raw));
      }
```

**Scenario**
`id` is optional in the schema, so an event without an id normalizes to `""`. All such events then share the `sync_items` primary key `(account_id,'calendar','')` (`migrations.ts:240-250`): every later one overwrites the previous, and a later `cancelled` event without an id cannot be matched for deletion. Verified by probe: `normalizeCalendarEvent({summary:"Modern event with no id"})` → `id: ""`. Canvas already filters this (`canvas.ts:99-101` `.filter((item) => item.id.length > 0)`); the calendar path does not.

**Why the tests would not catch it**: every fixture carries an id.

**Suggested fix**: filter items with empty ids before `saveItems` in `google-calendar.ts`, as canvas does.

**Severity**: minor

---

### 9. `updateBinding` re-enables a schedule without re-checking its stored args against the workflow

**File:line** `src/scheduler/schedule-store.ts:145-150`

**Code**
```ts
  const parsed = UpdateScheduleBindingSchema.parse(patch);
  const trigger = parsed.trigger ?? existing.trigger;
  const enabled = parsed.enabled ?? existing.enabled;
  const args = parsed.args ?? existing.args;
  if (parsed.args !== undefined) requireValidArgs(existing.workflowId, args, db);
```

**Scenario**
`requireValidArgs` is documented "A binding must be runnable the moment it is saved, so its args are checked here" (`schedule-store.ts:29`), but it only runs when the patch carries `args`. A definition edit with `force: true` (`workflow-store.ts:169-174`) keeps only args that still validate and drops required ones it cannot fill; the binding is then left invalid. `PATCH /api/schedules/:id {"enabled": true}` (and the schedule tool's update at `src/tools/schedules.ts:134`) sets `enabled = 1` and a fresh `next_run_at` via `nextFor(trigger, true, now)` without the check, so the binding fires, `enqueueWorkflowRun` throws `invalid_params`, and `schedule-dispatch.ts:89-99` disables it again — a schedule that silently toggles itself off on every resume.

**Why the tests would not catch it**: `tests/schedules.test.ts:91-112` re-enables a binding whose args were always valid; no test combines `force` definition editing with a re-enable.

**Suggested fix**: call `requireValidArgs(existing.workflowId, args, db)` whenever `enabled` becomes `true` (or on every update).

**Severity**: minor

---

### 10. `usageResumeOf` counts any status other than the exact string `"ok"` as spent, suspending a half-full route for the whole window

**File:line** `src/providers/usage.ts:29-31`

**Code**
```ts
  for (const [window, meter] of Object.entries(parsed.data.usage)) {
    const spent = meter.status !== "ok" || meter.percent >= 100;
```

**Scenario**
**Verified by probe** through `createRoutingStream` with the real `fetchUsageResume` probe: a usage document with `rolling:{status:"limited",percent:50}`, `weekly:{status:"ok",percent:10}`, `monthly:{status:"ok",percent:5}` makes `suspendFor` return ~3 600 000 ms (the rolling window's reset) instead of the 15-minute default; `rolling:{status:"ok",percent:60}` returns 900 000 ms. A provider that uses a non-`"ok"` status for a warning window therefore takes its route out of rotation for a whole reset period with 50% quota left. The doc comment "the other windows are not spent" (`usage.ts:21-22`) only holds for the exact spelling `"ok"`.

**Why the tests would not catch it**: `tests/provider-routing.test.ts:291` stubs `usageProbe` with `{resumeAt, window}` directly; no test calls `usageResumeOf`.

**Suggested fix**: treat `meter.percent >= 100` as the signal and add only statuses that mean exhausted (`"exhausted"`, `"exceeded"`).

**Severity**: minor

---

### 11. A reasoning-only completion is thrown away as `empty_output` and rerouted

**File:line** `src/providers/openai.ts:188` (`hasAnswer`), `:229-236` (delta handling), `:273` (the check)

**Code**
```ts
            const reasoning = delta["reasoning_content"] ?? delta["reasoning"];
            if (typeof reasoning === "string" && reasoning.length > 0) {
              yield { type: "reasoning_delta", text: reasoning };
            }
```
```ts
      if (!hasAnswer && calls.size === 0) throw new ProviderError("empty_output", response.status);
```

**Scenario**
Reasoning deltas never set `hasAnswer`, so a completion consisting only of `reasoning_content` frames with `finish_reason: "stop"` (a reasoning model that exhausted its thinking budget, or one that answered inside the reasoning channel) throws `empty_output`. **Verified by probe**: one frame `{delta:{reasoning_content:"let me think"}, finish_reason:"stop"}` emits the `reasoning_delta` and then fails; through the router with no fallback the user gets `quota_exhausted (HTTP 503): … empty_output` after the reasoning text already streamed — the only content the provider sent is discarded.

**Why the tests would not catch it**: `tests/provider-routing.test.ts` "a stream that ends with no content is empty_output" uses `{delta:{}}`; no fixture sends `reasoning_content`.

**Suggested fix**: track a `hasReasoning` flag and accept the stream when `hasAnswer || hasReasoning || calls.size > 0`.

**Severity**: minor

---

### 12. `addSubscription` validates only `endpoint`, storing payloads its own deliverer rejects, and those dead rows are never cleaned up

**File:line** `src/scheduler/push.ts:4-7` (strict schema), `:40` (loose check), `:49-51` (store), `:78-83` (deliverer parse), `:120` (cleanup)

**Code**
```ts
  const endpoint = z.object({ endpoint: z.string() }).safeParse(subscription).data?.endpoint ?? "";
```
```ts
    PushSubscriptionSchema.parse(JSON.parse(row.payload)),
```
```ts
      if (/410|404/.test(message))
```

**Scenario**
A client posts `{endpoint:"https://x"}` with no `keys`. `addSubscription` accepts and stores it; every `sendPush` then throws a `ZodError` in `defaultDeliver`, the error message is a validation message that matches neither `410` nor `404`, so the row stays and fails on every future push. Two schemas in one file disagree about what a subscription is — contract drift with a functional effect (dead registrations are never removed).

**Why the tests would not catch it**: `tests/push-diagnostics.test.ts` injects a `deliver` stub and never reaches `defaultDeliver`'s parse.

**Suggested fix**: validate with `PushSubscriptionSchema` in `addSubscription`, and remove a row whose stored payload no longer parses in `sendPush`.

**Severity**: minor

---

### 13. A `WorkflowError` while enqueuing permanently disables the schedule and the reason never reaches the schedule view

**File:line** `src/scheduler/schedule-dispatch.ts:87-100`

**Code**
```ts
      } catch (error) {
        if (!(error instanceof WorkflowError)) throw error;
        deps.db.query("UPDATE schedules SET enabled = 0, next_run_at = NULL WHERE id = ?").run(id);
        deps.events.append({
          kind: "schedule.updated",
          payload: { id, enabled: false, reason: error.code, detail: error.detail },
          now,
        });
        return "disabled";
      }
```

**Scenario**
The `WorkflowError` branch is meant for a dangling binding (`workflow_missing`, the code below it). It also fires for `invalid_params` raised by `resolveWorkflowParams` at run time when a binding's stored args no longer match its definition (reachable through finding 9), and for `workflow_disabled`. The binding is paused with `next_run_at = NULL`; the reason goes only into the event payload. `listBindings`/`listBindingViews` (`schedule-types.ts:49-62`, `schedule-store.ts:57-87`) return `enabled:false` with no reason, so neither the UI nor the model can tell the owner to fix the args or resume it. A transient failure that *is* a `WorkflowError` (e.g. an FK/trigger error wrapped as one after a migration) would silently stop the schedule for good, where a retry next tick would have worked.

**Why the tests would not catch it**: `tests/schedule-execution.test.ts` covers only the `workflow_missing` case and reads the raw event row, not the schedule view.

**Suggested fix**: record the disable reason on the schedule (`last_error` column or part of the view) so a disabled binding is diagnosable; keep the permanent disable only for `workflow_missing`/`workflow_not_found`, and retry other `WorkflowError` codes on the next tick.

**Severity**: minor

---

## Suspicions

- **S1. No unique constraint on `(provider, subject)` in `integration_accounts`**, while `bindGoogleIdentity` and `upsertGoogleAccount` both look up a subject and then insert/update (`account-identity.ts:20-28, 35-46, 90-100`). Two concurrent callbacks for the same Google subject on two accounts can both pass the `other` check and both bind it. Would confirm: run two `bindGoogleIdentity` calls against the same DB file from two connections inside a `BEGIN IMMEDIATE`-less window; or inspect `migrations.ts` for the constraint (none exists). Fix if confirmed: `CREATE UNIQUE INDEX … ON integration_accounts(provider, subject) WHERE subject IS NOT NULL`.
- **S2. The OpenCode session header sends the route name as the session id** (`router.ts:82-84`: `[OPENCODE_SESSION_HEADER]: route.name`), so every conversation on that route shares one gateway session, while the code calls the header "a property of that route". `StreamOptions.contextKey` is documented "never sent to the upstream provider" (`openai.ts:44`). Would confirm: the gateway's docs/source on whether `x-opencode-session` is per-conversation (caching, concurrency, quota). If so, the header should be set per request from `contextKey`.
- **S3. `fetchUsageResume` turns every failure into `null`** (`usage.ts:73-77`), which `suspendFor` maps to the fixed cooldown — intended per its comment. Not a defect, noted for completeness.

## Files read

- src/integrations/account-identity.ts — read
- src/integrations/accounts.ts — read
- src/integrations/account-store.ts — read
- src/integrations/canvas.ts — read
- src/integrations/google.ts — read
- src/integrations/google-auth.ts — read
- src/integrations/google-calendar.ts — read
- src/integrations/google-gmail.ts — read
- src/integrations/google-sync-state.ts — read
- src/integrations/normalize.ts — read
- src/integrations/oauth-state.ts — read
- src/integrations/sync.ts — read
- src/integrations/sync-store.ts — read
- src/providers/errors.ts — read
- src/providers/openai.ts — read
- src/providers/router.ts — read
- src/providers/usage.ts — read
- src/scheduler/push.ts — read
- src/scheduler/schedule-dispatch.ts — read
- src/scheduler/schedules.ts — read
- src/scheduler/schedule-store.ts — read
- src/scheduler/schedule-types.ts — read
- src/scheduler/triggers.ts — read
