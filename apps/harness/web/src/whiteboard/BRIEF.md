# Whiteboard screen brief

## Design read

Operational list/detail UI for a Korean-speaking owner inspecting durable filesystem documents and saving a note or task. Preserve digithive's compact native CSS, Pretendard/system font stack, semantic color tokens, 4px spacing scale, and quiet hierarchy. Dials: variance 3, motion 1, density 6. This is not a spatial board.

## Primary action

Save a new whiteboard note or task with the single prominent `whiteboard-save` button. Search, refresh, selection, reload, and update use secondary styling.

## Information priorities

1. Current query/kind filter and the filesystem document list.
2. Selected document title, path, content, provenance, status, and localized timestamps.
3. New note/task form, then the selected document's edit controls within the detail region.

## Left out on purpose

- Decorative stat cards, counts without a decision, and badges without live kind/status state.
- Graph/canvas machinery, spatial positioning, drawing tools, and node edges.
- Marketing copy, feature callouts, decorative icons, gradients, and motion without a state cause.
- Nested list/detail scroll regions and a second primary-styled action.

## Required content and selectors

- `whiteboard-panel`: mounted section and sole region scroll owner.
- `whiteboard-search-input`, `whiteboard-search-submit`, `whiteboard-kind-filter`: applied list query and kind filter.
- `whiteboard-document-list`, `whiteboard-document`: selectable filesystem summaries.
- `whiteboard-path`, `whiteboard-title`, `whiteboard-kind`, `whiteboard-content`, `whiteboard-save`: new document path, title, kind, Korean-capable body, and primary save.
- `whiteboard-status`, `whiteboard-update`: selected document status and guarded text/status update.
- `whiteboard-error`: offline, list/read/write, and stale-conflict causes.
- `whiteboard-loading`: initial/read/refresh/save/update progress, never a substitute for unknown data.
- Selected-only supporting hooks: `whiteboard-selected`, `whiteboard-selected-path`, `whiteboard-selected-title`, `whiteboard-selected-kind`, `whiteboard-edit-content`, `whiteboard-reload`.

Every form control has a visible Korean label. Paths remain text-selectable. Dates use the existing `formatDateTime` Korean/Asia-Seoul formatter. Create accepts Korean title/body text while its helper states the server's ASCII path rule.

## Data shape to component

- Many filesystem documents: query/kind controls plus a selectable list with title, path, kind, status, and updated time.
- One selected document: detail article with readable metadata and a text/status update form.
- New user-owned document: a separate create form for `thread` or `commitment`, using the only primary button.

Layout: whiteboard - explorable filesystem list beside selected detail, with creation after both in reading order -> list-detail (https://raw.githubusercontent.com/changeroa/StyleGallery/main/patterns/split-sidebar/list-detail.md); scroll owner: .whiteboard-panel, plus .whiteboard-list-section for the capped desktop list only; anti-patterns: fixed-width panes, uncapped list columns, visual order divorced from DOM/focus order, unbroken paths forcing horizontal overflow

The list-detail children have `min-width: 0`; the desktop two-column grid becomes one column at the existing 900px layout breakpoint. The panel owns vertical scrolling. Only the capped desktop list owns a region scrollbar, preserving the detail view. At 900px and below that scrollbar is removed, and at 390px all controls and content form one readable column.

## State table

| State, and what decides it          | The user sees                                                                     | Next action offered                         | Requests that run                  | Must not show or run                           | Leaves by                  |
| ----------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------- | ---------------------------------------------- | -------------------------- |
| Unknown: first list read pending    | `whiteboard-loading`; no empty claim                                              | Create remains available                    | GET list                           | Empty list, count of zero                      | List settles               |
| Unknown: list read failed           | Cause in `whiteboard-error`; retry                                                | Refresh/search retry                        | None until action                  | Empty state or stale list presented as current | Successful refresh         |
| Offline before or after loading     | Offline cause; cached rows if available                                           | Edit drafts, reconnect, refresh when online | No mutation from disabled controls | Save/update success or a new write             | Browser `online` event     |
| Empty: successful read returns zero | Korean explanation and create direction                                           | Fill and save a note/task                   | None                               | Error or loading                               | Create or filter change    |
| Loaded                              | Current filter and summaries                                                      | Select, search, refresh, create             | None                               | Previous settled error                         | Selection, filter, refresh |
| Selection changing                  | Old body removed; loading for the requested id                                    | Wait or choose another row                  | One GET for current id             | Previous document under the new selection      | Current read settles       |
| Selection read failed               | Selected id's cause and reload                                                    | Reload or select another row                | None until action                  | Empty document or wrong cached body            | Successful current-id read |
| Creating                            | Typed values locked; saving progress                                              | Wait                                        | One POST                           | Second submit, success notice, cleared form    | POST settles               |
| Create failed                       | Typed values and server/network cause                                             | Edit or retry                               | None until action                  | Cleared fields or saved notice                 | Retry or edit              |
| Updating                            | Current draft locked; update progress                                             | Wait                                        | One PATCH with `expectedHash`      | Second submit or saved notice                  | PATCH settles              |
| Stale update: HTTP 409              | Visible stale-revision conflict; unsaved draft retained                           | Explicitly reload latest revision           | None until reload or another edit  | Blind retry or overwritten draft               | Reload succeeds            |
| Save/update succeeded               | Server-returned document, refreshed summary, Korean status notice                 | Continue editing or create another          | POST/PATCH then GET list           | Prior error/spinner                            | Next action                |
| Reload/re-entry                     | Last selected id restored when still in the filtered list; server content re-read | Continue selection/update                   | GET list then GET selected id      | Memory-only detail presented as current        | Current reads settle       |

## Interaction and request invariants

- Document ids are encoded with `encodeURIComponent` in every detail/update URL.
- List and detail responses apply only to their latest request and current selected id.
- A shared ref plus disabled controls guards create/update against synchronous double submits.
- Failed writes retain their local drafts. Only explicit conflict recovery replaces an edit draft with the server revision.
- Selection persists in local storage when available; storage denial does not block the screen.
- Offline disables writes but not filter editing, cached selection, or reading already rendered data.

## Existing design system used

- Color roles: `--bg`, `--panel`, `--panel-2`, `--text`, `--muted`, `--accent`, `--user`, `--border`, `--danger`, `--warning`, `--success`, `--info`.
- Type: inherited body stack with `--font-xs`, `--font-sm`, `--font-md`, `--font-lg`.
- Spacing: `--space-1` through `--space-6`; borders use `--line`.
- Shape: `--radius-sm` and `--radius-md`; no new shadows or decorative materials.
- Primitives: existing `card`, `card-head`, `field`, `form-fields`, `run-meta`, `panel-intro`, `badge`, `primary`, `ghost`, `error-card`, and `empty-state` patterns.
- Local structural tokens are limited to the required 44px hit target, focus-ring width, readable measure, and press offset. Two heading tokens derive from the existing type scale at the required 1.25x step. No raw palette or independent font family is introduced.

Both themes inherit the parent's semantic variables. This isolated lane adds no theme-specific colors. The parent must include `whiteboard.css` in the served CSS after the existing global rules. The current build copies only `web/src/styles.css`, so mounting the TS component alone does not apply this stylesheet.

## Grounding and ideal state

On daily use, the current filter and real filesystem paths appear before editor chrome. Selecting a row reveals its actual body and revision status. Saving a note/task gives one clear pending/result cycle and leaves the new document selected. A stale filesystem edit never silently overwrites the user's draft. Recovery always names the next action.

Static gap ledger for the isolated lane:

| ID  | Screen/state          | Gap                                                                                     | Rule                                 | Evidence                                        | Fix/proof                                                  | Status             |
| --- | --------------------- | --------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------- | ------------------ |
| G1  | Mounted screen        | Parent mount and CSS import do not yet exist in this lane                               | Real-surface integration             | Scope explicitly excludes App/routes/global CSS | Parent mounts and imports, then runs browser QA            | Open, parent-owned |
| G2  | 390/1440, both themes | Computed contrast, reflow, focus visibility, and scroll ownership are not rendered here | WCAG 2.2 AA and frontend visual gate | No browser permitted in this lane               | Parent capture/detect/visual-QA matrix                     | Open, parent-owned |
| G3  | HTTP states           | Real server responses are not exercised by this isolated UI lane                        | State truthfulness                   | Parent owns route mounting and QA               | Parent real-HTTP/browser checks, including 409 and offline | Open, parent-owned |

No visual or WCAG pass is claimed by this brief. Source-level checks cover semantic controls, token usage, Korean copy, stable selectors, request guards, and the absence of horizontal-overflow-prone fixed tracks.
