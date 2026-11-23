# Task 12 evidence

Calendar sync reads Google's raw series (`singleEvents=false`, `showDeleted=true`)
so a recurring event is synced once with its exceptions, never as pre-expanded
instances. The sync token is stored beside a query fingerprint; when the stored
token does not match the current query (for example after a calendar change) it
is ignored and a full sync runs. A sync token is never combined with
`timeMin`/`timeMax`/`q`/`orderBy`.

Every page is read into memory before anything is written. Only when the last
page succeeds does one transaction store the new versions and advance the
cursor. A page failure therefore leaves the previous versions, cursor and
materialized occurrences untouched and the connection can be marked stale. A
`410` is treated as an expired token for that connection only: the code retries
once as a full resync and never touches other connections, memories or files.
Unchanged events hash identically and create no new version, so a repeated sync
writes nothing.

The occurrence view is materialized for a -7/+120 day window from the active
versions using `ical.js` (RRULE, RDATE, EXDATE). Expansion runs in floating
wall-clock time taken from the event's own offset, so a 09:00 Asia/Seoul meeting
stays 09:00; `EXDATE;TZID=...` parameters are normalised before expansion, moved
instances (`RECURRENCE-ID`) replace the original slot instead of duplicating it,
and a cancelled instance stays visible as a cancelled occurrence rather than
silently vanishing. All-day events are stored with their local date and an
all-day flag.

Verification: `bun run verify` = typecheck, bundle, 56 tests. The five calendar
tests cover EXDATE, moved and cancelled instances, incremental sync writing
nothing, page failure preserving cursor and snapshot, 410 full resync, and
materialization without duplicate instants.

Real HTTP QA against the live app with a fixture Calendar API (real adapter and
real fetch, fixture transport):
- `calendar-sync-recurrence`: two pages delivered the series, a moved instance
  and an all-day event; the occurrence view held 8 entries, the moved instance
  appeared once at 14:00 and never at 09:00, the EXDATE slot was absent, and the
  all-day event was present. The next sync sent the stored token and inserted
  nothing. See `http.json`, `occurrences.json`.
- `calendar-410-pagefailure`: a `410` left the cursor at `sync-1` with items and
  the 8 materialized occurrences intact, and a mid-page `500` after a fresh
  start also preserved the cursor so the connection could be marked stale.

Defects found and fixed by this QA: EXDATE carrying a `TZID` parameter did not
match a floating series (occurrences were not removed), times expanded in UTC
instead of the event's wall clock, every occurrence was flagged as overridden,
a cancelled series instance was tombstoned away instead of being reported as a
cancelled occurrence, and the occurrence rows referenced the external Google id
instead of the internal source item id (a foreign-key failure). Each was fixed
and re-verified.

Adversarial classes probed: expired token (410), mid-list failure, duplicate
occurrences, cancelled/withdrawn instance, timezone and all-day handling,
stale cursor, other-source preservation. Cleanup: QA ports rebound, temporary DB
removed (`cleanup.json`).

Known limits: the calendar a user reads is still `primary`; calendar selection
UI is part of the settings work, and the live Google API has not been called
(no authorized account yet), so real-world paging size and Google's exact
EXDATE formatting remain unverified until Task 25. Zones with DST keep their
wall clock; the stored instant carries the master's offset, which is exact for
Asia/Seoul and differs by the DST delta elsewhere.
