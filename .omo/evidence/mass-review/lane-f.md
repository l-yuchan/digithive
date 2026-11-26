# Lane F review — web client (`web/src/**/*.ts(x)`, `web/sw.js`)

Scope: every TypeScript/TSX file under `apps/harness/web/src`, plus `apps/harness/web/sw.js`, each read in full. Cross-references into `src/` (server routes, conversation loop, scheduler, work record) and `tests/` were followed only to confirm or refute a candidate; every finding below is about a file in scope. Line numbers were verified against the files at review time.

---

## Findings

### F1 — The Work tab's run detail is fetched once and can be overwritten by another run's events

**File:line:** `web/src/work/WorkPanel.tsx:155-175` (with the 2 s poll at `:147-153`)

**Code:**

```ts
  const openRun = async (runId: string) => {
    if (openId === runId) { setOpenId(null); return; }
    setOpenId(runId);
    setEvents([]);
    setEventsError(null);
    setEventsLoading(true);
    try {
      const body = await getJson(`/api/runs/${runId}/events`, z.object({ events: z.array(EventSchema) }));
      setEvents(body.events);
    } catch (failure) {
      setEventsError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setEventsLoading(false);
    }
  };
```

**Scenario.**

1. *Stale log.* `runs` polls every 2 s (`:149-151`), so a row's status badge moves "진행 중" → "완료" while its detail stays open, but `setEvents` runs only once per open. Open a running run, let it finish: the row says 완료, the log underneath is frozen at the click. `CANCELLABLE` (`:28`) already tells the component which runs are live.
2. *Wrong run's log.* No request token. Click run A, then run B before A's response lands. B's response sets B (`:169`, header follows `openId`), then A's slower response calls `setEvents(A)` — **A's events render under B's header**. Whichever response's `finally` runs first also clears `setEventsLoading` while the other is pending.

**Tests would not catch it:** no file under `tests/` imports `WorkPanel.tsx` (the only web modules imported are `buildCheck`, `markdown`, `pushDiagnostics`, `routes`, `submit`, `spinner`, `formatTool`, `workflowTypes`), and there is no DOM test harness.

**Suggested minimal fix.** Keep the requested id in a ref and drop responses whose id is no longer current; re-fetch the open run's events on the existing 2 s tick while its status is in `CANCELLABLE`.

**Severity:** major.

---

### F2 — `useCollection.mutate` keeps a single `pending` slot, so overlapping actions re-enable each other

**File:line:** `web/src/knowledge/useCollection.ts:39-46`

**Code:**

```ts
  function mutate(label: string, request: () => Promise<void>) {
    setPending(label);
    setActionError(null);
    request()
      .then(refresh)
      .catch((error: unknown) => setActionError(`${label} 실패: ${String(error)}`))
      .finally(() => setPending(null));
  }
```

**Scenario.** Pick a large file (`FileSection.tsx:24-31` → `mutate("파일 업로드", …)`), then confirm a delete before the upload finishes (`FileSection.tsx:60-76` → `mutate("파일 삭제", …)`). The upload resolves first; its `.finally` sets `pending = null` while the delete is still in flight. `busy = pending !== null` (`FileSection.tsx:11`, `MemorySection.tsx:21`) flips to `false`, so the upload input and every delete control re-enable (`FileSection.tsx:23, 68, 86, 96`; `MemorySection.tsx:151, 164`), the "…중" status line vanishes, and a second delete of the same row can be started on top of the first. A *successful* later action also never clears an earlier `actionError` (`:12, :41, :43`), so a stale failure stays on screen.

**Tests would not catch it:** `useCollection.ts` is imported by no test; `tests/knowledge-http.test.ts` exercises the HTTP routes.

**Suggested minimal fix.** Track in-flight mutations with a counter (or a keyed map) and clear `pending` only when the last one settles.

**Severity:** major.

---

### F3 — Saving a workflow never fetches the saved workflow's detail when the selection changed, and `loadDetail` cannot target the saved id

**File:line:** `web/src/workflows/WorkflowsPanel.tsx:139-150`, with `loadDetail` at `:76-92` and `loadList` at `:47-73`

**Code:**

```ts
  const saved = async (id: string, rebound: readonly string[]) => {
    setEditor(null);
    setSelectedId(id);
    ...
    if (id !== selectedId) setDetail(null);
    setDetailError(null);
    await Promise.all([loadList(), id === selectedId ? loadDetail() : Promise.resolve()]);
  };
```

```ts
  const loadDetail = useCallback(() => {
    if (!selectedId) return Promise.resolve();
    const id = encodeURIComponent(selectedId);
```

**Scenario.** `saved` receives the id it saved but decides *what to load* from the closure's `selectedId`, and `loadDetail` itself closes over `selectedId`. Create a workflow with "새 워크플로" (`:174` sets `editor = "new"` without touching `selectedId`) while another workflow is selected; save it. `saved(newId)` sees `id !== selectedId`, so it blanks the detail pane (`setDetail(null)`, `:147`) and **substitutes `Promise.resolve()` for the detail request** (`:149`). `setSelectedId(newId)` and `setDetail(null)` are queued in the same commit, so the detail effect (`:115-129`) sees `selectedId` change and fires `loadDetail()` once — but both `loadDetail` calls run against a `useCallback` whose `selectedId` is the value from the render that produced them, and the pane renders whatever `detail` holds for the *current* `selectedId` (`:112-113`). The pane therefore stays at "워크플로 상세 정보를 불러오는 중입니다" (`:287`) until the 5 s list poll changes `selectedId` again and the effect re-runs; until then, a workflow was saved but never shown. Editing the selected workflow happens to work only because the closure equals `id`; the parameter `id` is never used to pick the request.

**Tests would not catch it:** no file under `tests/` imports `WorkflowsPanel.tsx`; `tests/workflow-web-schema.test.ts` validates only `WorkflowsResponseSchema`.

**Suggested minimal fix.** Make the loader take the id (`loadDetailFor(id)`) and always `await loadDetailFor(id)` in `saved`, independent of `selectedId`.

**Severity:** major.

---

### F4 — Both save forms register an error reporter that can never run, and report after they have unmounted

**File:line:** `web/src/workflows/ScheduleForm.tsx:28-52` with the reporter at `:58-63`; the same shape in `web/src/workflows/WorkflowForm.tsx:30-54` with the reporter at `:61-66`

**Code:**

```ts
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      ...
      await onSaved();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(false);
    }
  };
```

```tsx
      onSubmit={(event) => {
        event.preventDefault();
        reportAsync(save(), (failure) => setError(String(failure)));
      }}
```

**Scenario.** `save` catches every rejection and returns a fulfilled promise, so the `reportAsync` reporter in `onSubmit` is unreachable — a branch that can never run. The only reporting channel is `save`'s own `catch`, which is live *after* `await onSaved()`. `WorkflowDetail` passes `onSaved={async () => { setEditor(null); setNotice(...); await onChanged(); }}` (`WorkflowDetail.tsx:222-227`), unmounting the form before `onChanged` settles; `WorkflowDetail.removeWorkflow` has the same shape with `await onDeleted()` (`:61-79`, `:72`). `onChanged`/`onDeleted` are `WorkflowsPanel`'s `async () => Promise.all([loadList(), loadDetail()])` (`:276-278`) and `deleted` (`:152-159`, which awaits `loadList()`). Both helpers absorb their own failures today, but `loadDetail`'s `Promise.all` and `loadList` reject on a thrown non-`getJson` error (e.g. a `z` schema-parse inside a themed path) — and in that window React 19 discards `setError`/`setSaving` on the unmounted form, so a failed reload after a save is invisible: the list is stale, the dialog is gone, and nothing says so.

**Tests would not catch it:** `ScheduleForm.tsx`, `WorkflowForm.tsx`, `WorkflowDetail.tsx` are imported by no test.

**Suggested minimal fix.** Call `onSaved()` outside the `try` that owns the form's error state (the dialog close should be decided by the parent after its reload), and delete the unreachable `reportAsync` wrapper.

**Severity:** minor.

---

### F5 — A poll failure can contradict the save notice on the same screen

**File:line:** `web/src/workflows/WorkflowsPanel.tsx:88-91`, `:94-104`, `:115-129` and `:142-148`

**Code:**

```ts
        setDetailError((current) => (current?.id === selectedId ? null : current));
```

**Scenario.** `loadList` (5 s) and `loadDetail` (2–5 s) run continuously. A `loadDetail` request issued *before* a save can resolve *after* `saved` set the notice (`:142-146`) and cleared `detailError` (`:148`); if that request failed, its `.catch` at `:91` re-sets `detailError` for the id just saved, and the panel then renders "선택한 워크플로를 불러오지 못했습니다" (`:226-232`) directly under "워크플로를 저장했습니다". The next successful poll silently removes it. A transient network hiccup therefore reports a save and a failure for the same object at the same time.

**Tests would not catch it:** no test imports `WorkflowsPanel.tsx`.

**Suggested minimal fix.** Stamp loads with a sequence number and let only the newest load clear or set `detailError`, and suppress a load that started before the last successful save.

**Severity:** minor.

---

### F6 — `App.tsx` interpolates session and entry ids into URLs raw while sibling call sites in the same file encode

**File:line:** `web/src/App.tsx:527` (`saveRename`), `:557` (`saveEdit`), `:568` (`regenerate`), `:583` (`switchBranch`), `:594` (`fork`); contrast `ChatView.tsx:322` (`cancelQueued`), `ChatView.tsx:291` (`useQueue`)

**Code:**

```ts
      await sendJson("PATCH", `/api/sessions/${renaming.id}`, { title: renaming.title });
```

**Scenario.** Ids are `crypto.randomUUID()` today (`src/core/sessions.ts:74`), so this is latent. But the same codebase treats the same ids as pass-through values elsewhere (`ChatView` encodes every one of them). If an id ever carries a `/` or a `?` — a slug, a fork id derived from user text, a future import path — the request lands on a **different route**: `POST /api/sessions/<a>/<b>/leaf` and the delete at `/api/sessions/<a>/<b>` no longer match `/^\/api\/sessions\/([^/]+)(?:\/(entries|messages))?$/` (`src/server/app.ts:578-586`), so a rename or delete silently targets nothing (and a 404 surfaces only as a red banner). `removeSession` (`:536-551`) passes the id the same way.

**Tests would not catch it:** every id used in `tests/` is a UUID; `tests/router-contract.test.ts` covers `routes.ts`, not `App.tsx`.

**Suggested minimal fix.** Wrap each interpolated id in `encodeURIComponent`, matching `ChatView.tsx:291`.

**Severity:** minor.

---

### F7 — The composer is never disabled while a submit is pending; a double Enter sends the message twice

**File:line:** `web/src/App.tsx:499-517` (the `sending` flag), `:720-724`; `web/src/chat/ChatView.tsx:273`; `web/src/composer/Composer.tsx:10-11, 68`

**Code:**

```tsx
      {/* `sending` only blocks a second submit of the same box; a running answer never
          removes the invitation to type. */}
      <span className="visually-hidden" data-testid="sending" aria-live="polite">
        {sending ? "전송 중" : ""}
      </span>
```

```tsx
        <Composer onSend={props.onSend} />
```

**Scenario.** `ChatView` renders `Composer` without `busy`, whose default is `false` (`Composer.tsx:11`), so the submit button's `disabled={busy}` (`:68`) is never true. `sending` lands only in a visually hidden live region. Press Enter twice quickly: two `POST /api/sessions/<id>/messages` (`App.tsx:507`) are issued, and the server, seeing a turn already in flight, enqueues the second (`src/surfaces/conversation/surface.ts:196-201`) — one typed message produces two answers. The comment at `:720-721` promises that `sending` "blocks a second submit", which the code does not do.

**Tests would not catch it:** `tests/submit.test.ts` tests `shouldSubmit`; nothing renders `App` or `Composer`.

**Suggested minimal fix.** Thread `busy={sending}` from `App` through `ChatView` to `Composer` (the prop already exists) and clear it in `send`'s `finally`.

**Severity:** minor.

---

### F8 — A tool result ordered before its call yields two cards, one permanently "실행 중"

**File:line:** `web/src/MessageParts.tsx:46-66`

**Code:**

```ts
      case "tool_call":
        callIndex.set(event.callId, blocks.length);
        blocks.push({ kind: "tool", pair: { call: event, result: null } });
        break;
      case "tool_result": {
        const at = callIndex.get(event.callId);
        const existing = at === undefined ? undefined : blocks[at];
        if (at !== undefined && existing?.kind === "tool")
          blocks[at] = { kind: "tool", pair: { call: existing.pair.call, result: event } };
        else
          blocks.push({
            kind: "tool",
            pair: { call: { type: "tool_call", id: event.id, callId: event.callId, name: event.name, detail: "" }, result: event },
          });
```

**Scenario.** `App.tsx` can hand the renderer a `tool_result` before its `tool_call` in array order: `"event"` replaces and re-sorts by `id` (`App.tsx:167-182`), and `mergeSnapshot` (`:74-92`) can keep a locally ordered list whole through a reconnect. In that order the result takes the `else` branch, pushes a block, and **writes nothing back to `callIndex`**. The real `tool_call` that follows is appended as a *second* block for the same `callId`: one card "완료" with the result and a synthetic empty 입력, one card "실행 중" that never finishes (its result was already consumed) until a reload replaces the transcript. The function's own doc says "a result joins the call it answers"; this path does not join.

**Tests would not catch it:** nothing imports `MessageParts.tsx`; `tests/conversation.test.ts:140-181, 312-353` assert stored event shapes, not client grouping.

**Suggested minimal fix.** After the fallback `push`, also `callIndex.set(event.callId, blocks.length - 1)`.

**Severity:** minor.

---

### F9 — `AccountsPanel.load` never rejects, so both error wrappers are dead and one failed poll shows an error beside live data

**File:line:** `web/src/connections/AccountsPanel.tsx:32-56`, rendered at `:155-167`

**Code:**

```ts
  const load = useCallback(
    () =>
      getJson("/api/accounts", AccountsResponseSchema)
        .then((body) => { setState(body); setLoadError(null); })
        .catch((error: unknown) => setLoadError(String(error))),
    [],
  );
  ...
    void load().catch((error: unknown) => setLoadError(String(error)));
    const timer = window.setInterval(
      () => reportAsync(load(), (error) => setLoadError(String(error))),
      20_000,
    );
```

**Scenario.** `load` ends in `.catch`, so its promise is always fulfilled: the `.catch` at `:53` and the `reportAsync` reporter at `:55` can never run. Meanwhile any single 20 s poll failure sets `loadError`, rendering the "계정 상태를 불러오지 못했습니다" error card (`:155-167`) *next to the still-populated account cards* (`state` is untouched), and the next successful poll silently removes it. The user cannot tell a transient poll failure from "no account data", and the error message claims the state could not be loaded while it is displayed.

**Tests would not catch it:** no test imports `AccountsPanel.tsx`; `tests/account-http.test.ts` drives the HTTP layer.

**Suggested minimal fix.** Let `load` reject and report in one place, and render a poll failure as a "last refresh failed" note above the data rather than a hard error card.

**Severity:** minor.

---

### F10 — `waitForActiveWorker` watches one captured worker and misses an activated replacement

**File:line:** `web/src/connections/pushDiagnostics.ts:134-180`

**Code:**

```ts
  const worker =
    registration.active?.state === "activating"
      ? registration.active
      : (registration.installing ?? registration.waiting ?? registration.active);
  ...
  if (registration.active?.state === "activated") return Promise.resolve(registration);
  ...
    const onChange = () => {
      if (worker.state === "activated") finish(() => resolve(registration));
      else if (worker.state === "redundant") finish(() => reject(new ServiceWorkerActivationError(...)));
    };
```

**Scenario.** `worker` is chosen once. If it becomes `"redundant"` while the browser installs and activates a **replacement**, `registration.active` is the new live worker but `onChange` only ever inspects the captured handle, sees `"redundant"`, and rejects. `PushPanel.enablePush` then fails before subscribing (`PushPanel.tsx:92-96`), showing "구독 실패" although push is available once the update settles. Nothing listens for `navigator.serviceWorker` `controllerchange`, so the successful activation is invisible. The `settled`/`finish` latch around the timeout is correct; the defect is the stale handle alone.

**Tests would not catch it:** `tests/push-diagnostics.test.ts` drives a fake worker through a single `statechange`; no case emits `redundant` and then supplies a new active worker.

**Suggested minimal fix.** In `onChange`, check `registration.active?.state === "activated"` before the captured `worker.state`.

**Severity:** minor.

---

### F11 — The push panel writes internal steps into its visible state and leaves it disagreeing with the diagnostics after an early return

**File:line:** `web/src/connections/PushPanel.tsx:60-85`, summary at `:178-184`

**Code:**

```ts
    const commit = (patch: Partial<PushDetails>) => {
      Object.assign(details, patch);
      setPushDetails({ ...details });
      if (patch.phase !== undefined) setPushState(patch.phase);
    };
    ...
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
        setPushState("이 브라우저는 푸시를 지원하지 않습니다");
        return;
      }
      commit({ phase: "알림 권한 요청" });
      const permission = await Notification.requestPermission();
      commit({ permission });
      if (permission !== "granted") {
        setPushState(permission === "denied" ? "알림 권한이 거부되었습니다" : "알림 권한이 허용되지 않았습니다");
        return;
      }
```

**Scenario.** `pushState` is the badge (`data-testid="push-state"`); every `commit({ phase })` overwrites it with an internal step name, which is acceptable mid-flow. The early returns at `:72-74` and `:82-84` set the badge to a terminal sentence but leave `pushDetails.phase` where it was, so the `<details>` summary (`:178-184`) reads "진단 정보 · 알림 권한 요청" beside a badge that says the browser cannot push at all — two visible statements that contradict each other, and the diagnostics a bug report would be built from carry a stale phase.

**Tests would not catch it:** `PushPanel` is imported by no test; `tests/push-diagnostics.test.ts` covers the helpers only.

**Suggested minimal fix.** Give the early returns a `commit({ phase: … })` so the details and the badge move together.

**Severity:** minor.

---

### F12 — The queue poll swallows every failure and keeps polling a dead session forever

**File:line:** `web/src/chat/ChatView.tsx:286-317`, banner at `:237`

**Code:**

```ts
    void getJson(`/api/sessions/${encodeURIComponent(sessionId)}/queue`, QueueSchema)
      .then((value) => { if (!cancelled) setQueue(value); })
      .catch(() => undefined);
    ...
    const stop = read();
    const timer = setInterval(() => read(), 2_000);
```

**Scenario.** A 401 (expired cookie) or 404 (session deleted in another tab) is discarded, so the last queue snapshot persists indefinitely; a paused banner ("이전 응답이 실패해 멈췄습니다", `:237`) stays after another tab resumed and ran it, and its "다시 시작" button (`resumeQueue`, `:326-328`) then fails with only a generic error. A failing server is also re-polled every 2 s for the life of the tab with no backoff. (Overlapping reads are individually cancelled at `:296-298`, so only the newest renders — that part is correct.)

**Tests would not catch it:** no test imports `ChatView.tsx`.

**Suggested minimal fix.** Keep the last poll error in state and render it, and stop the interval after a 401/404.

---

### F13 — Session-list and entry reloads accept out-of-order responses, so a slower search overwrites a newer one

**File:line:** `web/src/App.tsx:282-298` (`reloadSessions`, `reloadEntries`), called per keystroke at `:606-614`

**Code:**

```ts
  const search = async (value: string) => {
    setQuery(value);
    try {
      await reloadSessions(value);
    } catch (error) { ... }
  };
```

```ts
  const reloadSessions = useCallback(async (q?: string) => {
    const suffix = q && q.trim().length > 0 ? `?q=${encodeURIComponent(q.trim())}` : "";
    const body = await getJson(`/api/sessions${suffix}`, z.object({ sessions: z.array(SessionSchema) }));
    dispatch({ type: "sessions", sessions: body.sessions });
```

**Scenario.** `search` fires on every keystroke (`ConversationSidebar.tsx:77`); typing "a" then "ab" issues two overlapping GETs and whoever resolves last dispatches. A slow `?q=a` landing after `?q=ab` replaces the list with the "a" matches while the box shows "ab". The same dispatcher is shared by the rename reload (`:303-305`) and `saveRename` (`:531`), so a rename-triggered reload can also clobber a newer search. `reloadEntries` only dispatches from the completion/abort handlers of one active session (`:464`, `:475`), so its race window is smaller, but it has no guard either.

**Tests would not catch it:** nothing renders `App`.

**Suggested minimal fix.** Keep a request counter in a ref and drop any response that is not from the newest request.

---

### F14 — The Workflows tab fetches the account list every 20 s only to raise a panel-level error nothing consumes

**File:line:** `web/src/workflows/WorkflowsPanel.tsx:64-85`, `:98-107`, banner at `:236-242`

**Code:**

```ts
  // The form no longer needs the account list; it only reports whether the filter
  // check for a collection job could reach it.
  const loadAccounts = useCallback(
    () =>
      getJson("/api/accounts", AccountsResponseSchema)
        .then(() => { setAccountsError(null); })
        .catch((error: unknown) => setAccountsError(String(error))),
    [],
  );
```

**Scenario.** The response body is discarded and the comment says the form no longer needs it. `accountsError` is then shown **twice**: once as a panel-wide error card (`:236-242`) and once inside `ExecutorFields`, only for a script executor (`WorkflowFields.tsx:115-119`). A transient `/api/accounts` hiccup therefore makes the whole Workflows tab show "계정 정보를 불러오지 못했습니다" although nothing on the screen depends on it, and the 20 s poll re-fetches the full payload indefinitely.

**Tests would not catch it:** no test imports `WorkflowsPanel.tsx`.

**Suggested minimal fix.** Fetch accounts once (or drop the fetch) and keep the error scoped to the script-executor field.

---

### F15 — The schedule toggle sends a negated prop instead of the checkbox's own value

**File:line:** `web/src/workflows/ScheduleSection.tsx:61-63`, handler `WorkflowDetail.tsx:172-184`

**Code:**

```tsx
                <input
                  type="checkbox"
                  checked={schedule.enabled}
                  disabled={busy}
                  onChange={() => onToggle(schedule)}
```

```ts
                { enabled: !schedule.enabled },
```

**Scenario.** The new value is computed from the `schedule` prop of the render that produced the handler, not from `event.target.checked` (`AccountSources.tsx:67` does use `event.target.checked` for the analogous control). Because the panel re-polls every 2–5 s (`WorkflowsPanel.tsx:115-129`), a render can land between the click and the PATCH; if it carries a copy whose `enabled` already changed (another tab toggled, or an earlier in-flight PATCH resolved), `!schedule.enabled` sends the *previous* state back and the checkbox visibly springs back. The UI then shows a state the server did not receive.

**Tests would not catch it:** nothing imports `ScheduleSection.tsx`.

**Suggested minimal fix.** `onChange={(event) => onToggle(schedule, event.target.checked)}` and PATCH that value.

---

## Suspicions

Need a live run or one more read; not counted as findings.

1. **Double answer from a double Enter.** F7 establishes the guard is missing; whether two Enter presses can land before the first POST resolves (and thus produce two queue rows) should be confirmed with `scripts/mock-provider.ts` and `DELAY_MS` set. *Would confirm:* two `turn.response.started` events for one typed message.
2. **`mergeSnapshot` compares character counts.** `App.tsx:74-92` keeps the local events when `textSize(local) > textSize(incoming)`, and `textSize` (`:61-67`) counts only text/thinking, so an entry ahead only in tool events loses to the server copy, while an entry ahead in text keeps a local list whose event ids can disagree with the incoming `siblingIds`/`siblingIndex`. *Would confirm:* reconnect mid-stream with an open tool call and compare rendered block order with a reload.
3. **Approval-gated tools can never run from a conversation.** `src/surfaces/conversation/loop.ts:438-442` denies any tool whose policy decision is not `allow` (`"정책이 이 호출을 거부했습니다."`), and the shipped default policy asks before reading `*.env` files (`src/core/policy.ts:50-56`). The web client has no confirm affordance to lift that, so with the default policy the model can never read an env file in a conversation. *Would confirm:* send "read .env" through the mock provider and observe `tool.denied` with `decision: "ask"`. Reported as a suspicion because it may be an intentional design choice.
4. **`null` JSON arguments from JSON mode.** `WorkflowArgsEditor.tsx:8` seeds a json param with `"null"`; `valueMatchesParamType("json", null)` passes (`workflowTypes.ts:26-36`, `JSON.stringify(null)` → `"null"`), so JSON mode can send an explicit `null` the field mode never sends. *Would confirm:* `POST /api/workflows/<id>/run` with `{"arg": null}` and inspect the server's response.
5. **`daily.time` is not validated client-side.** `scheduleDraft.ts:72-80` validates only the time zone, while `workflowTypes.ts:85` mirrors the server's `HH:mm`; a browser yielding `HH:mm:ss` from `<input type="time">` would get an opaque `invalid_schedule` 422 with no field hint. *Would confirm:* read the `time` input value in the target browsers.
6. **Push diagnostics render the page URL.** `pushDiagnostics.ts:102-112` includes `href` in `describeBrowserInfo`, shown on screen (`PushPanel.tsx:184`). Not a secret in itself; listed because a screenshot for a bug report carries the full address.

---

## Dropped after verification (checked, not defects)

- `routes.ts`, `readLocation`, `addressFor` — agree with `src/server/auth.ts:65-74` and `TAB_ROUTE`; enforced by `tests/router-contract.test.ts`.
- `buildCheck.ts` one-shot latch — matches its documented contract and `tests/build-watch.test.ts`.
- `sw.js` — non-JSON push data falls back to the default payload; the click URL is the fixed `"/"`.
- `formatTool.ts`, `spinner.ts`, `markdown.ts`, `format.ts`, `submit.ts` — unit-tested (`tests/web-utils.test.ts`, `tests/markdown.test.ts`, `tests/submit.test.ts`).
- `argsDraft.ts` validation — every invalid input ends in a client-side error naming the field; checked against `valueMatchesParamType`.
- `MemorySection.tsx` `stale` (`:20-23`) — worked through in both history modes; correct in each.
- `WorkflowDetail.removeWorkflow` conflict detection (`:76`) — `message.includes('"schedules_present"')` matches because `api.ts:52-54` embeds the response body in the thrown message.
- Everything else in the file list — read; no defect I can point at with file and line.

---

## Files read

- `apps/harness/web/sw.js` — read
- `apps/harness/web/src/App.tsx` — read
- `apps/harness/web/src/MarkdownText.tsx` — read
- `apps/harness/web/src/MessageParts.tsx` — read
- `apps/harness/web/src/SpinnerView.tsx` — read
- `apps/harness/web/src/api.ts` — read
- `apps/harness/web/src/async.ts` — read
- `apps/harness/web/src/auth/Login.tsx` — read
- `apps/harness/web/src/build.d.ts` — read
- `apps/harness/web/src/buildCheck.ts` — read
- `apps/harness/web/src/chat/ChatView.tsx` — read
- `apps/harness/web/src/composer/Composer.tsx` — read
- `apps/harness/web/src/composer/submit.ts` — read
- `apps/harness/web/src/connections/AccountCard.tsx` — read
- `apps/harness/web/src/connections/AccountSources.tsx` — read
- `apps/harness/web/src/connections/AccountsPanel.tsx` — read
- `apps/harness/web/src/connections/ConnectionsPanel.tsx` — read
- `apps/harness/web/src/connections/PushPanel.tsx` — read
- `apps/harness/web/src/connections/accounts.ts` — read
- `apps/harness/web/src/connections/oauth.ts` — read
- `apps/harness/web/src/connections/pushDiagnostics.ts` — read
- `apps/harness/web/src/format.ts` — read
- `apps/harness/web/src/formatTool.ts` — read
- `apps/harness/web/src/knowledge/FileSection.tsx` — read
- `apps/harness/web/src/knowledge/KnowledgePanel.tsx` — read
- `apps/harness/web/src/knowledge/MemorySection.tsx` — read
- `apps/harness/web/src/knowledge/knowledgeApi.ts` — read
- `apps/harness/web/src/knowledge/useCollection.ts` — read
- `apps/harness/web/src/main.tsx` — read
- `apps/harness/web/src/markdown.ts` — read
- `apps/harness/web/src/routes.ts` — read
- `apps/harness/web/src/sidebar/ConversationSidebar.tsx` — read
- `apps/harness/web/src/spinner.ts` — read
- `apps/harness/web/src/styles.css` — skipped: CSS only, outside the `*.ts`/`*.tsx`/`sw.js` scope
- `apps/harness/web/src/work/WorkPanel.tsx` — read
- `apps/harness/web/src/workflows/ErrorMessage.tsx` — read
- `apps/harness/web/src/workflows/RunDialog.tsx` — read
- `apps/harness/web/src/workflows/RunResult.tsx` — read
- `apps/harness/web/src/workflows/ScheduleForm.tsx` — read
- `apps/harness/web/src/workflows/ScheduleSection.tsx` — read
- `apps/harness/web/src/workflows/ScheduleTriggerFields.tsx` — read
- `apps/harness/web/src/workflows/WorkflowArgsEditor.tsx` — read
- `apps/harness/web/src/workflows/WorkflowDefinition.tsx` — read
- `apps/harness/web/src/workflows/WorkflowDetail.tsx` — read
- `apps/harness/web/src/workflows/WorkflowFields.tsx` — read
- `apps/harness/web/src/workflows/WorkflowForm.tsx` — read
- `apps/harness/web/src/workflows/WorkflowHistory.tsx` — read
- `apps/harness/web/src/workflows/WorkflowList.tsx` — read
- `apps/harness/web/src/workflows/WorkflowParamsEditor.tsx` — read
- `apps/harness/web/src/workflows/WorkflowsPanel.tsx` — read
- `apps/harness/web/src/workflows/argsDraft.ts` — read
- `apps/harness/web/src/workflows/scheduleDraft.ts` — read
- `apps/harness/web/src/workflows/workflowDraft.ts` — read
- `apps/harness/web/src/workflows/workflowTypes.ts` — read
