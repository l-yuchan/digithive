# 2026-11-26 — tab addresses, provider fallback, and `@builtin/` jobs

Three requests, each stated with its reason by the owner:

1. every tab switch and every conversation switch added one more slash to the address;
2. a quota-exhausted primary reported "no model route is available" although DeepInfra was
   healthy, and the 15-minute suspension ignored the reset the provider reported;
3. the app's own script workflows should be named by a special path (`@builtin/collection.ts`)
   instead of being offered as a separate "앱이 제공하는 작업 (선택)" picker.

## 1. The address that grew a slash

**Cause.** `appRoot()` in `web/src/App.tsx` derived the mount prefix from `document.baseURI`.
That is the *current document's* URL, not the mount point: on `/chat/<id>` it yielded
`/chat/<id>/`, and `addressFor()` then built `/chat/<id>/chat/<next>` on top of it. Each hop
compounded, which is exactly the reported `//chat//chat//chat/<id>` and, after a tab switch,
`//chat//chat//chat///workflows`.

**Fix.**
- `appRoot()` is the origin root; this app is served at `/` (the server answers `/`, `/chat`,
  `/chat/<id>` and the other tab paths from one shell). The shipped bundle no longer contains
  `baseURI` at all.
- `routeOf()` (`web/src/routes.ts`) reads the addresses already in the wild: empty segments are
  dropped, a tab repeating its own name is one tab, and a tab word after an id names the tab the
  address opened rather than a second conversation.
- On load, an address written by the old links is rewritten in place with `replaceState`, so a
  bookmark to `//chat//chat/<id>` opens the conversation without a second history entry.

**Evidence.** `tests/router-contract.test.ts` covers both reported addresses plus the id, the
repeated-name and the tab-after-id shapes; the full suite and typecheck pass.

**Not verified.** The live site was not driven in a browser: this environment has no browser
engine (`OMO_BROWSER_ENGINE` unset) and no DOM shim installed, so the check is the shipped
bundle (`baseURI` gone) plus the router tests rather than a click-through.

## 2. Provider fallback on quota

**Cause.** `web/src/providers/router.ts` forwarded the caller's `fetchImpl` only through
`StreamOptions`. In production nothing supplies one, so the adapter fell back to its own
`options.fetchImpl ?? fetch` reference. Two consequences: a test or tool that replaced the
route's transport did not reach the adapter, and the single global `fetch` served every route,
so a fallback could never be shown to read its own endpoint. Separately, any quota failure
suspended a route for the fixed 15 minutes regardless of what the provider said.

**Fix.**
- Each route's transport is passed to the adapter per call (`fetchImpl: transport(route)`).
- A quota failure now suspends the route until the reset it reports: `resets in 1d 11h` in the
  message text, or — when the text names none — the provider's own usage windows. `usage.ts`
  reads `GET <base>/usage` (`rolling` / `weekly` / `monthly`, each with `status`, `percent`,
  `resetsAt`) and returns the earliest spent window's `resetsAt`. The fixed cooldown remains
  only as the fallback when nothing reports a reset.
- `provider.fallback` / `provider.exhausted` diagnostics carry `until` (ISO) beside `retryInMs`,
  and the conversation turn renders the suspension as `~<until>` with the route's own reason.
- Routes calling `opencode.ai` carry `x-opencode-session`; the gateway refuses a request
  without it (HTTP 400 `MissingSessionID`). It is a property of the route, so the router adds
  it rather than each caller.

**Live check (real key, 2026-11-26).** The account is genuinely in monthly quota:

```
quota_exhausted (HTTP 429): GoUsageLimitError OpenCode Go usage limit reached
  (monthly, resets in 1d 10h) …
```

The router turned that into `provider.fallback` with `retryInMs: 122400000` and
`until: 2026-11-27T12:26Z` — 34 hours, the provider's reset, not 15 minutes — then called the
fallback route. Without the session header the same request was refused as `MissingSessionID`
(HTTP 400), which is how the missing header was found; with it the gateway answers the real 429.

**Not verified.** A successful answer *through* DeepInfra from this machine: no DeepInfra key
exists in the local `.env` (the live server holds it), so the fallback call was made and
refused on authentication only.

## 3. `@builtin/<file>` for the app's own jobs

**Design (the owner's).** Rather than present the shipped jobs as a separate selectable kind,
their path is what is special: `@builtin/collection.ts`, `@builtin/briefing.ts`. A job is then
an ordinary script workflow whose file comes from the app, and there is nothing to keep in
sync between a picker and a path.

**Fix.**
- `surfaces/work/script.ts` resolves `@builtin/<file>` against the app's own `jobs/` directory
  (`JOB_SOURCE_ROOT`), refusing nesting and traversal; every other path still resolves inside
  the scripts root.
- `COLLECTION_SCRIPT` / `BRIEFING_SCRIPT` and the seeds are `@builtin/…`.
- Migration **v14** rewrites every stored executor (`workflows`, `runs`) from `jobs/*.ts` to
  `@builtin/*.ts`. With v14 added, v12 is retired so the chain stays at two steps (v13, v14),
  as the owner's rule requires; the v12 payload rewrite is already what the reset produces.
- The form's picker is gone. The path field explains the prefix in place, and the collection
  job's account-argument hint keys off the path. Client validation accepts `@builtin/<file>`
  and rejects anything else after the prefix.

**Evidence.** `tests/jobs.test.ts` proves a `@builtin/` path reads the shipped file even when a
same-named file sits in the scripts root, and that traversal/nesting are refused;
`tests/store.test.ts` proves v14 renames stored executors; a real v13 database was upgraded to
v14 with its executor rewritten.

## Checks run

`bun run verify` (lint, typecheck, web build, tests, format): **290 tests pass, 0 fail**.
