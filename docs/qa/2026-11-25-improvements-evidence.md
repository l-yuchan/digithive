# Runtime, accounts and execution visibility — verified 2026-11-25

Evidence was captured against an isolated database and local stand-ins
(`apps/harness/scripts/qa-routing.ts`), so no real Google account or paid model was
called. Raw captures (screenshots, provider logs, conversation payloads and the UI
handoff note) live in `.omo/evidence/2026-11-25-improvements/`, which is git-ignored.

## Provider routing (request 1)

`bun scripts/qa-routing.ts providers` served a quota primary on `:8796` (HTTP 429,
`GoUsageLimitError ... usage limit reached`) and a healthy backup on `:8797`. The
harness ran with `MODEL_FALLBACKS_JSON` pointing at the backup, `MODEL_RETRIES=0`.

- First turn: `qa-1-provider-routes.log` shows `primary 429` then `backup 200`, and
  `qa-1-conversation-parts.json` holds the owner-readable note
  (`모델 경로 primary 실패(quota_exhausted): ... → backup/qa-backup로 전환. 15분 동안 ...`)
  followed by the real answer `[backup] 연결된 경로에서 답했습니다.`
- Second turn: the provider log shows only `backup 200`, so the context stayed on
  the route it settled on.
- Unit coverage (`tests/provider-routing.test.ts`, `tests/provider.test.ts`): quota
  fallback with the upstream reason kept, context affinity, transient retry on the
  same route, cooldown until the route recovers, all-routes-exhausted as a detailed
  error, no replay after streamed output, cancellation, HTTP 200 error envelopes and
  empty streams as failures.

## Verbose feedback (request 2)

`qa-3-work-log-detail.png` shows a failed run with the upstream body, the ordered
events (`공급자 전환`, `공급자 모두 소진`, `실행 실패`) and their colours. The
conversation now persists error parts (regression test in `tests/conversation.test.ts`,
reproduced red before the fix). Schedules show their refusal reason inline
(`qa-5-schedule-permission-refusal.png`).

## Accounts as permissions, collection as a schedule (requests 3 and 6)

- `qa-5-connections-final.png`: each account's switches read `정보 사용`, name the
  schedules that read them, and show the last collection attempt. There is no
  collection-status section and no manual sync button.
- `qa-5-schedule-permission-refusal.png` and `tests/accounts.test.ts`: a collection
  schedule that reads a disabled feature is refused with the reason instead of
  collecting nothing.
- `qa-4-collection-schedule.png` / `tests/schedule-execution.test.ts`: a collection
  schedule names its account and sources and reads only those.
- `tests/account-migration.test.ts`: a populated v5 database upgrades with its token,
  cursor, items and a newly added account intact, and the seeded row is an ordinary
  account.

## Collection flow proven end to end (requests 1, 3)

`bun scripts/qa-routing.ts google` served Calendar, Gmail and OAuth stand-ins on
loopback. With the seeded account's token expired, one collection run for that
account refreshed the token (`service: oauth`) and then called only the sources the
schedule named:

- the calendar run fetched `GET /calendar/v3/calendars/primary/events` and stored one item with its cursor
- a gmail-only run fetched `/gmail/v1/users/me/profile`, `/messages` and `/messages/qa-mail-1`, all `-> 200`, and stored one message

The final run settled `outcome succeeded`, and `qa-5-connections-final.png` shows
both sources `정상` with `이 정보를 읽는 스케줄: 아침 메일·일정 수집` and the last
collection time.

## Schedule workflow (request 4)

`qa-4-collection-schedule.png` (builtin: account and sources), the script case
(`jobs/report.ts` with `"인자 1: \"--range\""`, `"인자 2: \"last-7-days\""`) and the
agent case (`2. 프롬프트: "..."`) show exactly what a schedule runs. Desktop and
390 px captures: `qa-4-schedules-final.png`, `qa-4-schedules-final-mobile.png`.

## Execution log (request 5)

`qa-3-work-log-desktop.png`, `qa-3-work-log-detail.png` and
`qa-3-work-log-mobile.png`: no task composer (the tab says to ask in the
conversation), search and status/origin filters narrow the list, and a run expands
to its full result and event trail. Work still starts from the conversation.
