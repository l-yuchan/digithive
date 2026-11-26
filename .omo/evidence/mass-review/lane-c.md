# Lane C review — store / core / events / files / knowledge

Scope: `src/store/*.ts`, `src/core/*.ts`, `src/events/*.ts`, `src/files/*.ts`, `src/knowledge/*.ts` (15 files, all read in full).

Every finding below was confirmed by one of: reading the caller/schema it depends on, or running a throwaway Bun probe against an in-memory / temp-file database opened with `openDatabase`/`migrate` (probe file deleted afterwards; no repository file was modified). Baseline `bun test tests/store.test.ts tests/tree.test.ts tests/queue.test.ts tests/run-state.test.ts tests/events.test.ts tests/context.test.ts tests/assets.test.ts tests/policy.test.ts` → **52 pass, 0 fail**, which is what makes the "tests would not catch it" statements concrete.

---

## Finding 1 — `EventLog` subscribers are fed at most one stored event per drain, so a listener that throws silently drops every event after it

**File:** `src/events/log.ts:95-103` (append), `src/events/log.ts:128-146` (after), `src/events/log.ts:157-173` (subscribe)

```ts
    const event = toLogged(EventRow.parse(row));
    for (const listener of this.#listeners) listener(event);
    return event;
```
```ts
  subscribe(listener: Listener, after = this.lastSeq()): () => void {
    let cursor = after;
    const drain = () => {
      for (const event of this.after(cursor)) {
        if (event.seq <= cursor) continue;
        cursor = event.seq;
        listener(event);
      }
    };
    const deliver: Listener = () => drain();
    this.#listeners.add(deliver);
    const poll = setInterval(drain, 50);
```

**Mechanism.** The registered listener is literally the drain function, and `append` calls it synchronously *after* the row is committed; the 50 ms poll calls the same drain. In `drain`, `cursor = event.seq` runs **after** `listener(event)`, so a callback that throws leaves the cursor unmoved and lets the exception escape into the writer. Probe output on `bun 1.4.5`:

```
append threw: Error: serialise failed
rows: [{seq:1, kind:"poison"}, {seq:2, kind:"after"}]
listener saw: ["after"]
```

So the concrete defect is: when a subscriber's callback throws for one event, the exception propagates out of `append` (the writer now sees a failure for a row that **was** committed), and — because `cursor = event.seq` is executed *after* `listener(event)` — every later event on that subscription is silently skipped **until another append happens to trigger a fresh `deliver()`**, which then delivers exactly one event (the newest), not the missing history. Subscribers that should have received the "poison" event and everything between it and the next append receive nothing. A second confirmation of the `cursor` behaviour: after one big appended event the subscriber saw it; after the next append it saw exactly one more (the newest), never the backlog.

**Concrete in-tree caller.** `src/server/app.ts:117` subscribes the SSE `send` callback, whose body is `controller.enqueue(encoder.encode(...JSON.stringify(event)...))` (`app.ts:104-108`). When that enqueue throws (closed controller / non-serialisable payload), the throw escapes into `EventLog.append`, aborting the writer's own code path (the request handler that was logging the event) and leaving the subscription's cursor wrongly advanced or wrongly behind, depending on which event failed.

**Why tests miss it.** `tests/events.test.ts` (all six tests) uses listeners that only `push`/`resolve`; none throws, so the line ordering `cursor = event.seq; listener(event)` is never exercised under failure, and no test subscribes against a listener that rejects one specific kind.

**Minimal fix.** Move the cursor advance before the call and isolate the callback:
```ts
for (const event of this.after(cursor)) {
  if (event.seq <= cursor) continue;
  cursor = event.seq;
  try { listener(event); } catch (error) { console.error("event listener failed", error); }
}
```
(and, in `append`, guard the synchronous fan-out the same way so a subscriber cannot fail the append).

**Severity:** major.

---

## Finding 2 — Session search wraps a multi-word query in one FTS phrase, so a two-word search that matches a message returns nothing

**File:** `src/core/tree.ts:181-203`

```ts
  try {
    if (trimmed.length >= 3) {
      return db
        .query<InferSessionRow, SQLQueryBindings[]>(
          `SELECT ${columns} FROM sessions s
           WHERE s.deleted_at IS NULL AND (s.title LIKE ? OR s.id IN
             (SELECT session_id FROM entries_fts WHERE entries_fts MATCH ?))
           LIMIT ?`,
        )
        .all(`%${trimmed}%`, `"${trimmed.replace(/"/g, '""')}"`, limit)
        .map(toSession);
    }
  } catch {
    // fall through to LIKE for short or unparsable queries
  }
  const like = `%${trimmed}%`;
  return db
    .query<z.infer<typeof SessionRow>, SQLQueryBindings[]>(
      `SELECT DISTINCT ${columns} FROM sessions s
       LEFT JOIN entries e ON e.session_id = s.id
       WHERE s.deleted_at IS NULL AND (s.title LIKE ? OR e.payload_json LIKE ?)
       LIMIT ?`,
    )
    .all(like, like, limit)
    .map(toSession);
```

**Mechanism.** The index is built with `tokenize = 'trigram'` (`src/store/migrations.ts:80-85`). With a trigram tokenizer, a quoted phrase matches only a **contiguous** substring of at least 3 characters, and this code wraps the *whole* query in one quoted phrase. Probe against an entry whose text is `내일 회의 준비물`:

```
searchSessions("서울 강남") -> 0    // two words each present in a message: quoted as one phrase, no match
searchSessions("회의")      -> 1    // 2 chars: served by the LIKE fallback only
```

So a user who searches for two words that both occur in a message gets **zero** results: `"서울 강남"` is matched as one contiguous trigram phrase, and the words are not adjacent. The two-word query is exactly the case a conversation search is for.

On the fallback path: `e.payload_json LIKE ?` matches the raw serialised payload `{"events":[{"type":"text","id":0,"text":"..."}]}`. Probe shows `searchSessions("id")` → 1 session and `searchSessions('"')` → 1 session that do not contain the query in any message text (the full key names `text`/`events`/`type` do not match because the serialised form carries a trailing colon). That is a smaller, 1–2-character-sized cousin of the same problem and is worth fixing in the same change, but the multi-word miss is the concrete one.

**Why tests miss it.** `tests/tree.test.ts:227-251` uses exactly `"회의"`, `"준비물"`, `"없는단어"`, `"뉴스레터"` — all single contiguous 3+ character words, which the quoted-phrase trigram query handles. No test uses a query with a space, which is the case that returns 0.

**Minimal fix.** Split on whitespace and join quoted phrases with `AND` (or `OR`), e.g.
```ts
const match = trimmed.split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
```
and keep `"${trimmed...}"` only for the single-token case.

**Severity:** major (a two-word session search silently returns no results).

---

## Finding 3 — `remember()` returns the untruncated text while the database holds at most 4000 characters

**File:** `src/knowledge/memory.ts:58-72`

```ts
  db.query(
    "INSERT INTO memories (id, kind, text, source_json, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run(id, input.kind, input.text.slice(0, 4_000), JSON.stringify(input.source ?? {}), iso, iso);
  return {
    id,
    kind: input.kind,
    text: input.text,
    ...
```

**Scenario.** Both shipped callers cap at 4000: `POST /api/memories` (`src/server/knowledge-routes.ts:8`) and the `memory_note` tool (`src/tools/memory.ts:23-29`, `z.string().trim().min(1).max(4000)`). The unguarded caller is `correctMemory` itself: the `memory_correct` tool (`src/tools/memory.ts:62-68`) validates 4000 too, but `correctMemory` passes `input.text` straight into `remember`, so **any** direct caller of `correctMemory` (or a future tool that omits the zod bound) hits the mismatch. When it does, `remember` also slices the stored copy mid-surrogate (`String.prototype.slice` counts UTF-16 code units), so the stored value can end in a lone surrogate that re-serialises as `\udXXX`.

**Why tests miss it.** `tests/assets.test.ts:22-31` and `tests/knowledge-http.test.ts` only use short Korean strings; no test asserts `remember(...).text === listMemories(...)[0].text` for an over-4000 input.

**Minimal fix.** `const stored = input.text.slice(0, 4_000);` … `.run(id, input.kind, stored, …)` and `text: stored` in the returned object.

**Severity:** minor (latent: the contract `remember(...).text` equals what was stored is broken, and every current caller masks it by validating the bound itself).

---

## Finding 4 — `correctMemory` parses the stored `source_json` with a bare `JSON.parse`, unlike the read path that guards it

**File:** `src/knowledge/memory.ts:85-108`

```ts
    const created = remember(db, {
      kind: z.enum(MEMORY_KINDS).parse(existing.kind),
      text: input.text,
      source: JSON.parse(existing.source_json),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
```

**Scenario.** `toMemory` (memory.ts:31-37) wraps `JSON.parse(row.source_json)` in try/catch because the column can contain anything; `correctMemory` re-parses the same column outside a catch. `source_json` has no `CHECK(json_valid(source_json))` in `RESET_SCHEMA` (`migrations.ts:160-168`), so a row written by a hand-run migration or a manually inserted memory with a malformed `source_json` (or a `null` default from a future schema change) makes `correctMemory` throw. The HTTP route `src/server/knowledge-routes.ts:38` calls it after only validating the request body; a `SyntaxError` escapes the route handler as an error response / unhandled rejection instead of the intended `memory_not_found` / corrected result, and `src/tools/memory.ts:62` throws into the model tool loop.

**Why tests miss it.** `tests/assets.test.ts:33-43` and `tests/knowledge-http.test.ts:97` only correct rows created by `remember`, whose `source_json` is always valid.

**Minimal fix.** Reuse the defensive parse: `let source: unknown = {}; try { source = JSON.parse(existing.source_json) } catch { /* keep {} */ }`.

**Severity:** minor.

---

## Finding 5 — `settleExpiredRuns` overwrites the recorded canceller with `host_restart`

**File:** `src/core/run-state.ts:48-66`

```ts
  const update = db.query(
    "UPDATE runs SET status = 'interrupted', cancel_intent = 'host_restart', settled_at = ? WHERE id = ? AND status = 'running'",
  );
  for (const row of rows) {
    ...
    if (!isLeaseExpired(row.lease_expires_at, now)) continue;
    update.run(new Date(now).toISOString(), row.id);
```

**Scenario.** An owner cancels a run in process A while its executor lives in process B: `src/surfaces/work/cancel.ts:33-37` writes `cancel_intent = 'user'` but only when the row is already `cancelled`. If B is terminated before it observes the cancel (the `#9711` case this function exists for), the row is still `status = 'running'` with `cancel_intent = 'user'` and an expired lease. On the next start `settleExpiredRuns` fires and rewrites it, probe:

```
{ status: "interrupted", cancel_intent: "host_restart" }
```

This contradicts the file's own comment at `run-state.ts:14` — "Cancellation always records who asked, so recovery never guesses" — and `dbCancelled` (`src/surfaces/work/settle.ts:12-19`) then can no longer tell that a user stopped it.

**Why tests miss it.** `tests/run-state.test.ts:69-88` inserts "dead"/"alive"/"done" with no prior `cancel_intent`; it never seeds `cancel_intent = 'user'` on a still-`running` row.

**Minimal fix.** `cancel_intent = CASE WHEN cancel_intent = 'user' THEN 'user' ELSE 'host_restart' END`.

**Severity:** minor.

---

## Finding 6 — A `leaf_id` pointing at a missing entry makes `pathEntries` return `[]` for a session that has entries

**File:** `src/core/tree.ts:31-50`

```ts
  let current = leafId === undefined ? getLeaf(db, sessionId) : leafId;
  if (!current) {
    const last = all.at(-1);
    return last ? [last] : [];
  }
  ...
  while (current) {
    ...
    const entry = byId.get(current);
    if (!entry) break;
    chain.push(entry);
```

**Scenario.** `setLeaf` (`tree.ts:23-25`) sets `sessions.leaf_id` in its own statement, separate from any entry-creating transaction (e.g. `editUserMessage` `tree.ts:100-107` commits the new entry, then sets the leaf; `executeTurn` `loop.ts:182-204` sets leaf per step). If a leaf row is removed (or a session row is restored whose leaf was pruned), `current` is non-null, so the `all.at(-1)` fallback is skipped; `byId.get(current)` misses and the loop breaks, returning `[]`. Probe (entry count = 1, leaf points at `gone`):

```
dangling leaf, entries=1, pathEntries: 0
```

The conversation view is empty although the history is intact, and the next `runTurn` uses `getLeaf` (`loop.ts:183`) as the parent for the new user entry, so a dangling id propagates into `entries.parent_id` (FK-checked but pointing at a nonexistent row) and the tree detaches permanently.

**Why tests miss it.** `tests/tree.test.ts` always sets the leaf to an entry it just created; no test deletes an entry or sets `leaf_id` to a foreign id.

**Minimal fix.** When `byId.get(current)` misses, fall back to `all.at(-1)` exactly like the no-leaf branch, and/or have `setLeaf` verify the row belongs to the session.

**Severity:** minor.

---

## Finding 7 — `forkSession` inserts the new session and copies entries in separate transactions, leaving a half-copied session on failure

**File:** `src/core/tree.ts:129-166`

```ts
  db.query("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(...);
  let parent: string | null = null;
  let last: string | null = null;
  for (const entry of chain) {
    const created = appendEntry(db, { sessionId: id, parentId: parent, ... });
    parent = created.id;
    last = created.id;
  }
  setLeaf(db, id, last);
```

**Scenario.** Each `appendEntry` is its own `db.transaction(...)` (`sessions.ts:176`). If the k-th throws (SQLITE_BUSY past `busy_timeout`, constraint, or process termination), the `sessions` row from the first statement stays committed with `leaf_id = NULL` and k−1 copied entries. Probe of what such a row then looks like to callers:

```
listed: [ "f" ] path: 0
```

`listSessions` (`sessions.ts:97`) shows the empty "분기" session in the sidebar, and the caller in `src/server/app.ts:540` already returned an error for it, so the user has a phantom session they never asked to keep.

**Why tests miss it.** "fork copies only the ancestor chain into a new session" (`tests/tree.test.ts`) only runs the happy path.

**Minimal fix.** Wrap the whole body in `db.transaction(() => { ... return { sessionId: id, entries: chain.length }; })()`; `appendEntry`'s inner transaction then nests as a savepoint.

**Severity:** minor.

---

## Finding 8 — `storeFile` writes the blob before the row, so a failed insert leaves an orphan file

**File:** `src/files/store.ts:28-58`

```ts
  const path = resolve(dir, `${id}-${safeName}`);
  writeFileSync(path, input.bytes);
  const createdAt = new Date(input.now ?? Date.now()).toISOString();
  db.query(
    "INSERT INTO files (id, name, mime, bytes, sha256, path, origin, created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(...);
```

**Scenario.** If the insert throws (disk full, busy timeout, shutdown) or the process dies between the two statements, `<root>/<sha[0:2]>/<uuid>-<name>` remains with no `files` row. Nothing sweeps it: `DELETE /api/files/:id` (`src/server/knowledge-routes.ts:85-90`) unlinks only files that have a row, and `listFiles` never looks at disk. Repeated failed or retried uploads grow the directory without bound. `writeFileSync` also blocks the event loop for the whole body.

**Why tests miss it.** `tests/assets.test.ts:51-66` only stores a valid file and reads it back.

**Minimal fix.** Write to `${path}.tmp`, insert the row, then `renameSync(tmp, path)`; on an insert failure `unlinkSync(tmp)`.

**Severity:** minor.

---

## Suspicions

### S1 — `takeNext` selects and deletes without a transaction, so two drains on one session can pick the same message and one loses a queued turn

**File:** `src/core/queue.ts:66-76`
```ts
/** Takes the next queued message, so two drains on one session cannot run the same text. */
export function takeNext(db: Database, sessionId: string): QueuedMessage | null {
  const row = db
    .query("SELECT ... LIMIT 1").get(sessionId);
  if (!row) return null;
  const next = toMessage(QueueRow.parse(row));
  return dequeue(db, sessionId, next.id) ? next : null;
}
```
The comment promises an atomic take; the code is `SELECT` then a separate `DELETE`. Probe on a temp-file DB with two connections executing the same two steps:
```
S1: A deleted 1 B deleted 0 -> both read the same row; one loses
```
For this to matter the two `Surface` instances (or a server plus a worker in another process — the code supports one, `surface.ts:163-168` comments) must drain the same session; within a single process `drainQueue` is synchronous so it cannot interleave at `takeNext`. **What would confirm it:** any deployment running two processes that both call `resumePending`/`resume` (e.g. the worker plus the server), then two drains on one session: the loser returns `null`, its `drainQueue` reports `drained: false`, and if it was the only one draining that session the message sits until the next poll. Fix: `db.transaction(...).immediate()` around both statements, or `DELETE ... RETURNING id, text, created_at`.

### S2 — `migrate` writes `RESET_SCHEMA` and applies steps after an unlocked version read, so two processes booting a fresh DB can collide
**File:** `src/store/db.ts:78-90` (read + `db.exec(RESET_SCHEMA)`), `runSteps` at `69-84`
`openDatabase` → `userVersion` → `migrate` → `userVersion` are separate statements; `db.exec(RESET_SCHEMA)` is not inside a transaction. Two `openDatabase` calls on the same `version = 0` file (the worker and the server starting together) can both observe `0`, and the second `RESET_SCHEMA` fails with "table sessions already exists" (or sees a half-built schema — `exec` of a multi-statement script is not atomic as a unit). The tests (`tests/store.test.ts` "openDatabase works on a file and is idempotent across connections") open sequentially. **What would confirm it:** spawn two `openDatabase(freshPath)` concurrently and assert both succeed; expected failure is a `SQLITE_ERROR` in one of them through the `transaction` path. This is a test gap rather than an observed failure, hence a suspicion.

### S3 — FTS index keeps the streamed partial text when an assistant turn is aborted without a `sessionId`
**File:** `src/core/sessions.ts:220-244`
`saveEntryEvents` writes the running payload but never touches `entries_fts`; `updateEntryEvents` indexes only `if (sessionId)`. `loop.ts:541-546` on the aborted path calls `updateEntryEvents(..., "aborted", input.sessionId)` so the final call does pass the id, and the line is re-indexed with the final text (`DELETE … WHERE entry_id = ?` then INSERT) — so the live path is fine. The gap is any caller of `updateEntryEvents` without `sessionId`, whose new text is never indexed and whose old text stays searchable — what I observed earlier: after `updateEntryEvents(db, a.id, [{type:"text", id:0, text:"x"}], "complete")` (no session) the session still matched `"zzunique"` (1 hit) although the stored text was now `"x"`. There are only two call sites today (`loop.ts:498` and `541`), both passing `input.sessionId`, so this is a latent contract hazard, not a live bug. **What would confirm it:** a caller that passes no `sessionId` and later searches for the replaced text.

---

## Files read

- src/store/db.ts — read
- src/store/migrations.ts — read
- src/core/compaction.ts — read
- src/core/context.ts — read
- src/core/contracts.ts — read
- src/core/executor.ts — read
- src/core/policy.ts — read
- src/core/queue.ts — read
- src/core/run-state.ts — read
- src/core/sessions.ts — read
- src/core/tree.ts — read
- src/core/vault.ts — read
- src/events/log.ts — read
- src/files/store.ts — read
- src/knowledge/memory.ts — read

Cross-referenced for judgment (not in scope): `src/surfaces/conversation/loop.ts`, `surface.ts`, `queue-executor.ts`, `src/surfaces/work/settle.ts`, `cancel.ts`, `record.ts`, `src/server/app.ts`, `src/server/knowledge-routes.ts`, `src/tools/memory.ts`, and `tests/{store,tree,queue,run-state,events,context,assets,policy}.test.ts`.
