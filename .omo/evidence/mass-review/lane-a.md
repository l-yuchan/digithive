# Lane A review: `apps/harness/src/server/*.ts`

All seven server files were read in full. Checks performed: `bun run typecheck` in `apps/harness` (passed, exit 0), plus two throw-away bun scripts (deleted afterwards; `git status` shows only changes that were already there) that drove the route handlers directly. No repository file was changed.

Process note, because it affects how much to trust this list: my first draft contained claims I had written from hypotheses and then falsified when following cross-references — schedule `PATCH` args not validated (they are, `schedule-store.ts:149`), schedule `run` with blank args (validated, `workflow-run.ts:67-68`), `/api/push/subscribe` being public (it is not), and each SSE stream opening a 50 ms poll (one shared poll serves all subscribers). Those are gone. Every finding below was checked against the called code; items 1 and 2 were reproduced by running the handlers.

## Findings

### 1. A malformed percent escape in a route segment throws inside the account handlers and escapes the app as an unhandled rejection

**File:** `apps/harness/src/server/account-routes.ts:247-248` (PATCH), `:275` (DELETE)

```ts
    const accountId = decodeURIComponent(sourceMatch[1] ?? "");
    const source = parseSource(decodeURIComponent(sourceMatch[2] ?? ""));
```

```ts
    const accountId = decodeURIComponent(deleteMatch[1] ?? "");
```

The regexes run against `url.pathname`, which is **already** percent-decoded except for reserved characters (`%25` stays `%25`, a malformed `%E0%A4%A` stays as-is). So these `decodeURIComponent` calls are a second decode of an already-decoded string. Two consequences:

- **Throw (reproduced).** `PATCH /api/accounts/bad%E0%A4%A/sources/gmail` and `DELETE /api/accounts/bad%E0%A4%A` both produce `URIError: URI malformed` out of `handleAccountRequest`. `createApp` calls the delegated handlers with no `try` (`app.ts:287-296`), so the error escapes the async request function. `Bun.serve` answers 500 with no body and the error surfaces as an unhandled rejection in the process log.
- **Wrong id (reproduced).** `PATCH /api/accounts/x%25y/sources/gmail` decodes to account id `x%y`, so the lookup targets a *different* id than the one in the URL. Today account ids are `crypto.randomUUID()` (`account-identity.ts:51`), so no stored id contains `%`; the lookup simply misses and returns 404. It becomes a real hazard the moment any import or migration writes a non-UUID id.

`app.ts` itself does not decode session ids, so the two modules disagree on the same convention. Minimal fix: drop the `decodeURIComponent` calls and use `sourceMatch[1]` / `deleteMatch[1]` directly. **Severity: minor** (authenticated input triggers it; no data loss, but it is an unhandled error path on user input, and it is the only place in the server that decodes a path segment twice).

**Why tests miss it.** `accounts.test.ts` and `sync-contracts.test.ts` use plain UUIDs; no test sends a `%` segment.

### 2. `POST /api/runs/:id/cancel` returns the whole `RunRow` under a contract that declares only `{ id, status, createdAt }`

**File:** `apps/harness/src/server/schedule-routes.ts:100`

```ts
    return json({ run: getRun(deps.db, runId), cancelled: result.changed });
```

The client's `CancelRunResponseSchema` (`web/src/workflows/workflowTypes.ts:164-167`) is `{ run: QueuedRunSchema | null, cancelled: boolean }` with `QueuedRunSchema = { id, status, createdAt }` (`:150-155`). `getRun` returns the full `RunRow` (`src/surfaces/work/record.ts:54-76`): `goal`, `stateJson`, `resultJson`, `budgetJson`, `executorJson`, lease fields. Two consumers already read this differently: `WorkflowHistory.tsx:29` parses through the schema (Zod strips the extras, silently), `WorkPanel.tsx:189` passes `z.unknown()` and keeps the raw row. Two concrete problems:

- **Payload.** Each cancel hands the browser the run's full state, result and budget — the largest blobs on the run row — for a screen that shows "cancelled".
- **Drift.** The server and the client contract disagree about the shape, and the disagreement is invisible because Zod strips rather than rejects. Switching the schema to `.strict()` (a reasonable tightening) breaks `WorkflowHistory` with no server change, and `QueuedRunSchema` will not validate `RunSummary`-shaped run lists anywhere the same schema is reused.

Minimal fix: project the contract's fields — `run: current ? { id: current.id, status: current.status, createdAt: current.createdAt } : null`, where `current = getRun(...)`. **Severity: minor.**

**Why tests miss it.** No server test asserts the cancel response shape; `workflow-http.test.ts` and `schedule-execution.test.ts` never call `/cancel` through a `Request`, and `CancelRunResponseSchema` has no server-side counterpart test.

### 3. The workflow search route ignores `limit`, so every HTTP search is fixed at the schema default of 20

**File:** `apps/harness/src/server/workflow-routes.ts:118-122`

```ts
      const search = WorkflowSearchSchema.safeParse({
        keyword: url.searchParams.get("keyword") ?? undefined,
        regex: url.searchParams.get("regex") ?? undefined,
        bm25: url.searchParams.get("bm25") ?? undefined,
      });
```

`WorkflowSearchSchema` declares `limit: z.number().int().min(1).max(50).default(20)` (`workflow-types.ts:239-254`) and the schema's own comment frames it as "the caller then asks for the detail sections it needs" — but the route never reads a `limit` parameter, so `search.data.limit` is always **20**. The agent tool (`src/tools/workflows.ts`) reaches the same schema through `searchWorkflowIds` and can pass a limit; the HTTP surface cannot. A user with 40 workflows cannot see past the newest 20 in any search, and `limit` is advertised in the contract with no way to set it from the only browser-facing surface. Minimal fix: `limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined`, so the default only applies when absent. **Severity: minor.**

**Why tests miss it.** `workflow-http.test.ts:61-79` searches with `?keyword=` and checks only that the expected workflow is present — never the page size or `limit`.

### 4. `GET /api/workflows/:id/runs` is hard-capped at 30 newest runs with no way to page further

**File:** `apps/harness/src/server/workflow-routes.ts:171-174`

```ts
    if (!getWorkflow(deps.db, id)) return json({ error: "workflow_not_found" }, 404);
    return json({ runs: runsForWorkflow(deps.db, id, 30) });
```

`runsForWorkflow` orders `created_at DESC LIMIT 30` (`workflow-store.ts:242-...`). A collection workflow fires hourly (its binding is `interval` with `enabled: true`, `workflows/collection.ts:64-80`), so it crosses 30 runs within about a day and everything older is unreachable through the API. The runs remain in the DB (the reconcile loop keeps adding), so the data is there; only the read path is cut. `/api/runs` has the same shape (no cursor, `record.ts:114`). Minimal fix: accept `?before=<created_at>` and pass it into `runsForWorkflow`, filtering `created_at < ?` — no schema change needed. **Severity: minor.**

**Why tests miss it.** Every workflow test creates one or two runs.

### 5. One corrupt `executor_json` row takes down `GET /api/accounts`

**File:** `apps/harness/src/server/account-routes.ts:53-56`

```ts
    const executor = z
      .object({ accountId: z.unknown().optional() })
      .safeParse(JSON.parse(row.executor_json));
```

`JSON.parse` throws on malformed text; `.safeParse` guards only the parsed *shape*. The query is `SELECT … FROM workflows` (every workflow, not just this account's), so a single hand-edited row, or a row written by an older schema and left behind, throws. `createApp` has no `try` around `handleAccountRequest` (`app.ts:287-296`), so the error escapes and `GET /api/accounts` — the screen that owns connecting accounts — fails wholesale because of a workflow it does not control. `readBuildId` in `main.ts:20-28` shows the house pattern for this exact case (`try` around the parse, `catch` returns a safe default). Minimal fix: wrap the parse in `try { … } catch { continue; }` per row. **Severity: minor.**

**Why tests miss it.** `accounts.test.ts` seeds only valid executors.

### 6. A concurrent account delete between the OAuth identity bind and `ensureCollectionWorkflow` leaves a collection workflow naming a deleted account, which the API will no longer let you save

**File:** `apps/harness/src/server/account-routes.ts:188-193`

```ts
      const bound = bindGoogleIdentity(deps.google.db, target.id, identity);
      …
      saveTokens(deps.google.db, deps.google.vaultSecret, target.id, tokens);
      ensureCollectionWorkflow(deps.google.db, target, deps.google.events);
```

`bindGoogleIdentity` re-reads the account and refuses a missing one (`integrations/account-identity.ts:80-84`), so the bind itself is safe. But `ensureCollectionWorkflow` acts on the `target` captured earlier and only checks whether the account *already has* a collection workflow (`workflows/collection.ts:48-52`). Sequence: owner starts the OAuth flow for account X (state row issued), in another tab deletes X — `deleteAccount` is one `DELETE FROM integration_accounts` (`account-identity.ts:62-65`) and `removeAccountWorkflows` deletes X's collectors — then the callback lands, binds X, and `ensureCollectionWorkflow` creates a **new** app-owned workflow plus an enabled interval binding whose executor is `{ kind: "script", path: "@builtin/collection.ts", args: [X] }`. That workflow now runs on schedule against a gone account. And the owner cannot repair it through the workflow screen: `collectionProblem` (`workflow-routes.ts:76-83`) refuses to save a collection workflow whose account is missing (`collection_not_permitted`), so the only exit is deleting it. Minimal fix: re-check `getAccount(deps.google.db, target.id)` after `saveTokens` and return `reason: "account_missing"` before `ensureCollectionWorkflow`, or run bind + tokens + ensure in one transaction. **Severity: minor** (narrow race, but it produces state the UI cannot repair).

**Why tests miss it.** `accounts.test.ts:439-529` covers expired state, replay and identity mismatch; none deletes the account between start and callback.

### 7. A deleted file on disk makes `DELETE /api/files/:id` throw instead of removing the row

**File:** `apps/harness/src/server/knowledge-routes.ts:86-92`

```ts
    if (request.method === "DELETE" && !file[2]) {
      const stored = readStoredFile(deps.db, id);
      if (!stored) return json({ error: "file_not_found" }, 404);
      unlinkSync(stored.meta.path);
      deps.db.query("DELETE FROM files WHERE id = ?").run(id);
      return json({ deleted: true });
    }
```

`readStoredFile` does `readFileSync(row.path)` (`files/store.ts:60-87`). If the file was removed out of band — a DB restored onto a new host, `HARNESS_FILES` wiped or repointed — the read throws ENOENT and the delete fails, so the stale row can never be cleared through the API; the same row makes `GET /:id/content` throw too. Separately, the unlink and the row delete are not one transaction: a crash or a locked DB between them leaves a row pointing at a missing file, which is precisely the state that then breaks DELETE. Minimal fix: `existsSync` before `unlink`, and run unlink + `DELETE` inside one `db.transaction` (or delete the row first and unlink best-effort). **Severity: minor.**

**Why tests miss it.** `knowledge-http.test.ts` deletes a file it has just uploaded, with the file present.

### 8. `POST /api/files` holds the upload in memory three times at once

**File:** `apps/harness/src/server/knowledge-routes.ts:45-76`

```ts
      const chunks: Uint8Array[] = [];
      …
      const stored = storeFile(deps.db, deps.filesRoot, {
        name,
        mime: request.headers.get("content-type") ?? "application/octet-stream",
        bytes: Buffer.concat(chunks),
      });
```

`chunks` holds the full body, `Buffer.concat` allocates a second full copy, and `storeFile` hashes and writes it (`files/store.ts:17-33`). With the default 10 MB limit (`app.ts:289`), peak use per upload is ~30 MB; a handful of parallel uploads on this personal server allocate hundreds of MB before anything is written. It is not a leak (all copies are freed when the response ends) and it cannot exceed `maxUploadBytes`, so it is memory efficiency rather than runaway growth. Minimal fix: hash while reading and pass the digest to `storeFile`, or concat once and reuse the buffer for hash + write. **Severity: minor.**

**Why tests miss it.** `knowledge-http.test.ts` checks the 413 boundary and the round trip, not peak memory.

### 9. `app.ts` re-exports `TAB_ROUTE` and no module imports it from there

**File:** `apps/harness/src/server/app.ts:169-170`

```ts
export { TAB_ROUTE };
const PAGES = "text/html; charset=utf-8";
```

`grep -rn 'TAB_ROUTE' apps/harness/src apps/harness/tests` shows the only consumers are `app.ts:189` (local use) and `tests/router-contract.test.ts:3`, which imports it from `../src/server/auth`, not from `app.ts`. The comment above the import ("The list lives here because the server must not depend on the web build to know its own routes; web/src/routes.ts mirrors it and tests/router-contract.test.ts keeps the two equal") states the opposite of where the list now lives: the pattern is defined in `auth.ts:61` (and `auth.ts:67` says "see app.ts TAB_ROUTE"), and the contract test reads it from `auth.ts`. So the comment points a maintainer at a file that only re-exports, and the re-export is dead. Minimal fix: drop `export { TAB_ROUTE }` from `app.ts`, and correct both comments to point at `auth.ts` as the single definition. **Severity: minor.**

**Why tests miss it.** No test asserts anything about `app.ts`'s exports; `router-contract.test.ts` only checks equality between `auth.TAB_ROUTE` and the client.

## Suspicions

### S1. A comment about the public route list that omits most of the list

`auth.ts:66-69` says "The tab routes (see app.ts TAB_ROUTE) are the client's own: the shell behind them carries the login gate, exactly like '/'. Nothing else becomes public for this." That sentence is placed directly above the `TAB_ROUTE` check, but the same function also makes `/api/health`, `/api/logout` and `/api/oauth/google/callback` public (`:72-74`). The callback is the one public route that mutates state (exchanges a code, saves tokens, creates a workflow). Its safety rests entirely on `consumeOAuthState` being single-use and issued only to an authenticated caller; I checked that `/api/oauth/google/start` is **not** public, and `accounts.test.ts:481-499` shows a second use of a state is refused, so no live vulnerability follows. **Not promoted:** the concrete fix is wording only, and the instructions exclude purely comment fixes. Recorded because the comment does mislead a reader about which routes are unauthenticated — and `auth.test.ts:92-99`, named "only the shell and session endpoints are public", checks four paths and none of the callback, so the tests reinforce the same misleading picture.

### S2. SSE stream cleanup when a client disappears without closing

`app.ts:108-127`: each stream owns a 10 s `ping` interval and an `EventLog` subscription; `Bun.serve` runs with `idleTimeout: 0` (`main.ts:139`), so an abandoned stream is kept open. The ping's `catch` calls `cleanup`, which is the only path that frees the interval when no `abort` event arrives. Whether that `catch` ever fires for a client that stopped reading but kept the socket depends on `ReadableStream`'s internal `desiredSize` behaviour in Bun — I could not settle that from the code alone. **What would confirm:** open a stream, stop reading without cancelling, and check that the interval is cleared within one ping period. For a personal, single-user server this is at most a handful of leaked streams, hence not promoted.

## Files read

- `apps/harness/src/server/app.ts` — read
- `apps/harness/src/server/auth.ts` — read
- `apps/harness/src/server/main.ts` — read
- `apps/harness/src/server/account-routes.ts` — read
- `apps/harness/src/server/workflow-routes.ts` — read
- `apps/harness/src/server/schedule-routes.ts` — read
- `apps/harness/src/server/knowledge-routes.ts` — read

Cross-referenced for judgment (out of scope): `src/events/log.ts`, `src/files/store.ts`, `src/scheduler/push.ts`, `src/scheduler/schedule-store.ts`, `src/integrations/account-identity.ts`, `src/integrations/accounts.ts`, `src/workflows/collection.ts`, `src/workflows/workflow-types.ts`, `src/workflows/workflow-store.ts`, `src/workflows/workflow-run.ts`, `src/workflows/workflow-search.ts`, `src/surfaces/conversation/surface.ts`, `src/surfaces/work/{cancel,record,runner,tool,agent-run}.ts`, `src/core/policy.ts`, `src/tools/builtins.ts`, `src/store/migrations.ts`, `web/src/{routes.ts,App.tsx}`, `web/src/workflows/{workflowTypes.ts,WorkflowHistory.tsx,WorkflowsPanel.tsx}`, `web/src/work/WorkPanel.tsx`, `web/src/chat/ChatView.tsx`, and tests `auth.test.ts`, `events-http.test.ts`, `knowledge-http.test.ts`, `workflow-http.test.ts`, `account-http.test.ts`, `accounts.test.ts`, `router-contract.test.ts`, `queue.test.ts`.
