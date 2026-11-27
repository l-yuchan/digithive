# Whiteboard, daily agent search, and agentic briefing plan

Date: 2026-11-27
Status: implementation authorized by the current three-feature request; no deploy/push
App: `apps/harness`
Baseline: `2bfc8e1`; 309 tests across 46 files, `verify` and `fmt:check` green

## 1. Deliverables and non-goals

1. A whiteboard whose durable documents are Markdown files on local disk, indexed in SQLite, containing knowledge, source materials, memories/files, tasks/delegations, and watches. It has real HTTP/agent-tool surfaces and a navigable web view.
2. TinyFish, Firecrawl, and best-effort DuckDuckGo HTML search, with provider-specific errors visible beside results. A predefined 06:30 Asia/Seoul agent workflow selects a query from whiteboard context, searches, archives raw sources, and writes a natural-language research digest.
3. A predefined briefing agent, in both existing 07:30 and 21:00 KST schedules, that reads the whiteboard and publishes a natural-language, source-referenced briefing through existing `briefings` storage and `push_send`. The old deterministic producer is no longer a product path.
4. Isolated real-HTTP/browser/provider/agent QA and full existing checks. No spatial drawing board, general agent framework, deployment, push, or changes to the owner's uncommitted provider/settings work.

## 2. Decision: canonical whiteboard filesystem

| Option | Strength | Decisive failure for this request | Verdict |
|---|---|---|---|
| A. Canonical Markdown/JSON files + SQLite index | Directly inspectable/portable filesystem; the research's Evidence/Memory/Interpretation layers are real documents; agents and the user share the same files | Requires rebuild/index discipline | **Choose** |
| B. SQLite canonical + materialized files | Simple current-DB integration | Files are disposable output, so the user's "filesystem where knowledge/tasks live" is only a view | Reject |
| C. Links-only board | Little duplication | Knowledge/tasks do not actually live in the whiteboard and offline provenance is incomplete | Reject |

The whiteboard store owns its Markdown documents. Operational stores remain authoritative for their own execution/integration state and are projected to deterministic whiteboard documents. SQLite `whiteboard_documents` and `whiteboard_fts` are a rebuildable discovery index, not a second content authority. Every index read first reconciles from disk and refreshes operational projections, making manual filesystem edits visible and collection/run updates durable.

### Document model

All documents are UTF-8 `<path>.md` with a JSON frontmatter block (valid YAML), then a Markdown H1 and body. Zod parses files at the trust boundary.

```text
---
{"id":"wb_...","kind":"record|thread|commitment|watch","title":"...","source":{"type":"...","id":"..."},"status":"...","createdAt":"...","updatedAt":"..."}
---
# Title

Body
```

- `records/gmail|calendar|canvas/<stable-id>.md`: enabled source Evidence from `sync_items`, with account/source/item provenance and URL.
- `records/conversations/<stable-id>.md`: each stored session entry's readable events, with session/entry/role provenance.
- `records/files/<file-id>.md`: uploaded-file metadata/original-location Evidence.
- `records/web/<date>/<time>-<provider>-<position>.md`: raw web results written by `web_search` archiving.
- `threads/memories/<memory-id>.md`: live and superseded Memory/Thread history, retaining correction provenance.
- `threads/notes/<user-or-agent-id>.md`: user notes and explicit current knowledge.
- `threads/research/<date>-<time>.md`: agent Interpretation, with result paths/URLs and provider errors.
- `threads/briefings/<briefing-id>.md`: natural-language briefing Interpretation and valid source ids.
- `commitments/notes/<id>.md`: personal tasks with `open|in_progress|done|cancelled` state.
- `commitments/workflows/<workflow-id>.md`: reusable delegated-work definitions.
- `commitments/runs/<run-id>.md`: execution/delegation snapshots with current run state/results.
- `watches/schedules/<schedule-id>.md`: durable schedule/watch definitions.

A path is normalized `/`-separated ASCII `[A-Za-z0-9._-]` segments, relative, confined to the kind's top-level directory, and at most 200 KiB. Absolute paths, empty segments, `..`, `\`, NUL, and escapes are refused. Writes use a same-directory unique temporary file and atomic rename. IDs/paths for operational projections derive from stable origin keys, not titles, so renaming cannot duplicate them.

### Read/index consistency

`WhiteboardStore.refresh()` performs these synchronous, idempotent operations:

1. Enumerate Markdown files beneath the root, parse and index user/agent-authored documents, and drop index entries for removed documents.
2. Project current enabled `sync_items`, `memories`, `files`, `workflows`, `schedules`, `runs`, and `briefings` into deterministic files, writing only changed hashes.
3. Reindex changed documents in FTS5 (`unicode61`), title + body + source text, with ordinary escaped terms for Korean and Latin words.

Call refresh at runtime startup, before whiteboard API/tool reads, after whiteboard writes, and after briefing publish. This avoids fragile cross-process filesystem hooks while ensuring every consumer sees current operational state. The real collection's `saveItems` seam is covered in tests and QA; subsequent whiteboard reads materialize its rows without duplicating the adapters.

## 3. HTTP and agent contracts

### HTTP

- `GET /api/whiteboard?query=&kind=&limit=`: refresh and list metadata (bounded; empty query lists newest).
- `POST /api/whiteboard`: `{path,kind:"thread"|"commitment",title,text,status?}` creates/updates an owned note/task; path traversal returns 4xx.
- `GET /api/whiteboard/:id`: full document metadata/body; percent-decode exactly once and reject malformed escapes.
- `PATCH /api/whiteboard/:id`: `{text?,status?,expectedHash}` updates a user/agent document without changing its stable id/path; a stale hash returns 409 instead of overwriting a newer filesystem revision.

### Tools

- `whiteboard_list({query?,kind?,limit?})`: search/list summaries and record retrieved ids for later citation validation.
- `whiteboard_read({id})`: full document, recording that id for the calling run.
- `whiteboard_write({path,kind,title,text,status?})`: agent-authored Record/Thread/Commitment/Watch documents inside allowed paths.
- `whiteboard_update({id,text?,status?,expectedHash})`: status/body update guarded by the last-read content hash.
- `web_search({query,provider:"auto"|"all"|"tinyfish"|"firecrawl"|"duckduckgo",limit?})`: provider-normalized hits + `failures[]`; successful hits are archived to whiteboard Record files and their ids/paths return with the hits.
- `briefing_publish({text,sourceIds,slot?})`: requires nonempty text and at least one source actually returned to the same run through whiteboard tools. Stores the run-linked natural-language briefing with those references, refreshes its filesystem projection, and returns the existing push title/body payload.
- Existing `push_send({title,body})`: unchanged delivery semantics; unconfigured/no-device outcome remains visible rather than fabricated success.

## 4. Search implementation

`src/search/` is a small provider layer, not a new dependency/framework.

- Common `SearchHit` (`provider,title,url,snippet,position`) and `ProviderFailure` (`provider,kind,message`) parsed from untrusted output with Zod.
- TinyFish: API key -> official `GET https://api.search.tinyfish.ai?query=...`; `X-API-Key`; otherwise optional CLI fallback `tinyfish search query <query>`, parsed with the documented response schema. CLI absence/nonzero exit is visible `provider_unavailable`.
- Firecrawl: API key -> official `POST /api.firecrawl.dev/v2/search` with bearer auth, `{query,limit}`; otherwise optional CLI fallback `firecrawl search <query> --limit <n> --json`, parsing `data.web`. Discovery does not hydrate/scrape pages, controlling cost.
- DuckDuckGo: best-effort `GET https://html.duckduckgo.com/html/?q=...`, result title/link/snippet parsing, `uddg` target decoding and HTML entities. Non-2xx, block pages, and zero parseable results are failures, not a legitimate empty success.
- `auto`: try configured providers in order until hits exist, retaining all preceding failures. `all`: query all requested providers concurrently and keep per-provider provenance/failures. If no provider returns hits, the result is `ok:false` with errors. A success never erases failures.
- Transport, CLI runner, clock and search archive are injected at existing boundaries for deterministic tests. Secrets never enter responses/artifacts. `SEARCH_ENABLE_CLI=false` disables CLI fallback on deployments that should require API configuration.

## 5. Predefined agent workflows and briefing migration

### Daily research

`system:daily-search`, executor `{kind:"agent"}`, daily binding at 06:30 Asia/Seoul.

The agent must inspect active Threads/Commitments/Watches, choose a bounded current research query, call `web_search`, inspect returned record paths and failures, and write `threads/research/<date>-<time>.md` containing a Korean natural-language digest, source links/record ids, and explicit provider failures. External text is data, never instructions. Missing provider output cannot be described as successful research.

The model/tool protocol is tested with a deterministic wire fixture; the real QA separately proves actual provider connectivity and one actual DuckDuckGo-backed daily run.

### Briefings

- Existing schedules continue targeting `system:briefing`; V16 changes that definition's executor from the old script to `{kind:"agent"}` and installs the whiteboard-grounded instruction.
- The agent searches/reads current whiteboard material, calls `briefing_publish` with its own natural-language summary and retrieved source ids, calls `push_send`, then returns a concise completion summary.
- `briefing_publish` reuses the `briefings` table, run link, latest route and push payload. `BriefingContent` gains `references`; legacy JSON still parses through defaults.
- `/api/briefings/run` becomes a compatibility manual trigger for `system:briefing` rather than invoking the deterministic composer.
- Keep `jobs/briefing.ts` and its install only for already queued historical executions. Do not seed new script definitions. Split registries so new agents receive `briefing_publish` and whiteboard tools, never deterministic `briefing_compose`; the historical SDK bridge retains the old tool for those queued runs.

## 6. Migration

V16 adds `whiteboard_documents` and `whiteboard_fts`, converts `system:briefing`, adds `system:daily-search` and its daily binding, and preserves existing schedules/history. RESET carries the new tables/index shape; `TRANSITIONS` becomes `[V15,V16]` (the current two-step cap). No filesystem access occurs in a DB migration: runtime projection backfills files idempotently. Existing reset/upgrade equivalence tests remain the authority and new assertions cover the agent conversion and daily binding.

## 7. Parallel ownership

Wave A (three independent children after this contract):

1. `deep-low` whiteboard core: only `src/whiteboard/**` and `tests/whiteboard-store.test.ts`. Implement contracts/store/projector and focused tests; no existing production edits.
2. `deep-low` search integration: only `src/search/**`, `src/tools/web-search.ts`, and `tests/search.test.ts`; no runtime edits. Archive through a narrow injected callback.
3. `visual-engineering` whiteboard UI: only `web/src/whiteboard/**`; use existing app tokens/siblings and the specified HTTP contract. Required `frontend` references are read in that lane. No App/routes/global CSS edits, QA servers, or browser resources owned by the lane.

Parent retains all shared and pre-existing dirty files: migrations, runtime/config, server routes/auth, work/briefing integration, App/routes/style import, tests touching existing files, docs, final QA, commits. No two lanes write the same file.

Wave B (parent + independent QA lanes only if disjoint):

- Register stores/tools/routes and web navigation.
- Migration, predefined workflows, agent briefing persistence and removal of the old producer.
- Integration tests and real agent fixtures.
- QA scripts `scripts/qa/{whiteboard,search,briefing}.ts` can be independent new-file lanes after the final routes are frozen; parent owns any shared helper and all browser execution/cleanup.

Stopped/failed children never count as approval or work. Validate every named artifact and take over any lane whose terminal error leaves deliverables incomplete.

## 8. Tests and mutation proofs

New tests answer the four-question gate at the strongest boundary:

- Whiteboard: create/read/update Korean content; exact task status; path traversal; manual disk edit/reindex; source + memory + file + workflow/run/watch projection through real `saveItems`. Credible regressions: path escape, FTS missing two-character Korean, stale projection/lost task status.
- Search: API/CLI normalization, DuckDuckGo redirects/entities, auto and all fallback errors, no-hit failure, archive record delivery. Credible regressions: swallowed provider error, malformed URL, results not archived.
- Workflow/briefing: daily schedule exists and agent calls search/write; old script migrates to agent; publish rejects an unseen citation; natural text + valid sources persist and push outcome is retained; model failure creates no empty briefing.

Targeted mutation evidence: remove path containment, drop provider failures from output, remove citation-run membership validation, and skip the V16 agent conversion. Each named test must go red for its intended reason, then the owner is restored byte-for-byte and rerun green. No prompt-prose tests, mock-echo-only assertions, sleep synchronization, skipped tests, or duplicate layer replays.

## 9. Real-surface acceptance and retained evidence

Artifacts run under `/tmp/tmp.lcr7Sx6ySX/evidence`, then retained under `.omo/evidence/whiteboard-search/` before run-root removal.

1. `bun scripts/qa/whiteboard.ts --evidence-dir /tmp/tmp.lcr7Sx6ySX/evidence/whiteboard`
   - Real app/server/auth POST cookie; representative Gmail/Canvas via `saveItems`; HTTP note/task/search/update/traversal.
   - Owned omowright browser, populated whiteboard at desktop 1440 and mobile 390 (light/dark additions for the visual gate), selected document, no horizontal overflow.
   - Expected `http.json`, `actions.json`, `desktop.png`, `mobile.png`, `fs.json`, `cleanup.json`; all displayed rows map to valid on-disk frontmatter.
2. `bun scripts/qa/search.ts --evidence-dir /tmp/tmp.lcr7Sx6ySX/evidence/search`
   - Real query `OpenAI API documentation` against each authenticated CLI/API path and DuckDuckGo.
   - Real daily agent with deterministic model wire decisions and actual DuckDuckGo search, forced visible failure on another provider; raw result Records, research Thread, schedule and errors verified.
   - Expected `providers.json`, `run.json`, `model-requests.json`, `whiteboard-files.json`, `schedule.json`, `cleanup.json`.
3. `bun scripts/qa/briefing.ts --evidence-dir /tmp/tmp.lcr7Sx6ySX/evidence/briefing`
   - Current whiteboard fact versus disabled/stale legacy source. Agent reads only usable whiteboard material, publishes a cited current-fact summary, sends through existing unconfigured/no-device path, and shows the persisted briefing in the real browser.
   - Expected `model-requests.json`, `run.json`, `latest.json`, `push.json`, `desktop.png`, `cleanup.json`.
4. `bun run verify && bun run fmt:check`
   - Diagnostics clean, no tests skipped/deleted, targeted mutations red/restored green. `verification.txt`, `mutations.json`, `diff-check.txt`.
5. UI visual-QA dual-oracle on the complete fresh whiteboard/briefing capture set, `Layout:`/state brief, draft guard/detect receipts, WCAG table. No independent gate reviewer is triggered by this bare ULTRAWORK plan; architecture/test/self-review is direct. Visual-QA's own two read-only oracle passes are still required.
6. Close owned app/worker/browser processes, profiles, ports, temporary DB/workspaces and runtime caches. Preserve unrelated provider/settings changes. No push/deploy. Atomic local commits only for verified feature increments.

## 10. Advisory-lane integration

The `deep-high` architecture lane completed after 47 reads and independently selected canonical Markdown files with a derived SQLite index, atomic writes, and application-level backfill. This confirms §2; it was advisory input, not a gate approval. The lane's earlier Fable failure remains inconclusive.

Adopted from the lane: files win over the index, stable origin identity, atomic/revision-aware updates, no graph engine, RESET_VERSION unchanged with `[V15,V16]`, and briefing text persisted in both the briefing row and the existing run result.

Rejected as contrary to the user's actual request and binding goal: (1) promotion-only source Records, because every Gmail/Calendar/Canvas item is required to live in the whiteboard automatically, not only after an agent chooses it; (2) a deterministic `briefing_draft` built directly from `sync_items`, because that bypasses whiteboard grounding and preserves the producer being replaced; (3) another memory/task authority, because whiteboard documents and existing run projections already cover those lifecycles without new product state machines. Historical script snapshots of already queued/running executions are not rewritten; the legacy script/tool is retained only on the SDK bridge, while new definitions and agents cannot reach deterministic composition.

## 11. Stop condition

Stop only when all criteria 1-5 pass on the final current build, the full checks are green, every cleanup receipt exists, the visual gate approves or explicitly records environment-limited human follow-up, commits contain only this work, and the notepad/memory/final evidence ledger is current. Any absent criterion remains work, not a redefined success.
