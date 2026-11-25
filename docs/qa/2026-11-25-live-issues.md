# Live version issues reported 2026-11-25 — plan, causes, verification

The owner reported four problems in the deployed harness. Each was traced to a
cause before editing; the fixes are below with the check that shows it holds.

## 1. `연결 자료 수집` fails with `account_required`

**Cause.** Migration v8 retired the account-less seed (`system-sync`) but nothing
replaced it. The owner switched it back on in the schedule screen, and the builtin
now refuses a collection run that names no account, so every occurrence failed.

**Fix.** Collection is one schedule per account. Migration v9 deletes
`system-sync` and seeds `연결 자료 수집 · <label>` for every existing account
(`executor.accountId` = that account, sources = whatever its switches allow). A
newly connected account gets its schedule in the OAuth callback
(`ensureCollectionSchedule`), and deleting an account removes the schedules that
named it (`removeAccountSchedules`). An existing schedule is never re-enabled or
rewritten.

## 2. `google-default` is not an ordinary account id and shows no ID

**Cause.** v6 seeded the first Google row with the placeholder id `google-default`;
the account card only printed the Google subject, which that row never had.

**Fix.** Migration v9 renames the row to
`6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6` and moves every reference with it in the
same transaction (credential, source cursors, collected items, a pending consent,
and schedule `executor.accountId`). The connections card now prints `계정 ID <id>`
for every account, with `Google 사용자 ID <subject>` when the subject is known.

## 3. `states` error and a frozen 수집 상태 / `VAPID: 확인 중`

**Cause.** Not a server defect: the open tab was still running the bundle from the
previous deployment (it expects `states` in `/api/connections`, which the current
server no longer sends). The tab never re-fetched its JavaScript.

**Fix.** `build:web` stamps a build id into the bundle and writes
`web/dist/build.json`; the server exposes it at `/api/version`, and a loaded tab
compares it on focus, on visibility and every 30 seconds, reloading when the
served build differs. `index.html` is served `no-store`.

## 4. Tool-call output stops streaming and arrives at the end

**Cause.** `Bun.serve` defaults to a 10-second idle timeout while the SSE keepalive
ping was 15 seconds. Any silence longer than 10 seconds (model thinking, a tool
running) killed the event stream; the browser reconnected, the fresh snapshot
replaced the bubble with the persisted (still empty) parts, and the answer landed
in one burst when the turn settled. Measured directly: an idle `/api/events`
connection was reset at 9980 ms.

**Fix.** The server sets `idleTimeout: 0` and pings every 10 seconds. The event
stream now opens with a snapshot and carries only new events (history is never
replayed over text already on screen), and the conversation loop stores partial
assistant text as it streams (first delta, then every eight, and at each tool
boundary) so a reconnect or reload sees what the reader already saw. The client
also keeps whichever copy of a still-streaming entry has more text.

## Verification

- `bun run verify`: lint, typecheck, web build, 217 tests (new: v9 rename/reference
  migration, per-account schedule seeding, ensure/remove, partial-text persistence,
  snapshot-only event stream, build id).
- Live database snapshot (`VACUUM INTO`) migrated locally: user_version 8→9,
  `PRAGMA foreign_key_check` empty, `integrity_check` ok, 3 accounts renamed/seeded,
  credentials + 93 collected items still attached to the right accounts, 3
  per-account collection schedules, `system-sync` gone.
- Browser (headless Chrome, local server + streaming mock with a 12 s gap): text
  streamed before the gap, stayed visible through it, and the next round streamed
  incrementally instead of appearing at settlement. An idle event stream stayed
  open past 30 s with 10 s pings.
- 연결 tab locally: no load error, `계정 ID <uuid>` line present, VAPID resolved.
- Stale-tab reload: with a new `build.json` served, focusing the old tab reloaded
  it within one check.

## Live result after deploy (`5a3aee9`, guard `5e6314f`)

The first automatic dispatch after the migration ran at 19:51 KST and created one
run per account; all three settled `succeeded`:

- `chanoil@hanyang.ac.kr`: Gmail collected (calendar skipped with `source_disabled`, as switched off)
- `chabun314@gmail.com`: Calendar and Gmail collected
- `한양 LMS`: Canvas collected

No run reports `account_required`. The previous `연결 자료 수집` (`system-sync`)
was removed by v9; its past runs stay in the database with no schedule link.

