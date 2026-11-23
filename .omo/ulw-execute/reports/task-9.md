# Task 9 evidence

Files live in a content-addressed store: the blob path is the sha256 of the
bytes, so identical uploads share one blob and a file row can never point at a
different payload. A logical path is unique; re-uploading to the same path is
refused with 409 instead of silently replacing the user's file (replacement is
the approval-gated flow of Task 21). Paths are normalised to forward slashes and
any `..`, absolute path, drive prefix, empty segment or NUL is refused, and a
blob path is resolved and checked to stay inside the blob root, so a traversal
cannot read or write outside the namespace.

Extraction is best effort and separate from the original: text and markdown are
decoded as UTF-8, PDF uses `unpdf` (pdf.js), docx uses `mammoth`, and everything
else is stored and downloadable with status `unsupported`. A corrupt PDF or an
empty text layer records `failed` with an error code; it is never stored as an
empty successful extraction. Uploaded HTML is rejected (415) and no content is
executed. The default limit is 25 MiB and extraction is capped at 200k
characters. Deletion removes the row and reports whether the blob became
unreferenced rather than blindly deleting a shared blob.

Verification: `bun run verify` = typecheck, bundle (6 artifacts plus styles),
39 tests including six file tests (round trip and separation of derived text,
unsupported file, corrupt PDF failure, path escapes, duplicate/oversized,
deletion).

Real browser QA (owned Chrome, real app, real blob directory):
- `files-browser-roundtrip`: uploaded `tests/fixtures/files/assignment.pdf`
  through `file-upload`, saw "본문 추출 완료", and the authenticated download
  returned identical bytes (sha256
  `c9f7f7b70e47834135f1afef30d1582b8be9c70028596e13d7e3bec4c56c7605`, 631
  bytes). The derived text endpoint returned the PDF text layer, proving the
  original and the derived copy are separate. A reload kept the row; at 390 px
  the row and its download action stayed usable. See `hashes.json`,
  `actions.json`, `desktop.png`, `mobile.png`.
- `files-path-size-corrupt`: traversal path 422, 26 MiB upload 413, corrupt PDF
  201 with `extraction: "failed"`, `text/html` 415, and only the two legitimate
  logical paths were stored. See `http.json`, `disk-diff.json`.

Visual defect found by the capture and fixed: the first files screen rendered
the form inline and the file row ran its fields together; the form now uses a
labelled grid and the row separates name, metadata and the download action.

Adversarial classes probed: path traversal and symlink-style escape (namespace
check), oversize upload, corrupt document, HTML/script upload, duplicate path,
shared-blob deletion, stale list (reload re-reads the store). Untrusted text
from extracted documents is data only and is not executed. Cleanup: QA ports
rebound, upload directory removed with the temporary DB (`cleanup.json`).

Known limits: no Office `.xlsx`/`.pptx`, no OCR for scanned PDFs, and no
in-place overwrite path yet (that is the approval-gated requirement of
Task 21). Both-theme and full-page visual QA is Task 23.
