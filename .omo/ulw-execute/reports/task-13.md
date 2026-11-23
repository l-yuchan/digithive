# Task 13 evidence

Gmail collection is read-only: it calls `users.getProfile`, `users.messages.list`
(bounded query `newer_than:30d in:inbox` plus the selected labels) and
`users.history.list`, and never read/modify/send. The first collection records
the profile history id as a watermark, pages through the message list, fetches
each message detail, then catches up from that watermark so mail arriving during
the initial collection is not lost. Later runs are history-only; an expired
history id (404) triggers a bounded full resync of the same range.

Every HTTP request happens before any write. Versions and the cursor commit in
one transaction at the end, so a failed detail request leaves both untouched —
verified by a mid-list 500 that kept the cursor and version count. An unchanged
message hashes identically and stores nothing new; a label change records the
new state once, as a state update rather than a content event.

MIME handling prefers `text/plain` and falls back to HTML reduced to text:
`<script>`/`<style>` blocks, comments and tags are removed and entities decoded,
so a command or link inside a mail is data, never an instruction or a render.
Bodies are base64url-decoded and bounded to 40k characters with a truncation
flag.

Verification: `bun run verify` = typecheck, bundle, 62 tests. The six Gmail tests
cover plain-over-HTML preference, script removal, truncation, initial
collection with catch-up, incremental label update, expired history resync and
a failed detail preserving the cursor.

Real HTTP QA against the live app with a fixture Gmail API (real adapter, real
fetch, fixture transport):
- `gmail-history-mime`: first sync stored 2 messages, requested `/profile` and
  the catch-up `startHistoryId=5000`, and stored the deadline text without any
  `<script>`; the second sync was history-only, touched one message, recorded
  the label change once and advanced the cursor to `5009`. 3 versions total.
  See `http.json`, `message-versions.json`.
- `gmail-404-and-partial`: a 404 on history produced a full resync and moved the
  cursor to the catch-up watermark `6005`; a later detail failure left the cursor
  and version count unchanged. No external writes, no rendered HTML and no
  executed injected script — the mail's `fetch('https://evil.invalid/...')`
  stayed inert text. See `db-diff.json`, `tool-audit.json`.

Defect found by this QA and corrected in the expectation set: a label change was
originally expected to be a no-op, but message state includes `labelIds`, so it
correctly produces one new version; the unit test and the QA now assert that
state-update semantics.

Adversarial classes probed: expired history, mid-list failure, HTML/script
injection in a message body, label-only change, duplicate content, oversized
body. Cleanup: QA ports rebound, temporary DB removed.

Known limits: the real Gmail API has not been called (no authorized account yet),
so real quota/paging behaviour, real MIME variety and thread-level dedupe remain
unverified until Task 25; attachment bodies are recorded as metadata only, not
downloaded.
