# Task 15 evidence

Source versions are turned into candidates deterministically: mail text yields
a task when it carries a date and a request, and a meeting when it mentions a
meeting; LMS assignment versions yield a task, or a `deadline_change` when the
due date differs from the previous version of the same item. Ambiguous wording
(`쯤`, `아마`, `될 것 같아요`, `다음 주쯤`) is stored as `tentative` and never
gets a confirmed time, so "다음 주쯤 만나자" cannot become a promise.

Every candidate carries its evidence id (`gmail:<message>`, `lms:<course>:
<assignment>`), people and place when present, and the previous due date for a
change. The dedupe key is a hash of kind, normalised subject and the dates: the
same content re-observed creates nothing, while a changed due date creates the
change candidate and supersedes the earlier live promise, so a briefing never
shows two current due dates for one assignment. A withdrawn source version
retracts the candidates it produced without touching candidates from other
sources.

Verification: `bun run verify` = typecheck, bundle, 73 tests. Six candidate tests
cover the mail task with evidence and people, tentative meeting handling, the
LMS deadline change with previous value, idempotent re-extraction, withdrawal
retraction and dedupe-key semantics.

Real-surface QA on the live app database (real extraction and storage modules):
- `candidate-mail-lms`: one extraction created 3 candidates — a confirmed task
  due 2026-12-05 with evidence `gmail:m-100` and a person, a tentative meeting
  with no start time, and an LMS `deadline_change` from 11-20 to 11-15 linked to
  its previous value. A second extraction created 0. See `candidates.json`.
- `candidate-dedupe-stale`: re-observing an unchanged due date created no row and
  no duplicate (3 → 3), the earlier 11-20 promise was no longer current, and
  withdrawing the mail retracted exactly one candidate while the LMS candidate
  stayed proposed. See `evidence-diff.json`.

Defects found by this QA and fixed: the "created" counter counted duplicate
stores as new; a changed due date left the earlier task live next to the change
(it is now superseded by evidence); and an unchanged re-observation briefly
emitted a redundant task instead of keeping the existing change record.

Adversarial classes probed: duplicate observation, value change vs. value repeat,
withdrawn source, ambiguous wording, other-source isolation, stale live promise.
Cleanup: QA ports rebound, temporary DB removed (`cleanup.json`).

Known limits: extraction is rule-based for Korean/ISO patterns; a phrasing
outside those patterns yields no candidate rather than a guess, and model-based
semantic refinement arrives with the briefing work (Task 17). Candidates are
never auto-accepted: nothing here writes to Calendar, Gmail or the LMS.
