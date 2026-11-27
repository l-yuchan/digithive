# Conversation naming workflow lookup

The workflow definition is intact. Its ID is `system:title`. The client correctly
encodes it as `system%3Atitle` in resource URLs, but `handleWorkflowRequest` used
the raw URL pathname capture as a database key.

Before the repair, an authenticated request against the running server returned:

| Request | Status | Result |
| --- | --- | --- |
| `/api/workflows/system%3Atitle` | 404 | `workflow_not_found` |
| `/api/workflows/system:title` | 200 | ID `system:title` |

The fix decodes the resource segment once before dispatching detail, edit, delete,
run and history requests. Malformed escapes return 400 `invalid_workflow_id`.
No workflow or database migration is needed.

The HTTP regression using the real `ensureTitleWorkflow` fixture failed with 404
before the fix and passed afterward. The six HTTP tests, including malformed
escapes, pass. Repository verification passed with 304 tests before the final
malformed-escape test was added; formatting passed.

Browser verification initially had no connected extension. BrowserSkill setup
registered Chrome and requested that the owner enable its extension.

## Release preparation

The visible version label is mounted in the navigation. CD supplies the commit
through the Docker build argument `GIT_COMMIT`; the client renders
`0.0.1-<seven-character commit>`. Build metadata retains the independent build ID
used by the existing stale-client reload mechanism.

The shared checkout passes lint, typecheck, web build, 309 tests and formatting.
It also contains unrelated settings/provider edits, which are excluded from the
release snapshot at
`C:/Users/chabun/AppData/Local/Temp/digithive-title-release-20261127`.
That snapshot starts from `9c009f6` and includes only this task's files and the two
version-mount additions in `App.tsx`. Fresh dependency installation, lint,
typecheck, web build, 296 tests and formatting all exit 0 there. The differing
test count comes from excluding the unrelated work.

The owner approved the fix after release preparation. The release build receives
its new commit from CD; the earlier local captures name the base commit.

## Local browser verification

The owner could not enable BrowserSkill and requested an alternative. A
task-owned headless Chrome opened the isolated release server with a temporary
database seeded using `ensureTitleWorkflow`. The real workflow UI loaded the
`system:title` definition, parameter and history sections after selecting its row,
without the reported 404. At desktop width 1440 and mobile width 390, the visible
`0.0.1-9c009f6` label remained inside the viewport with no page horizontal
overflow. Screenshots were inspected directly; mobile wraps the label beneath
the tabs. These are local seeded-data checks, not live-deployment verification.
The browser and local server were stopped and the temporary browser profile was
removed afterward.
