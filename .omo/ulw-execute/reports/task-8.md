# Task 8 evidence

The web app now has a conversation surface: a conversation list, a message
thread, a composer, a run status line and a cancel button, plus a small
server-rendered shell and a bundled client script (`/app.js`, `/styles.css`)
guarded by a CSP that allows only same-origin scripts and connections.

A message send carries a `client_request_id`; the server inserts the user
message and its Run in one immediate transaction and a repeat of the same
request id returns the original message and Run, so a double click or a
retried request cannot start two tasks (unit test, plus the 202/202 in
Task 4's QA). A message for an unknown conversation is refused with 404 and
writes no Run. Assistant answers are appended by the worker when the Run
succeeds, which is why the answer survives a reload and a client that closed
mid-run.

Event handling: the client subscribes to the seq-based SSE endpoint, and if
that stream closes (it is a replay-then-close stream today) it falls back to
polling `GET /api/runs/:id`, so a reload or a dropped connection never shows a
stale "still working" state. The status line and cancel button are the only
sources of run state; cancel is a real POST to the CAS endpoint.

Verification: `bun run verify` = strict typecheck, bundle (5 artifacts plus
styles) and 33 tests, including three conversation tests (idempotent resend,
unknown conversation, ordering). `check-draft-guard` reports the three web
sources clean.

Real browser QA (owned headless Chrome, disposable profile, real app on
127.0.0.1:4317 with a fixture provider and a real worker process):
- `chat-browser`: typed "이 단어의 어원을 설명해줘" into `chat-input`, clicked
  `chat-send`, and the fixture answer appeared. A reload kept the question and
  exactly one answer (`answers: 1`). At 390 CSS px the conversation kept one
  answer with `documentWidth === innerWidth === 390`. See `actions.json`,
  `desktop.png`, `mobile.png`.
- `chat-offline-cancel`: sent a message with no worker running, reloaded, and
  the status truthfully said "작업 대기 중…"; the UI cancel reached a terminal
  "취소되었습니다" state; a worker started afterwards produced no answer and no
  duplicate bubble. See `actions.json`, `mobile-error.png`.

Defects found and fixed by this QA: the status line was overwritten by a
generic "작업 진행 중" whenever a run was re-subscribed after reload, and the
SSE stream closing on replay looked like a reconnect failure; on mobile the
sidebar consumed about 40% of the screen because the implicit grid rows
stretched equally. Each was fixed and the screenshots re-captured from the
current build.

Adversarial classes probed: duplicate submission (one Run), reload during a
queued run (truthful pending state), cancel then late worker (no answer, no
duplicate), stale client state (status comes from the server), malformed route
ids (422/404), plain-text rendering of model output (no HTML injection), and
dirty worktree discipline. Prompt injection and file handling belong to later
tasks. Cleanup: worker killed, QA ports rebound, temporary DB removed
(`cleanup.json`).

Known limits: the SSE stream is replay-then-close, so the client polls after
the first disconnect; a long-lived stream with heartbeats is a Task 23
refinement. Full accessibility and both-theme visual QA is Task 23/F3; this
task captured the dark theme at 1440 and 390 plus the error state.
