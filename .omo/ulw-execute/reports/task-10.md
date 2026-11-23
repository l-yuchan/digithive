# Task 10 evidence

Memories carry a kind (fact, preference, inference, interest, commitment), a
status (active, superseded, deleted), a revision and an evidence reference, and
each statement is indexed in an FTS5 table. Every change advances a global
`context_epoch` stored in settings.

A correction never edits in place: it creates a new revision, marks the previous
one `superseded`, writes a `supersedes` edge, and removes the old wording from
the search index, so "correcting away" a statement really removes it from
retrieval. A stale revision, or a correction aimed at an already superseded or
deleted memory, is refused (409) instead of branching the history. A delete is
a tombstone plus index removal, and the audit row records only the revision,
not the deleted text.

Retrieval filters by kind in SQL, so an interest cannot answer a commitment
query, and interests are listed separately without ever being promoted. Ranked
citations are built from retrieved records only, and a citation naming an id the
process did not retrieve is dropped. The executor now captures the epoch at
start and refuses to publish an answer whose context epoch moved during the run
(`context_changed`), which is the in-flight correction contract.

Verification: `bun run verify` = typecheck, bundle, 45 tests, including five
memory tests (correction propagation, stale/ superseded refusal, delete
tombstone with no body in audit, interest-vs-commitment isolation, citation
filtering, epoch advancement). The migration rollback test was made
version-relative so adding migration 003 cannot silently skip it.

Real browser QA (owned Chrome, real app):
- `memory-correct-browser`: added "아침에는 길게 설명해줘" (preference, rev 1),
  edited it in the UI to "아침에는 짧게 설명해줘" and the list showed rev 2. The
  search endpoint then returned exactly one citation at revision 2 with the new
  wording, and the old wording matched nothing. See `memory-diff.json`,
  `actions.json`, `desktop.png`, `mobile.png`.
- `memory-revoke-inflight`: a run whose model reply was delayed 1.2 s had its
  source memory deleted mid-flight. The epoch moved 2 → 3, the run failed with
  `context_changed`, the answer was not published, the deleted statement no
  longer matched search, and a stale correction of the deleted memory returned
  409. See `events.json`, `retrieval.json`.

Defect found by this QA and fixed: correcting a memory that was already
superseded used to succeed because the guard only checked the revision number;
it now refuses with 409 and the regression is covered by a test.

Adversarial classes probed: stale revision, concurrent correction race,
deleted-in-flight publication, interest-to-commitment promotion, invented
citation ids, old wording resurfacing, tombstone leakage in audit. Cleanup: QA
ports rebound, temporary DB removed (`cleanup.json`).

Known limits: automatic extraction of memories from conversation is not wired
yet — memories are added explicitly today, and model-driven extraction with
candidate review is the Task 15/20 path. Embeddings are deliberately not used;
FTS5 tokenises Korean by whitespace, so a query must share a token with the
statement.
