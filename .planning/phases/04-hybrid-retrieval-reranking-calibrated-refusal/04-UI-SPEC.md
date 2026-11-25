---
phase: "04"
plan: "36"
slug: "hybrid-retrieval-reranking-calibrated-refusal"
surface: "Config UI: RAG administration > Chunking profiles and Refusal calibration panels"
status: approved
reviewed_at: 2026-11-25
shadcn_initialized: false
preset: none
created: "2026-11-25"
decisions: [D-17, D-21, D-29]
requirements: [CHK-04, CHK-05, RNK-05]
---

# Phase 4, Plan 36: UI Design Contract (Config UI chunking and refusal panels)

> Visual and interaction contract for plan 04-36, its only consumer. Written by gsd-ui-researcher with the `frontend-design` skill
> (direction) and the Impeccable `craft-floor` and `mode-operate` references (criteria the built UI is later critiqued against). The
> executor builds from this file; the auditor compares the built UI against it. No question was put to the user: every open point is
> decided in section 14.

Sources read: `04-36-PLAN.md`, `04-CONTEXT.md` (D-17, D-21, D-29), `04-RESEARCH.md` (F-7, F-11, F-19, F-21), `04-34-SUMMARY.md` and
`04-35-SUMMARY.md` (branch `exec/04-34`, commit `997988c6`), the route code under `src/app/api/rag/admin/chunking-profiles/**` and
`src/app/api/rag/admin/refusal-calibration/route.ts` on that branch, `src/lib/rag/refusal/status.ts`, `src/lib/rag/chunking/report.ts`,
`validate.ts` and `profile-ops.ts`, `src/lib/rag/ingest/rechunk/run.ts`, migrations `0406`, `0412` and `0413`, the generated
`ChunkingProfile`, `ChunkingSweepReport`, `ChunkingDecision` and `RefusalThresholds` schemas, the committed
`eval/reports/chunking-sweep.json`, `eval/decisions/chunking/index.json` and `eval/config/refusal-thresholds.json`,
`rag-sidecar/schemas/chunking-profile-cases.json`, `scripts/config-ui/index.html`, `scripts/config-ui/rag-panels/*.js`,
`scripts/config-ui/document-processing/status-monitor.js`, `tests/ui/config-rag-panels.test.ts`,
`tests/ui/config-ingestion-panel.test.ts`, and the previous Config UI contract `03.1-36-UI-SPEC.md`, whose tokens this file reuses.

---

## 0. Findings that shape this contract (read first)

Facts from the code. Each one changes what the panels can show or do. Items 2, 3, 4 and 5 differ from what `04-36-PLAN.md` assumes;
section 14 records how this contract resolves each.

1. **The backend is not on the main tree yet.** The routes exist on `exec/04-34` (worktree `/home/user/wt/04-34`, also the base of
   `exec/04-36`). This contract is written against that code.
2. **The list route returns no validation context.** `GET /api/rag/admin/chunking-profiles` answers
   `{ success, active, missing_from_active, profiles }` only. It does not return the embedding input limit, top-k or context budget. The
   plan says "the panel fills the context from the list route's response"; it cannot. Two of the five rules
   (`child_exceeds_embedding_input`, `top_k_parent_over_budget`) need that context, so in the browser only the server can judge them
   (section 6.4).
3. **The list route returns no gate evidence.** Whether a passing decision is recorded in the database, and whether the last build left
   open gaps, is known only to `rag_chunking_profile_state`, which no route exposes. The panel cannot know in advance that Activate will
   be refused. It shows the decision committed in the repository (from `GET /report`) and learns the gate's answer from the 409.
4. **The build answer's `status` is the run status, not the profile status:** `running`, `completed`, `incomplete` or `failed`, with
   `more: true` only while `running`. It never says `ready`. A `failed` run answers 200 without its reason. Gap counts are cumulative
   for the run and arrive by reason only (`no_parse_output`, `failed`).
5. **A gap does not end a build.** The run records the gap and goes on to the next document. The plan's "until status ready or a gap is
   reported" would stop a build at its first unreadable document and leave the rest unbuilt for no benefit.
6. **The report and refusal routes answer 500, not 503, when their committed file is unreadable** (`chunking_report_invalid`,
   `chunking_decisions_invalid`, `chunking_report_unavailable`, `refusal_status_unavailable`). `ragFetch` passes `body.error` through as
   the message, so the panels must map these codes themselves or the admin sees a raw code.
7. **Legacy rows carry placeholder sizes.** Migration 0406 seeds one `legacy` row per document type with `child_tokens` 512 or 768,
   `parent_mode: 'none'`, `parent_tokens: null` and `preset: '256/1024'`. None of that describes the legacy chunks. The panel never
   renders sizes, mode or preset for `legacy`.
8. **`legacy` exists for all six document types,** so activating or building by id alone can answer 409 `ambiguous_profile`. Every
   build, activate and rollback body carries `doc_type`.
9. **Report profile ids are preset slugs** (`legacy`, `p128-512`, `p256-1024`, `p256-2048`). The registry id that a recorded decision
   names is `<slug>-<doc_type>`, for example `p256-1024-contract_legal`. The form's suggested id follows this pattern so a decision
   finds its profile.
10. **The database requires a parent size in structure mode too** (`parent_tokens is required unless the parent mode is none`), while
    the validator reports `parent_tokens_required` only for `fixed`. The form makes the parent size required in both modes and does not
    offer mode `none` (that is what `legacy` is).
11. **The refusal route gives no target rate and no bound for correct refusals.** Each cell has `false_refusal_point_estimate`,
    `false_refusal_upper_bound_95` and `correct_refusal_point_estimate` for dev and holdout. The panel therefore draws no target line
    and gives no pass or fail colour to a rate (F-19).
12. **`ragFetch` does not catch network failures and its 401, 403 and 503 messages are English only.** The panels wrap every call and
    localize through the shared `ingestLabel` table (section 8).
13. **All Config UI scripts are classic scripts sharing one global scope.** A second top-level `const`, `let` or `class` with a name
    another loaded script already declares stops the whole file with a SyntaxError. Names already taken include `DOC_TYPE_IDS`,
    `DOC_TYPE_CHOICES`, `CONFIG_UI_DOC_TYPE_LABELS`, `INGESTION_LABELS`, `TIER_ORDER`, `NON_TERMINAL`, `IngestionPanel` and
    `EmbeddingProfilesPanel`. Every top-level name in the three new files starts with `Chunking`, `CHUNKING_`, `Refusal` or `REFUSAL_`,
    or is a function declaration with a name unique to its file.
14. **The older RAG panels bind their init to the first `[data-tab="rag-administration"]` link only,** so the mobile drawer link never
    starts them. The Ingestion panel binds every link. The new panels copy the Ingestion panel.

---

## 1. Design direction (frontend-design pass)

**Subject.** Two operator views in an existing admin dashboard: a registry of chunk-size profiles per document type with a guarded
switch, and a read-only statement of which answer-refusal thresholds are in force.
**Audience.** A deployment admin at a desktop who has just run an evaluation sweep or a calibration and now asks: "which profile is
live for contracts, is the new one fully built, did it beat legacy, and may I switch?" and "is threshold refusal really applying, and
how sure are these numbers?"
**Primary job.** Chunking profiles: create a profile, build it, compare it with legacy, activate it or roll back. Refusal calibration:
read the warnings, then read the cells.

**Mode.** Impeccable "Operate". Both panels are working tools first. Sections, sub-tabs, tables, badges, alerts and the confirmation
dialog are the ones the Ingestion panel already uses (DaisyUI 4 classes on native elements). Nothing new is invented for navigation or
controls.

**Signature move: a rate is never one number.** Every refusal rate in both panels is drawn the same way: the point estimate as a dot on
a 0 to 100% track, a bar reaching from 0 to the 95% upper bound, and both numbers written beside it with the item count (section 6.9).
With the small item counts these evaluations have, the bar is visibly much longer than the dot's position, which is exactly what F-19
asks the UI to be honest about. The mark is neutral in colour: no route provides a target, so the UI never paints a rate as good or
bad. Nothing else in the two panels is decorative.

**Review against generic defaults (what was changed and why).**
- Rejected a stat tile per document type (big active-profile name, small label). Six tiles hide the thing an admin compares, which is
  the profiles of one type side by side. Each type is a short table.
- Rejected a card per profile (the Embedding profiles pattern). Profiles of one type are comparable rows.
- Rejected a modal editor. The new-profile form opens inline, because it neither interrupts nor needs protected focus. The only modals
  are the two confirmations, which do.
- Rejected a stepper ("1 Create, 2 Build, 3 Compare, 4 Activate"). The steps are real, but each profile is at its own step, so the
  step shows as that profile's status badge and its single primary button.
- Rejected red or green on rates and a "meets target" tick. The data cannot support either claim.
- Rejected a progress ring. The build is a plain `<progress>` bar with the counts written under it.
- Rejected emoji and middle-dot meta strings (the Embedding profiles summary uses dots). Values sit in table cells with real headers.

**Quality floor (built without announcing it).** Visible keyboard focus, `prefers-reduced-motion` respected, all text at least 4.5:1,
tabular numerals in every number column, usable down to 360 px, every state in section 7 present, every server string inserted with
`textContent`.

---

## 2. Design System

| Property | Value |
|----------|-------|
| Tool | none (the Config UI is a static HTML page served by `scripts/config-server.js`; the root `components.json` belongs to the Next.js app and does not apply to this surface, so the shadcn gate and registry vetting do not apply) |
| Preset | not applicable |
| Component library | DaisyUI 4.4.24 class library over Tailwind (Play CDN; `tailwind.config.colors` extends `myrag-primary`, `myrag-primary-light`, `myrag-primary-dark`) |
| Icon library | Bootstrap Icons 1.11.3 (already loaded by `index.html`); decorative only, always `aria-hidden="true"` and always next to a text label |
| Font | Inherited system stack (Tailwind `font-sans`). No new web font. `font-mono` only for identifiers the admin may type or search for: profile ids, reranker model ids, shell commands, file paths, unknown server codes |
| Themes | DaisyUI `dark` (default) and `light`, switched by the existing theme toggle. Every colour in this contract is a theme token |
| Script style | Plain browser script in the Ingestion panel's style: one class per panel, pure view-model builders exported through `module.exports` for vitest, `window.*` globals for the page, DOM built with `createElement` and `textContent` only, never `innerHTML` |

---

## 3. Component Inventory

Enumerated by `grep -ohE 'class="[^"]*"' scripts/config-ui/index.html | grep -oE '\b(alert|badge|btn|card|checkbox|collapse|divider|dropdown|form-control|input|join|kbd|label|loading|menu|modal|progress|radio|range|select|stat|stats|steps|table|tabs|tab|textarea|toast|toggle|tooltip|skeleton)\b' | sort -u | wc -l` — 26 components — daisyui@4.4.24 (resolved by `grep -o 'daisyui@[0-9.]*' scripts/config-ui/index.html`, the pinned CDN URL; DaisyUI is not an npm dependency and `grep -c daisyui package-lock.json` is 0) — 2026-11-25.

The table is the **known-good, non-exhaustive** set for these two panels. Other DaisyUI 4.4 classes may be used when needed.
`progress` is a DaisyUI 4 class the page does not use yet; it is the expected choice for the build bar, on a native `<progress>`.
`skeleton`, `stat` and `steps` are not used by these panels.

| Component | Classes / element | Used for |
|-----------|-------------------|----------|
| Section card | `section.card.bg-base-200.shadow-md > .card-body` | Both panel containers, identical to the sibling RAG panels |
| Sub-tabs | `div.tabs.tabs-bordered[role=tablist] > button.tab[role=tab]`, `tab-active` | Profiles and Sweep report |
| Buttons | `btn btn-sm`, `btn-primary`, `btn-outline`, `btn-ghost`, `btn-link` | Actions (section 6). No `btn-error` anywhere in these panels |
| Radio as button | `input[type=radio].btn.btn-sm` with `aria-label`, inside `fieldset` | Size preset |
| Radio | `input[type=radio].radio.radio-sm` in `label` | Parent boundaries |
| Input | `input.input.input-bordered.input-sm`, `input-error` | Child size, parent size, profile ID |
| Select | `select.select.select-bordered.select-sm` | Document type, report slice |
| Form control | `.form-control`, `.label`, `.label-text`, `.label-text-alt` | Form fields and their help lines |
| Table | `table.table.table-sm` inside `div.overflow-x-auto` | Profiles per type, decisions, report, model matrix, threshold cells |
| Badge | `badge badge-sm` + `badge-success`, `badge-info`, `badge-warning`, `badge-ghost`, `badge-outline` | Profile status, gate result, cell status, fixture and stale marks |
| Alert | `div.alert.alert-warning`, `alert-error`, `alert-info` | Sign-in, unavailable, gate refusal, coverage warning, calibration warnings, fixture notice |
| Progress | `progress.progress.progress-primary.w-full` (native element) | Build progress |
| Loading | `span.loading.loading-spinner.loading-sm` | In-flight states, always with text |
| Modal | `dialog.modal > .modal-box > .modal-action`, `form.modal-backdrop` | Activate and roll-back confirmations only |
| Disclosure | native `details > summary` | Gate regressions in the report, status legend in the refusal panel |

---

## 4. Spacing Scale

Tailwind spacing utilities only; no arbitrary pixel values. Same scale as `03.1-36-UI-SPEC.md`.

| Token | Value | Tailwind | Usage |
|-------|-------|----------|-------|
| xs | 4px | `gap-1`, `mt-1` | Icon to label inside a badge or button; a value to its second line; a field to its help line |
| sm | 8px | `gap-2`, `mb-2` | Buttons in a row, preset radios, heading to its description, badges side by side |
| md | 16px | `gap-4`, `mt-4`, `mb-4`, `p-4`, `py-4` | Between form fields, toolbar to content, table to the line under it, padding of the form region and the build region, vertical padding of each document-type block |
| lg | 24px | `gap-6`, `mt-6` | Between sibling panels (existing `grid gap-6`); between the summary, the warnings and the cells table in the refusal panel; between the decisions table and the comparison table |
| xl | 32px | `.card-body` default, `py-8` | Card padding (DaisyUI default, unchanged); vertical padding of empty-state blocks |
| 2xl | 48px | `h-12` (DaisyUI `btn` height) | Touch-size row actions below 768px |
| 3xl | 64px | not used by these panels | Reserved for page-level spacing |

Exceptions: none in spacing. No 2px, 6px, 10px or 12px spacing appears in these panels.

Component internals outside the scale (not spacing tokens, do not restyle):
- DaisyUI `table-sm` cell padding, `input-sm`, `select-sm` and `btn-sm` (32px) and `btn` (48px) heights are used exactly as shipped. Row
  actions are `btn md:btn-sm`: 48px tall below 768px, 32px from 768px up.
- DaisyUI `progress` is 8px tall as shipped.

Sizes that are not spacing: the rate mark track is 4px tall (`h-1`) and 96px wide (`w-24`), its dot is 8px (`w-2 h-2`).

---

## 5. Typography

Exactly four sizes and two weights, the same as the sibling panels.

| Role | Size | Weight | Line height | Tailwind | Where |
|------|------|--------|-------------|----------|-------|
| Panel heading | 18px | 600 | 1.33 (`leading-7`) | `text-lg font-semibold` | "Chunking profiles", "Refusal calibration" |
| Sub-heading | 16px | 600 | 1.5 (`leading-6`) | `text-base font-semibold` | Document-type names, form title, "Sweep decisions", "Warnings", "Thresholds", dialog titles |
| Body | 14px | 400 | 1.43 (`leading-5`) | `text-sm` | Descriptions, table cells, alert text, status messages, form labels, buttons |
| Meta | 12px | 400 (600 for table headers) | 1.33 (`leading-4`) | `text-xs` | Table headers (`font-semibold`, overriding DaisyUI's 700), second lines in cells, help lines, badges, item counts, report notes |

Rules:
- Every number column, the build counts and the rate cells use `tabular-nums`; numbers are right-aligned in their columns.
- Description and alert paragraphs cap at `max-w-prose`.
- Profile ids and model ids use `font-mono text-sm` and `break-all`. Commands and file paths use `code.font-mono.text-xs` with
  `break-all`. Nothing else is monospace.
- No all-caps labels, no letter-spaced eyebrows, no label above a heading, no single emphasised word inside a heading.
- Each panel root carries `lang="<locale>"` (`en`, `zh` or `it`), as the Ingestion panel does. Text that stays English inside a
  localized panel (report notes, unknown server messages) is wrapped in an element with `lang="en"`.

---

## 6. Layout and interaction

### 6.1 Placement and mount

```
RAG administration (existing tab #rag-administration, .card.bg-base-100 > .grid.gap-6)
  1. Document types        (existing  #rag-administration-doc-types)
  2. Ingestion             (existing  #rag-administration-ingestion)
  3. Quarantine            (existing  #rag-administration-quarantine)
  4. Embedding profiles    (existing  #rag-administration-profiles)
  5. Chunking profiles     (NEW       #rag-administration-chunking)
  6. Refusal calibration   (NEW       #rag-administration-refusal)
```

Chunking profiles sits next to Embedding profiles because it is the same kind of thing (a built variant with an active pointer).
Refusal calibration is last because it is the only read-only block. The tab's intro sentence becomes: "Manage document-type defaults,
ingestion jobs, quarantined uploads, embedding and chunking profiles, and check refusal calibration, using your existing admin
session."

- `index.html` loads, once each and in this order after `rag-panels/ingestion.js`: `rag-panels/chunking-validate.js`,
  `rag-panels/chunking-profiles.js`, `rag-panels/refusal-calibration.js`.
- `index.html` gets only the two `section` skeletons: heading, description paragraph, one alert host, one status region
  (`role="status" aria-live="polite"`) and one empty content host each. The scripts build everything else. No other markup in the
  file changes, except the pointer line of section 6.10 and the intro sentence above.
- `initChunkingProfilesPanel()` and `initRefusalCalibrationPanel()` are idempotent: the first call mounts, later calls refresh and keep
  the selected sub-tab, the report slice, an open form with its values, and a running build. Bind both to **every**
  `[data-tab="rag-administration"]` element (`querySelectorAll`) and call them on `DOMContentLoaded` when that tab is already active.
- Neither panel reads `#workspace-selector`. Chunking profiles and thresholds are deployment-wide; both descriptions say so.
- Locale: `navigator.language` first two letters, `zh` or `it`, otherwise `en`, exactly as the Ingestion panel resolves it. Document
  type names come from `window.docTypeLabelForLocale` (in vitest, from `require('./doc-types.js')`), so they stay identical to the app's
  labels in zh, en and it. The six types are always listed in the order `general`, `financial_report`, `contract_legal`,
  `invoice_receipt`, `product_technical`, `scanned_image`.
- Every request goes through `ragFetch` with the full path, for example `ragFetch('/api/rag/admin/chunking-profiles', { method: 'GET' })`.
  No other fetch target, no `Authorization` header, nothing written to `localStorage`, `sessionStorage` or a cookie.

Calls made:

| Call | When | Body |
|------|------|------|
| `GET /api/rag/admin/chunking-profiles` | Mount, Refresh profiles, after create, after a build ends, after activate or rollback, after any 404 or 409 | none |
| `GET /api/rag/admin/chunking-profiles/report` | Mount (in parallel with the list), Refresh profiles | none |
| `POST /api/rag/admin/chunking-profiles/validate` | 400 ms after the last form change once the form passes the local checks; again on Create profile | `{ id, doc_type, child_tokens, parent_mode, parent_tokens, preset }` |
| `POST /api/rag/admin/chunking-profiles` | Create profile, after validate answers `valid: true` | same six keys, nothing else (the schema is strict) |
| `POST /api/rag/admin/chunking-profiles/{id}/build` | Each build step | `{ doc_type }` |
| `POST /api/rag/admin/chunking-profiles/{id}/activate` | Confirmed activation | `{ doc_type }` |
| `POST /api/rag/admin/chunking-profiles/rollback` | Confirmed rollback | `{ doc_type }` |
| `GET /api/rag/admin/refusal-calibration` | Mount, Refresh status | none |

### 6.2 Chunking profiles: panel anatomy (desktop, 1024px and up)

```
┌ Chunking profiles ───────────────────────────────────────────────────────────────┐
│ Chunk sizes per document type. Build a new profile next to the current one,      │
│ compare it in the sweep report, then activate it. Applies to every workspace.    │
│ (alert host: sign-in or unavailable)                                             │
│ [ Profiles ] [ Sweep report ]                                                    │
│ ──────────────────────────────────────────────────────────────────────────────── │
│ [+ New profile]                         Updated 14:02   [⟳ Refresh profiles]     │
│ (new-profile form region, when open)                                             │
│                                                                                  │
│ General                                                                          │
│ Legacy chunks are active. No other profiles.                                     │
│ ──────────────────────────────────────────────────────────────────────────────── │
│ Contract & legal                                          [Roll back profile]    │
│ Active: p256-1024-contract_legal, since 25 Nov 2026                              │
│ Sweep decision: p256-1024-contract_legal, check against legacy passed, live      │
│ ⚠ Documents missing from the active profile p256-1024-contract_legal: 3. …       │
│                                                     [Build missing documents]    │
│ ┌──────────────────────────┬──────────────────┬──────────┬───────────┬─────────┐ │
│ │ Profile                  │ Sizes            │ Status   │ Documents │ Actions │ │
│ ├──────────────────────────┼──────────────────┼──────────┼───────────┼─────────┤ │
│ │ p256-1024-contract_legal │ 256 / 1,024 tok. │ ● Active │ 120 of 123│         │ │
│ │                          │ follows structure│          │ 3 missing │         │ │
│ │ p128-512-contract_legal  │ 128 / 512 tokens │ Ready    │ 123 of 123│[Activate profile]│
│ │ p256-2048-contract_legal │ 256 / 2,048 tok. │ Building │ 40 of 123 │[Continue build]  │
│ │   ▓▓▓▓▓▓▓░░░░░░░░░░░░░  40 of 123 documents built            [Pause build]     │ │
│ │ legacy                   │ As first ingested│ Ready    │     —     │[Activate profile]│
│ └──────────────────────────┴──────────────────┴──────────┴───────────┴─────────┘ │
│ ──────────────────────────────────────────────────────────────────────────────── │
│ Financial report  …                                                              │
│ (status region, role=status, aria-live=polite)                                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Hierarchy: panel heading, alert host, sub-tabs. **Profiles** is selected on first mount; the selection persists in memory for the page
session. The toolbar (`flex flex-wrap items-center gap-2 mb-4`) holds `btn btn-outline btn-sm` "New profile" (`bi-plus-lg`) on the left
and, at `ml-auto`, the 12px "Updated {time}" (`<time>` of the last successful list fetch) and `btn btn-outline btn-sm` "Refresh
profiles" (`bi-arrow-clockwise`). The help line of section 12.2 (`help.decision`) sits under the toolbar, 12px, muted, `max-w-prose`.

### 6.3 Profiles sub-view

Six document-type blocks, stacked, separated by `divide-y divide-base-300`, each `py-4`.

**Block header** (`flex flex-wrap items-start justify-between gap-2`):
- Left: the type name (16/600, `h4`); under it, 14px, `group.active` with the active profile (`font-mono` id, or "Legacy chunks") and,
  when `activated_at` is set on that row, `group.since` with a `<time>`; under that, 12px muted, the sweep decision line
  (`decision.line` or `decision.none`, section 6.7) once the report has loaded.
- Right: `btn btn-outline btn-sm` "Roll back profile" (`bi-arrow-counterclockwise`), rendered only when `active[doc_type]` is not
  `legacy`. Its accessible name is `action.rollbackAria`.

**Gate-refusal alert.** When the last activate or rollback on this type answered 409, an `alert alert-warning` with
`bi-exclamation-triangle`, `role="alert"`, sits under the header with the sentence of section 12.3. It stays until the next action on
that type or the next Refresh profiles.

**Coverage warning.** When `missing_from_active[doc_type] > 0` (the active profile is then never `legacy`), an `alert alert-warning`
with `bi-exclamation-triangle` shows `coverage.warning` (the count, that those documents are answered from legacy chunks until the
profile is rebuilt, what to select) and a `btn btn-primary btn-sm` "Build missing documents". The button runs the build of section 6.5
on the active profile. When the value is `null`, show `coverage.unknown` as 12px muted text with no button. When it is `0`, show
nothing. Counts only: no document name, id or list is shown or requested.

**Only legacy.** A type whose only non-retired profile is `legacy` shows no table: one 14px muted line, `group.onlyLegacy`.

**Table** (`table table-sm` in `overflow-x-auto`, `<caption class="sr-only">` = `table.caption` with the type name, `th scope="col"`).
Rows in this order: the active profile, then `ready`, then `building`, then `legacy` when it is not active, then `retired`; within a
group by `created_at`, newest first.

| Column | Shown from | Content |
|--------|-----------|---------|
| Profile | always | The id in `font-mono text-sm break-all`. For `legacy`: "Legacy chunks" in the body font with `legacy` in 12px muted `font-mono` under it. A profile named by the sweep decision of this type gets a `badge badge-outline badge-sm` "Sweep decision" under the id |
| Sizes | 768px+ | `sizes.pair` with `Intl.NumberFormat(locale)` numbers; second line, 12px muted: `mode.structure` or `mode.fixed`; for a preset other than `custom` the second line starts with the preset name. For `legacy`: `legacy.sizes` and nothing else (finding 7). Below 768px the pair moves under the id as a 12px line |
| Status | always | Badge: Active `badge badge-success` with `bi-check-circle-fill`; Ready `badge badge-outline`; Building `badge badge-info badge-outline`; Retired `badge badge-ghost`. Status is never colour alone: the word is always there |
| Documents | always | `docs.built` from `completeness.documents_with_children` and `completeness.current_ready_documents`, right-aligned, `tabular-nums`; when `missing_documents > 0`, a second 12px line `docs.missing` in `text-warning`. `completeness: null`: `docs.notMeasured`, except for `legacy`, which shows an em dash with `sr-only` `docs.notApplicable` |
| Actions | always | Exactly one button, or none. Building: `btn btn-primary md:btn-sm` "Build profile" (first build) or "Continue build" (when `documents_with_children > 0` or this session ran a step). Ready with `missing_documents > 0`: `btn btn-primary md:btn-sm` "Build missing documents" (the gate would refuse activation as `incomplete`, and a ready profile is repaired in place by the same build route). Ready otherwise, including a non-active `legacy` and a ready profile whose completeness is not measured: `btn btn-primary md:btn-sm` "Activate profile". Active with missing documents: nothing here (the button is in the coverage warning). Active without missing documents, and Retired: an empty cell, never a disabled button. Header text is `sr-only` |

Accessible names add the id: `action.buildAria`, `action.activateAria`.

Activate is hidden only on what the list answer proves (missing documents). It is **not** pre-disabled from the committed sweep
decision (finding 3): the gate reads the database, and the 409 is the answer.

### 6.4 New profile form

"New profile" opens a `div[role=region][aria-labelledby].bg-base-100.rounded-lg.p-4.mb-4` between the toolbar and the first block. It
sets `aria-expanded` on the button and moves focus to the Document type select. Only one form exists. "Close form" (or Escape inside the
region) closes it, keeps nothing, and returns focus to "New profile".

```
New chunking profile
Document type   [Contract & legal ▾]
Sizes           (128/512) (256/1024, default) (256/2048) (Custom)
Child size (tokens)   [ 256 ]     Parent size (tokens)  [ 1024 ]
The small pieces that are searched.   The larger passage sent to the model around a matching child.
Parent boundaries     (•) Follow document structure, up to the parent size   ( ) Fixed size
Profile ID      [ p256-1024-contract_legal ]
Lower-case letters, digits, dots, hyphens and underscores, up to 64 characters. …
(findings: errors, then warnings)
[Create profile] [Close form]
```

Fields, in this order, in a `grid grid-cols-1 md:grid-cols-2 gap-4`; every field has a visible `<label for>`:

| Field | Control | Rules |
|-------|---------|-------|
| Document type | `select-sm`, six options with localized names | Default: `general` |
| Sizes | `fieldset` + `legend`, four radio buttons: `128/512`, `256/1024` (default, marked with the word "default" in its `aria-label` and visible text), `256/2048`, `Custom` | Sent as `preset` (`custom` for Custom) |
| Child size (tokens) | `input type="number" inputmode="numeric" min="1" step="1"` | With a preset: the preset's value, `readonly` (not `disabled`, so it stays readable and in the tab order) with `form.presetLocked` as its help line. With Custom: editable, starting from the values on screen |
| Parent size (tokens) | same | Same. Required in both parent modes (finding 10) |
| Parent boundaries | `fieldset` + `legend`, two `radio-sm`: structure, fixed | With a preset: structure, both radios `disabled` and the help line `form.presetLocked`. With Custom: editable |
| Profile ID | `input type="text" maxlength="64" autocomplete="off" spellcheck="false"`, `font-mono` | Pre-filled with `p{child}-{parent}-{doc_type}` and updated whenever type or sizes change, until the admin edits it by hand; clearing it restores the suggestion. Must match `^[a-z0-9][a-z0-9._-]{0,63}$` and must not be `legacy` |

**Validation, in two layers.**
1. **Local, on every `input` event, no debounce.** Field checks first: whole numbers of 1 or more, the ID pattern, not `legacy`. Then
   `validateChunking(input, context)` from `chunking-validate.js`. The panel passes an empty context, and a rule whose context value is
   missing is skipped, never guessed (finding 2). So the browser alone reports `parent_tokens_required`, `parent_below_twice_child` and
   `ratio_outside_4_8`. With the full context the function gives exactly the case table's answers, which is what the parity test
   checks.
2. **Server, `POST /validate`, 400 ms after the last change,** only while layer 1 shows no hard error. Its `errors` and `warnings`
   replace the local findings for the same draft. A response for an older draft is dropped (request counter). While it runs, a 12px
   muted `form.checking` line with a spinner shows under the findings. If it fails with 503 or a network error, show
   `form.serverUnchecked` in 12px muted text and keep the local findings; Create stays possible because the create route validates
   again.

**Findings area** (`div[aria-live=polite]` above the buttons): hard errors first, each a 14px `text-error` line with
`bi-exclamation-circle`; then warnings, each a 14px `text-warning` line with `bi-exclamation-triangle`. Each finding's element id is
listed in `aria-describedby` of the field it is about (`child_exceeds_embedding_input` on child size; the other four on parent size),
and a field with a hard error gets `aria-invalid="true"` and `input-error`. Field-format errors show as that field's help line in
`text-error`, replacing the normal help. Warnings never block.

**Buttons** (`flex gap-2 mt-4`): `btn btn-primary btn-sm` "Create profile", `btn btn-ghost btn-sm` "Close form". Create profile has the
`disabled` attribute while any hard error (field-format, local or server) is on screen or a request is running, and
`aria-describedby` points at the findings area so the reason is announced. On click: `POST /validate`; when `valid` is true,
`POST` create; otherwise show the returned errors. While running, the button shows a spinner and `form.creating`.

**After 201:** the form closes, the list reloads, the status region says `form.created`, and focus moves to the new profile's "Build
profile" button. Warnings returned with the 201 are appended to the status message. Create errors are in section 8.

### 6.5 Build (repeated 45-second steps)

One build runs at a time in the panel. Starting one inserts a `tr` under the profile's row with a single full-width `td` holding
`div[role=group][aria-label].bg-base-100.rounded-lg.p-4`:

```
▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░
40 of 123 documents built                                   [Pause build]
Each step runs for up to 45 seconds. Keep this page open; if you leave, the build pauses and Continue build picks it up.
Documents that could not be built so far: 2
```

- `<progress class="progress progress-primary w-full">` with `max = docsTotal`, `value = docsDone` and an `aria-label` of
  `build.barLabel`. Before the first answer it has no `value` (indeterminate) and the line reads `build.starting`. When `docsTotal` is 0
  the bar is removed.
- Count line (14px, `tabular-nums`): `build.progress`. Note line (12px muted): `build.note`. When `gaps > 0`, a 12px `text-warning`
  line: `build.gaps`.
- `btn btn-outline btn-sm` "Pause build". Pausing lets the running step finish (the server saves after every document), then stops
  asking; the button shows `build.pausing` and is disabled meanwhile.

**The loop.** `POST …/build` with `{ doc_type }`; while the answer has `more === true`, post again at once. It stops when `more` is
false, on Pause build, on any non-OK answer, or when a step takes longer than 70 seconds on the client (`AbortController`, treated as a
network failure). A gap does not stop it (finding 5). If three steps in a row answer `more: true` with the same `docsDone`, stop with
`build.stalled`. The count line updates in place after each step; the status region announces at most one progress message every 30
seconds, plus the final outcome.

While a build runs: every Build, Continue build, Build missing documents, Activate profile, Roll back profile and Create profile
button in the panel is disabled (with `aria-disabled` and a `title` of `build.busy`); Refresh profiles, the sub-tabs and the report stay
usable. The loop continues while another Config UI tab is shown and ends with the page. There is no `beforeunload` prompt, because
nothing is lost.

**Outcomes** (the progress row is replaced by one message line and the list reloads; focus moves to the status region):

| Answer | Shown |
|--------|-------|
| `status: completed`, profile was building | `build.completed`; the row now shows Ready and "Activate profile" |
| `status: completed`, profile was active | `build.repaired`; the coverage warning disappears on reload |
| `status: completed`, `docsTotal: 0` | `build.none` |
| `status: incomplete` | `alert alert-warning` under the row: `build.incomplete`, then one line per entry of `gap_reasons` (`gap.no_parse_output`, `gap.failed`, any other key `gap.other` with the key in `code`) |
| `status: failed` | `alert alert-error` under the row: `build.failed`; the row's button is "Continue build" |
| Paused by the admin | 14px line `build.paused`; the row's button is "Continue build" |
| HTTP errors | Section 8. Every message says that progress so far is saved |

The alerts under a row stay until the next action on that profile or the next Refresh profiles.

### 6.6 Activate and roll back (confirmation)

Both change, at once and for every workspace, which chunks answer questions about one document type. Neither deletes anything and each
undoes the other, so neither is styled as destructive. Both need a confirmation, in a native `<dialog class="modal">` built with DOM
APIs (the Ingestion panel's `confirmDelete` pattern, never `utils/modal.js`):

| | Activate | Roll back |
|---|----------|-----------|
| Title (16/600) | `confirm.activate.title` | `confirm.rollback.title` |
| Body (14px) | `confirm.activate.body` (profile, sizes, type, "every workspace", "starts at once", which profile is replaced, that it stays built, that Roll back profile returns to it). For `legacy`: `confirm.activate.bodyLegacy` | `confirm.rollback.body` (type, the profile it goes back to: the active row's `previous_active_id`, or legacy chunks when that is null; that the current profile stays built and can be activated again) |
| Cancel | `btn` "Keep current profile", default focus (`autofocus`) | `btn` "Keep current profile", default focus |
| Confirm | `btn btn-primary` "Activate profile" | `btn btn-primary` "Roll back profile" |

Escape and the backdrop cancel. After confirm, both dialog buttons are disabled and the confirm button shows a spinner with
`confirm.activating` or `confirm.rollingBack`; the dialog closes when the answer arrives. Focus then returns to the button that opened
the dialog, or to the status region when that button is gone.

| Answer | Shown |
|--------|-------|
| Activate 200, `changed: true` | List reloads; status region `activate.done` |
| Activate 200, `changed: false` | List reloads; status region `activate.already` |
| Rollback 200 | List reloads; status region `rollback.done` with `restored` and `rolled_back` |
| 409 with `reason` | List reloads; the gate-refusal alert of section 6.3 with the sentence for that reason (section 12.3); status region repeats it |
| 404 | List reloads; status region `error.profileGone` |
| 503, network | Status region `error.changeUnknown`; list reloads (the change may or may not have been applied, and the list shows which) |

### 6.7 Sweep report sub-view (`GET …/report`)

Answer used: `report.provenance.source`, `report.notes[]`, `report.profiles[] { profile_id, gate, metrics { overall, by_doc_type,
by_language, by_question_kind } }` and `decisions[] { doc_type, profile_id, gate_passed, source, recorded_at }`.

```
(alert-info, fixture only) This report comes from the built-in test fixture. …
Sweep decisions
Document type      Chosen profile              Check against legacy   From           Recorded
Contract & legal   p256-1024-contract_legal    Passed                 Live sweep     25 Nov 2026
General            No decision recorded
…
Compare on [Overall ▾]
Profile     Check vs legacy   Recall@k  MRR    False refusals          Correct refusals        Answer correctness  Context tokens  Latency p50 / p95
legacy      Baseline          0.677     0.576  20.8% ●━━━━             28.6% ●━━━━━━━          Skipped             696             104 / 143 ms
                                               95% upper bound 28.8%   95% upper bound 48.7%
                                               n = 96                  n = 21
p128-512    Failed            0.729     0.637  …
            ▸ Show what got worse (3)
Notes from the sweep
• Recall@k uses k=10. …
```

- **Fixture notice.** When `report.provenance.source` is `fixture`: `alert alert-info` with `bi-info-circle` and `report.fixture`, above
  everything else in the sub-view. A fixture report must never read as a measurement of the admin's documents.
- **Sweep decisions** (16/600 heading, then `table-sm`): one row per document type in the fixed order. With a decision: the chosen
  profile (`font-mono`, or "Legacy chunks"), `gate.passed` or `gate.failed` as a badge (`badge-success badge-outline` /
  `badge-warning`), `source.live` or `source.fixture`, and `recorded_at` in a `<time>`. Without one: `decision.none` spanning the rest
  of the row. Under the table, 12px muted: `help.decision`.
- **Slice** (`label` + `select-sm`, `report.compareOn`): `Overall` (default), then three `optgroup`s: Document type (the six types,
  localized), Question language (`zh`, `en`, `it` as language names), Question kind (the keys present in the report; known keys
  `fact_lookup`, `context_heavy`, `clause`, `other` are localized, an unknown key is shown as is). Changing it re-renders the table
  from memory; no request.
- **Comparison table** (`table-sm`, `caption.sr-only` = `report.caption` with the slice name, focusable scroll container): one row per
  entry of `report.profiles`, in the report's order.

| Column | Content |
|--------|---------|
| Profile | `profile_id` in `font-mono` ("Legacy chunks" for `legacy`). When a document-type slice is selected and a profile `<profile_id>-<doc_type>` exists in the list: a 12px muted line `report.registeredAs` with that id and its status word. When that id is the type's sweep decision: `badge badge-outline badge-sm` "Sweep decision" (highlight is the badge plus `bg-base-100` on the row) |
| Check against legacy | `gate === null`: `gate.baseline`. `passed`: `badge badge-success badge-outline` `gate.passed`. Not passed: `badge badge-warning` `gate.failed` and a `details` with summary `gate.showRegressions` (count) listing each regression as `gate.regression`: metric name, slice name, the difference and the allowed band, both to 3 decimals |
| Recall@k, MRR | 3 decimals, right-aligned |
| False refusals, Correct refusals | The rate cell of section 6.9 with `value`, `upper_95` and `n` |
| Answer correctness | `judge_skipped: true`: `report.judgeSkipped`. Otherwise the value as a percentage with `n` |
| Context tokens | Mean, rounded to a whole number, `Intl.NumberFormat` |
| Latency p50 / p95 | Whole milliseconds, `report.latency` |

  A metric whose `value` is `null` shows an em dash with `sr-only` `report.noData`. Column headers are text, not sort buttons: the
  report's own order is kept.
- **Notes** (12px, `ul.list-disc`, heading `report.notes`): each entry of `report.notes` as plain text with `lang="en"`. The notes are
  written by the sweep tool in English and are not translated; they carry the k of Recall@k, the validator warnings and the judge's
  skip reason.
- The sub-view never offers Activate. The admin compares here and switches under Profiles.

### 6.8 Refusal calibration panel (read-only)

```
┌ Refusal calibration ─────────────────────────────────────────────────────────────┐
│ Read-only. Shows which refusal thresholds the app can use and how they scored    │
│ when they were calibrated. Thresholds change only through the calibration tool   │
│ and a pull request. Applies to every workspace.                                  │
│ (alert host)                              Updated 14:02     [⟳ Refresh status]   │
│                                                                                  │
│ Pipeline            v2                 Threshold refusal   On                    │
│ Reranker            Cohere             Score type          Comparable across questions │
│ Reranker model by use and question language                                      │
│               Chinese            English            Italian                      │
│ Chat (quality) rerank-v5.0-pro   rerank-v5.0-pro    rerank-v5.0-pro              │
│ Voice (fast)   rerank-v5.0-fast  rerank-v5.0-fast   rerank-v5.0-fast             │
│ Current versions: tokenizer 2, rerank text 1. …                                  │
│                                                                                  │
│ Warnings                                                                         │
│ ⚠ Threshold refusal is on, but there is no calibrated live threshold for …       │
│ ⓘ All thresholds below come from the test fixture. …                             │
│                                                                                  │
│ Thresholds                                                                       │
│                                                        Dev set            Holdout set        │
│ Reranker model  Question  Document   Status     Thresh. False     Correct  False    Correct  Recorded │
│ cohere          English   Same as    Calibrated  0.150  0.0% ●━━━ 0.0%     No answerable items  25 Nov │
│ fake-quality-v1           question   Fixture, eval only  95% upper bound 77.6%, n = 2               │
│ …                                                                                │
│ ▸ What the statuses mean                                                         │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The panel has one button, "Refresh status" (`btn btn-outline btn-sm`, `bi-arrow-clockwise`), and one `details`. Its root contains no
`input`, `select`, `textarea` or `contenteditable` element, and the script makes no request other than the one `GET`.

**Summary** (`dl` in `grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2`, `dt` 12px muted, `dd` 14px):
- Pipeline: `legacy` shows `pipeline.legacy`, `v2` shows `v2`.
- Threshold refusal: `value.on` / `value.off`.
- Reranker: `reranker.none`, `Cohere`, `Voyage`, `reranker.local_bm25`.
- Score type: `scores.calibrated`, `scores.relative` or `scores.none` from `reranker.score_semantics`.
- Model matrix (`table-sm`, `caption` = `models.caption`): rows Chat and Voice with their tier (`use.chat`, `use.voice`), columns the
  three question languages, cells the model id in `font-mono`. Hidden when the reranker is `none`.
- Versions line (12px muted): `summary.versions`.
- Derived notes (14px, `text-base-content/70`, each at most once): `note.legacyPipeline` when `pipeline` is `legacy`; `note.refusalOff`
  when `refusal_threshold` is false; `note.pending` when the `#RAG_REFUSAL_THRESHOLD` checkbox on the RAG Modes tab differs from
  `refusal_threshold`; `note.pendingReranker` when `#RAG_RERANKER` differs from `reranker.provider`. These two inputs are the only
  page controls the script reads, and it never writes them.

**Warnings** (16/600 heading, then a `div.grid.gap-2`). One alert per entry of `warnings`, in the route's order, each with an icon and
the localized sentence of section 12.5:

| Code | Alert | Extra content |
|------|-------|---------------|
| `thresholds_invalid` | `alert-error`, `bi-x-octagon` | none |
| `refusal_on_without_calibrated_cell` | `alert-warning`, `bi-exclamation-triangle` | The languages are named in the sentence. Under it, a 12px list of `missing`: use (Chat or Voice), model id in `font-mono`, language |
| `stale_cells` | `alert-warning`, `bi-exclamation-triangle` | The count is `keys.length`; the cells themselves carry the Stale badge. The raw keys are not printed |
| `relative_reranker` | `alert-warning`, `bi-exclamation-triangle` | The provider's display name in the sentence |
| `fixture_cells_only` | `alert-info`, `bi-info-circle` | none |
| any other code | `alert-warning` | The route's own `message`, as text, with `lang="en"` |

No warnings: one 14px muted line, `warnings.none`. The status region announces `status.loaded` with the cell count and the warning
count.

**Thresholds** (16/600 heading, 12px muted `cells.explain` under it, then `table-sm` with `caption.sr-only` = `cells.caption` in a
focusable scroll container). The header has two rows: "Dev set" and "Holdout set" are `th scope="colgroup" colspan="2"`. One row per
cell, in the route's order.

| Column | Shown from | Content |
|--------|-----------|---------|
| Reranker model | always | Provider display name (14px) and the model id under it (`font-mono text-xs break-all`) |
| Question language | always | Language name for `query_language` |
| Document language | 768px+ | `pairing.same` or `pairing.cross` |
| Status | always | Badge by `status`: `calibrated` `badge-success badge-outline`; `uncalibrated` `badge-ghost`; `insufficient_data` `badge-ghost`; `failed_holdout` `badge-warning`. Then, as separate badges: `badge-info badge-outline` `badge.fixture` when `source` is `fixture`; `badge-warning badge-outline` `badge.stale` when `stale` is true. Under the badges, 12px muted, the one-line meaning (`status.hint.*`) |
| Threshold | always | 3 decimals, right-aligned; `null` shows `cells.noThreshold` |
| Dev set: False refusals | always | Rate cell (section 6.9) from `dev.false_refusal_point_estimate`, `dev.false_refusal_upper_bound_95`, `dev.answerable_count`. Count 0: `cell.noAnswerable`, no numbers, no mark |
| Dev set: Correct refusals | 1024px+ | `dev.correct_refusal_point_estimate` as a percentage with `n = dev.no_answer_count`, no bound (finding 11). Count 0: `cell.noNoAnswer` |
| Holdout set: False refusals | always | As dev, from `holdout` |
| Holdout set: Correct refusals | 1024px+ | As dev, from `holdout` |
| Recorded | 1024px+ | `recorded_at` in a `<time>`, `dateStyle: 'medium'` |

The header cells of the two false-refusal columns read `col.falseRefusal` with a second 12px line `col.falseRefusalSub`, which in
English is exactly "point estimate, 95% upper bound". Under the table, a `details` with summary `legend.summary` lists the four
statuses and the two extra badges with their meaning.

### 6.9 The rate cell (the one signature element)

Used for false refusals in the threshold cells, and for false and correct refusals in the sweep report. Structure:

```
20.8%  ●━━━━━━──────────────       line 1: point estimate, 14px, tabular-nums, then the mark
95% upper bound 28.8%              line 2: 12px muted
n = 96                             line 3: 12px muted
```

- Line 1 starts with an `sr-only` "point estimate" (`cell.point`), so a screen reader hears "point estimate 20.8%, 95% upper bound
  28.8%, n = 96". Percentages have one decimal (`Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1,
  maximumFractionDigits: 1 })`).
- The mark is `div[aria-hidden="true"].relative.w-24.h-1.rounded-full.bg-base-300`, shown from 768px (`hidden md:block`). Inside it: a
  range `absolute inset-y-0 left-0 rounded-full bg-base-content/30` whose width is the upper bound as a percentage of the track, and a
  dot `absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-base-content` centred on the point estimate and clamped so it stays
  inside the track. No tick, no target line, no colour that changes with the value.
- When the upper bound is `null` (a rate that has none), line 2 is omitted and the mark shows the dot only.
- When the count is 0 or the value is `null`, the cell shows its "no items" text and no mark.
- The numbers carry the information. The mark only makes the distance between the estimate and the bound visible.

Wording rule for both panels (F-19): the UI says "point estimate" and "95% upper bound". It never writes "at most", "≤", "meets the
target", "within target" or a target percentage next to a rate.

### 6.10 Pointer next to the refusal switch (RAG Modes tab)

Under the "Threshold refusal" checkbox (`#RAG_REFUSAL_THRESHOLD`, in the "Phase 4 retrieval switches" box of the Retrieval pipeline
card) add one `label-text-alt` line, `pointer.text`, and a `btn btn-link btn-xs` "Open refusal calibration" that selects the RAG
administration tab and scrolls `#rag-administration-refusal` into view (focus goes to its heading, which has `tabindex="-1"`). The
checkbox and its id do not change. The pointer makes no request, so the RAG Modes tab still works without an admin session.

---

## 7. State matrix

Every row is required. "Status region" is the panel's `div[role=status][aria-live=polite].text-sm`; an error in it gets `text-error`
and a leading `bi-exclamation-circle`. "Alert host" is the block under the panel description.

### 7.1 Chunking profiles

| Surface | State | What the admin sees |
|---------|-------|---------------------|
| Panel | First load | Sub-tabs enabled; Profiles shows a `loading-sm` spinner with `list.loading`; status region `list.loading` |
| Panel | Refresh with content present | Content stays, gets `opacity-60` and `aria-busy="true"`; Refresh profiles shows a spinner and is disabled; no layout jump |
| Panel | 401 or 403 | Sub-tabs and content are replaced by one `alert alert-warning` with `bi-person-lock`, the shared sign-in message with the main app's address, and `btn btn-sm` "Reload panel". No password field, no token prompt |
| Panel | List 503 | `alert alert-error` in the alert host with `error.listUnavailable` and "Reload panel"; content from an earlier successful load stays visible, dimmed |
| Panel | Network failure | As 503 with the shared network message |
| Profiles | Populated | Six blocks in the fixed order (section 6.3) |
| Profiles | Empty: `profiles` is an empty array | Centred block (`py-8`): 16/600 `list.empty.title`, 14px `list.empty.body`, "Reload panel" |
| Profiles | A type with only legacy | The one-line `group.onlyLegacy`, no table |
| Profiles | A type with one, or many, profiles | The same table; with 12 or more rows it does not page or scroll on its own (the panel scrolls) |
| Profiles | `missing_from_active` above 0 / `null` / 0 | Coverage warning with count and Build missing documents / `coverage.unknown` / nothing |
| Profiles | Report failed to load | Blocks render without decision lines; one 12px muted `decision.unavailable` under the toolbar |
| Form | Open, untouched | Type General, preset 256/1024, structure, suggested ID; the server check runs and usually shows the `top_k_parent_over_budget` warning (F-11: expected, it does not block) |
| Form | Hard error (field-format, local or server) | Error lines; field `aria-invalid`; Create profile disabled |
| Form | Warnings only | Warning lines; Create profile enabled |
| Form | Server check running / failed | `form.checking` with a spinner / `form.serverUnchecked`, local findings kept |
| Form | Create running | Button spinner with `form.creating`; all fields `disabled`; Close form disabled |
| Form | Created | Form closes, list reloads, `form.created`, focus on the new Build profile button |
| Form | 409 `profile_exists` | Form stays; Profile ID gets `aria-invalid` and `error.profileExists` as its help line; focus moves to it |
| Form | 400 from create | Section 8; the form keeps its values |
| Form | 503 or network on create | `error.createUnavailable` in the findings area; values kept; Create profile enabled again |
| Build | Starting | Progress row, indeterminate bar, `build.starting` |
| Build | Running | Bar and `build.progress` update after each step; `build.note`; gaps line when above 0; other action buttons disabled |
| Build | Pausing / paused | `build.pausing` on the disabled Pause build button / `build.paused`, row button Continue build |
| Build | Completed / repaired / nothing to build | `build.completed` / `build.repaired` / `build.none`; list reloads |
| Build | Incomplete (gaps) | `alert-warning` with `build.incomplete` and one line per reason |
| Build | Failed run (200, `status: failed`) | `alert-error` with `build.failed` |
| Build | Stalled | `alert-warning` with `build.stalled` |
| Build | 404 / 409 / 503 / 401 or 403 / network during the loop | Loop stops; section 8; every message ends with the saved-progress sentence |
| Activate, roll back | Dialog open | Section 6.6, focus on Keep current profile |
| Activate, roll back | Running | Dialog buttons disabled, spinner on the confirm button |
| Activate, roll back | Done / already active | `activate.done`, `rollback.done` / `activate.already`; list reloads |
| Activate, roll back | 409 gate refusal | Dialog closes; gate-refusal alert in the type's block with the reason sentence; list reloads |
| Activate, roll back | 404 / 503 / network | `error.profileGone` / `error.changeUnknown`; list reloads |
| Report | Loading | Spinner with `report.loading` |
| Report | Populated | Fixture notice when it applies, decisions table, slice select, comparison table, notes |
| Report | Empty: `report.profiles` is empty | Centred block: 16/600 `report.empty.title`, 14px `report.empty.body` with the command in `code` |
| Report | No decisions | Decisions table shows `decision.none` for all six types |
| Report | Baseline only (one profile, `legacy`) | The one row and, under the table, 14px muted `report.baselineOnly` |
| Report | 500 `chunking_report_invalid` or `chunking_decisions_invalid` | `alert alert-error` with `report.unreadable` and "Reload panel"; the Profiles sub-view is unaffected |
| Report | 500 `chunking_report_unavailable`, 503, network | `alert alert-error` with `report.unavailable` and "Reload panel" |
| Report | Metric `value: null` / judge skipped | Em dash with `sr-only` `report.noData` / `report.judgeSkipped` |

### 7.2 Refusal calibration

| State | What the admin sees |
|-------|---------------------|
| First load | Spinner with `status.loading`; status region the same |
| Refresh with content present | Content dimmed with `aria-busy`, Refresh status disabled with a spinner |
| Populated | Summary, warnings (or `warnings.none`), thresholds table, legend |
| No cells (`cells` empty) | Summary and warnings as usual; in place of the table a centred block: 16/600 `cells.empty.title`, 14px `cells.empty.body` with the command in `code` |
| Fixture cells only | The `fixture_cells_only` alert and a "Fixture, eval only" badge on every row |
| Stale cells | The `stale_cells` alert and a "Stale" badge on each stale row |
| Threshold refusal off / legacy pipeline | `note.refusalOff` / `note.legacyPipeline` in the summary |
| Saved-but-not-restarted settings | `note.pending`, `note.pendingReranker` |
| Reranker none | Model matrix hidden; `scores.none` |
| Split with 0 items | `cell.noAnswerable` / `cell.noNoAnswer`, no numbers, no mark |
| 401 or 403 | Content replaced by the sign-in alert with "Reload panel" |
| 503 | `alert alert-error` with `error.unavailable` and "Reload panel"; earlier content stays, dimmed |
| 500 `refusal_status_unavailable` | `alert alert-error` with `error.statusUnreadable` and "Reload panel" |
| Network failure | `alert alert-error` with the shared network message and "Reload panel" |

**Snapshots.** Both panels show a snapshot; "Updated {time}" says when it was taken. Nothing polls, except the build loop. Every 404
and 409 reloads the list, because those answers mean the registry changed since the snapshot (another admin, the CLI).

---

## 8. Error and code mapping (exact)

Both scripts wrap `ragFetch` in `try/catch`. `error.signIn`, `error.network` and `error.generic` are read from the shared table through
`window.ingestLabel(key, locale, vars)` (`status-monitor.js`; in vitest through `require`), with `{appUrl}` filled from
`window.getConfiguredMyRAGAppUrl()` when that function exists and from `window.location.origin` otherwise. The placeholder must never
reach the screen. When `ingestLabel` is missing, fall back to `authMessage(status)` from `rag-fetch.js`. All other keys are in the
panel's own table (section 12).

| Status | `body.error` (and `reason`) | Route | Key and behaviour |
|--------|-----------------------------|-------|-------------------|
| thrown, or client timeout | n/a | any | Shared `error.network`; in a build `build.network`; on activate or rollback `error.changeUnknown` |
| 401 | `Admin authentication required` | any | Shared `error.signIn`; panel content replaced by the sign-in alert |
| 403 | any | any | Same as 401 (these routes have no workspace check) |
| 503 | `Admin verification is unavailable`, `chunking_admin_unavailable` | list | `error.listUnavailable` |
| 503 | same | validate | `form.serverUnchecked` |
| 503 | same | create | `error.createUnavailable` |
| 503 | same | build | `build.unavailable` |
| 503 | same | activate, rollback | `error.changeUnknown`, then reload the list |
| 503 | `Admin verification is unavailable` | report | `report.unavailable` |
| 503 | `Admin verification is unavailable` | refusal | `error.unavailable` |
| 500 | `chunking_report_invalid`, `chunking_decisions_invalid` | report | `report.unreadable` |
| 500 | `chunking_report_unavailable` | report | `report.unavailable` |
| 500 | `refusal_status_unavailable` | refusal | `error.statusUnreadable` |
| 404 | `profile_not_found` | build, activate | `error.profileGone`, then reload the list |
| 409 | `profile_exists` | create | `error.profileExists` on the Profile ID field |
| 409 | `activation_refused` + `incomplete`, `open_gaps`, `no_evidence`, `eval_failed`, `stale_evidence`, `not_ready`, `ambiguous_profile` | activate | `gate.<reason>` in the gate-refusal alert, then reload the list |
| 409 | `rollback_refused` + `no_previous` | rollback | `gate.no_previous`, then reload the list |
| 409 | `activation_refused` or `rollback_refused` + any other reason | activate, rollback | `gate.other` with the reason in `code.font-mono` |
| 409 | `build_refused` + `profile_retired` | build | `build.refused.profile_retired`, then reload the list |
| 409 | `build_refused` + any other reason | build | `build.refused.other` with the reason in `code.font-mono`, then reload the list |
| 499 | `build_aborted` | build | Treated as a pause: `build.paused` |
| 400 | `invalid_chunking_profile`, `details[].message` is a finding code | create, validate | The finding sentences of section 12.2 (`finding.*`), as hard errors |
| 400 | `invalid_chunking_profile`, `details[0].message` is `rejected_by_database` | create | `error.rejected` |
| 400 | `Invalid request data`, `details[0].path` is `id`, `child_tokens`, `parent_tokens`, `parent_mode`, `preset` or `doc_type` | create, validate | `error.invalidField` with the field's visible label, shown at that field |
| 400 | other | any | `error.invalid` |
| other | any | any | Shared `error.generic` with the status code |

A reason or code the table does not name is always shown inside `code.font-mono` within a full sentence that says what to do. A raw
code never stands alone.

---

## 9. Keyboard, screen reader and focus

1. **Headings.** Panel title `h3`; document-type names, the form title, "Sweep decisions", "Warnings" and "Thresholds" are `h4`. The
   heading order has no gaps and no heading is skipped for size.
2. **Sub-tabs.** `role=tablist` with `aria-label` `panel.tabsLabel`; each `button[role=tab]` has `aria-selected`, `aria-controls` and a
   roving `tabindex`. Left and Right move and activate, Home and End jump. Panels are `div[role=tabpanel][aria-labelledby][tabindex=0]`.
3. **Form.** Every control has a visible `<label for>`; the two radio groups are `fieldset` with `legend`. Help lines and findings are
   wired with `aria-describedby`; invalid fields carry `aria-invalid="true"`. Number fields use `inputmode="numeric"`. The Profile ID
   field has `autocomplete="off"` and `spellcheck="false"`. Enter in a text or number field does not submit: it only moves the check
   forward, and the admin activates Create profile explicitly. Escape closes the form and returns focus to New profile.
4. **Disabled Create profile.** The reason is always on screen in the findings area and referenced by the button's
   `aria-describedby`. Read-only preset fields stay focusable.
5. **Dialogs.** Native `<dialog class="modal">` opened with `showModal()`, `aria-labelledby` the title, `aria-describedby` the body.
   Focus starts on Keep current profile. Escape and the backdrop cancel; the browser traps Tab. On close, focus returns to the opening
   button, or to the status region when that button no longer exists. Profile ids and type names are inserted with `textContent`.
6. **Build.** The `<progress>` has an `aria-label` (`build.barLabel` with the profile id) and real `value` and `max`. The count line is
   visible text, not only a bar. The status region announces at most one progress message every 30 seconds and always the outcome.
   Buttons disabled during a build keep their label and get a `title` that says why.
7. **Live regions.** One polite status region per panel. Announce: load finished with counts, action outcomes, errors. A gate refusal
   and a failed build are also `role="alert"` blocks, because they answer an action the admin just took. Warnings rendered on load
   (coverage, calibration warnings, the fixture notice) have no alert role; their number is announced through the status region.
8. **Tables.** `caption` (visually hidden), `th scope="col"`, and `th scope="colgroup"` for "Dev set" and "Holdout set". The profile
   id or model cell of each row is `th scope="row"`. A table that can scroll sideways sits in
   `div.overflow-x-auto[tabindex=0][role=region][aria-label]`.
9. **Names.** Row actions include the profile id (`action.buildAria`, `action.activateAria`); Roll back profile includes the type
   (`action.rollbackAria`). Icon-and-text buttons keep their text; no icon-only button exists in these panels. Dates use
   `<time datetime>`.
10. **Not colour alone.** Every status, gate result and warning has a word and an icon. The rate mark is `aria-hidden` and its numbers
    are text.
11. **Focus visibility.** DaisyUI's `focus-visible` outline on every control; `summary` elements and scroll regions add
    `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2`. Never `outline: none` without a replacement.
12. **Motion.** Only DaisyUI's spinner and the browser's own progress bar. Under `prefers-reduced-motion: reduce`, spinners are hidden
    (`motion-reduce:hidden`) and their text remains. Nothing slides, fades or pulses; `.btn.loading`'s pulse animation is not used.
13. **Zoom and text size.** At 200% zoom nothing clips: no fixed heights except the 4px mark and the 8px progress bar; cells wrap;
    toolbars and button rows wrap.
14. **Language.** `lang` on each panel root; `lang="en"` on text left in English (section 5).

---

## 10. Responsive behaviour

| Width | Behaviour |
|-------|-----------|
| 1024px and up | All columns; form in two columns; summary `dl` in two columns |
| 768 to 1023px | Thresholds table hides Correct refusals (both sets) and Recorded; the comparison table scrolls sideways inside its focusable region; form in two columns |
| below 768px | Profiles table: Profile, Status, Documents, Actions (sizes move under the id); row actions are 48px `btn`; block header stacks (Roll back profile under the active line); form in one column; preset radios wrap; rate marks hidden, numbers kept; thresholds table also hides Document language (it moves under the question language as a 12px line) |
| 360px | Tested width: no sideways page scroll outside the table regions; ids and model ids break (`break-all`); dialogs fit (`modal-box` default width) |

The panels use the existing Config UI breakpoints (Tailwind `md` 768px, `lg` 1024px). The sidebar and drawer belong to the page and
do not change.

---

## 11. What must never be shown (admin allow-list)

These screens are admin-only and show **counts, sizes, ids of profiles and models, rates and dates**. Nothing about a single document.

1. The panels render only the fields named in sections 6.3 to 6.9, through builder functions, never by iterating an object's keys. A
   field the server adds later stays invisible until it is added here on purpose.
2. **No document id, document name, file name, chunk text, parse text, question text or tenant key appears anywhere,** and the panels
   call no route that returns one. The coverage warning and the build show counts only. There is no "show the documents" link.
3. Never rendered, even though a response contains them: `run_id` (build), `activated_by` (a user id; the date is shown instead),
   `previous_active_id` except as the named target in the roll-back dialog, `decided_by`, `report_hash`, `build_run_id`, `chosen_on`,
   `config_hash` (report and refusal), the raw `keys` of `stale_cells`, a cell's `key`, `tokenizer_version` and `rerank_text_version`
   per cell (only the current versions line is shown), `holdout_evaluations`.
4. For `legacy` rows: never `child_tokens`, `parent_mode`, `parent_tokens` or `preset` (finding 7).
5. No configuration value whose name matches `/(KEY|SECRET|TOKEN|PASSWORD)/i` is read or rendered. `refusal-calibration.js` reads
   exactly two page inputs, `#RAG_REFUSAL_THRESHOLD` and `#RAG_RERANKER`; `chunking-profiles.js` reads none.
6. Every server string (ids, model ids, reasons, codes, report notes, unknown warning messages, `details[].message`) is inserted with
   `textContent`. The test stubs a profile id, a model id, a report note and a warning message containing
   `<img src=x onerror=alert(1)>` and asserts that no element is created from them (T-04-78).
7. No `Authorization` header, no token in browser storage, no second sign-in form (T-04-77).
8. The refusal panel offers no way to change a threshold, a status or a setting.

---

## 12. Copywriting Contract

Voice: plain verbs, sentence case, names from the admin's side of the screen. A message that reports a problem says what happened and
what to do next. One action keeps one name through its whole flow: the row button, the dialog's confirm button and the outcome message
say "Activate profile", "Activate profile", "is now active". "Reload panel" always means reloading a view and is never used for
anything else.

**Words used, and words avoided.** "Legacy chunks" for the `legacy` profile (the CLI, the logs and the report use that id). "Check
against legacy" for the sweep gate; the word "gate" is not shown. "Sweep decision" for a recorded decision. "Build" for re-chunking;
"rechunk" appears only inside the log tag `[RAG Rechunk]`. "Question language" and "document language" for a cell's `query_language`
and pairing. "Point estimate" and "95% upper bound" for every refusal rate, in exactly those words in English (section 6.9).

**Action labels are verb + noun in every locale:** "New profile", "Create profile", "Close form", "Build profile", "Continue build",
"Build missing documents", "Pause build", "Activate profile", "Roll back profile", "Keep current profile", "Refresh profiles",
"Refresh status", "Reload panel", "Open refusal calibration". Accessible names extend the visible label and start with the same verb.
In-flight text ("Creating…", "Activating…") is status on a disabled button, not a label. Not actions, so not verb + noun: sub-tab
names, radio and select options.

**Counts are written as "label: number"** ("Documents missing from the active profile …: 3"), so no string needs a plural form in any
of the three languages.

**Where the strings live.** `CHUNKING_LABELS` in `chunking-profiles.js` (sections 12.2 to 12.4) and `REFUSAL_LABELS` in
`refusal-calibration.js` (section 12.5), each `{ en, zh, it }`, read through one function per file that fills `{placeholders}` and
falls back to English. The plan's helpers (`coverageWarning`, `refusalMessage`, `reportRows`, `cellRows`, the warning sentences) take
their sentences from these tables. The sign-in, network and generic-failure sentences are **not** copied: they come from the shared
`ingestLabel` table (section 8). Document-type names come from `docTypeLabelForLocale`. A placeholder shown as `{command}` is replaced
by a `code` element, not by text.

Numbers use `Intl.NumberFormat(locale)`; dates `Intl.DateTimeFormat(locale, { dateStyle: 'medium' })`; times of day
`{ timeStyle: 'short' }`.

### 12.1 Summary table

| Element | Copy (en) |
|---------|-----------|
| Primary CTA | "Create profile" in the form; per profile row the one next step: "Build profile", "Continue build", "Build missing documents" or "Activate profile" |
| Secondary CTAs | "New profile", "Roll back profile", "Pause build", "Refresh profiles", "Refresh status", "Close form", "Reload panel", "Open refusal calibration" |
| Empty state heading | Profiles: "No chunking profiles found". Report: "No sweep report yet". Thresholds: "No thresholds yet" |
| Empty state body | Profiles: "The profile table is empty, which means the Phase 4 database migrations have not been applied. Apply the files under supabase/migrations (0406 and later), then select Reload panel." Report: "Run `python -m rag_eval.sweep chunking` to compare the profiles with legacy chunks, commit the report and redeploy. The comparison then appears here." Thresholds: "No calibration result is in this deployment, so threshold refusal applies nowhere and the similarity floor decides. Run `python -m rag_eval.calibrate refusal`, commit the result and redeploy." |
| Error state | "Chunking profiles are unavailable right now. Select Reload panel in a moment." with a "Reload panel" button; per-code copy in 12.2 to 12.5 |
| Gate refusal (409) | For example: "Not activated. No sweep decision is recorded in the database for {id}. Run the chunking sweep, record its decision with `npm run rag:chunking -- record-decision <decision.json>`, then activate again." All reasons in 12.3 |
| Destructive confirmation | None of the actions deletes data. Consequential, reversible actions with a confirmation: **Activate profile:** "Activate {id} for {type}?" / "Questions about {type} documents will be answered from this profile ({sizes}) in every workspace, starting at once. The current profile, {current}, stays built, and Roll back profile returns to it." / buttons "Keep current profile" (default focus) and "Activate profile". **Roll back profile:** "Roll back {type} to the previous profile?" / "{type} documents go back to {previous} in every workspace, starting at once. {current} stays built and can be activated again." / buttons "Keep current profile" (default focus) and "Roll back profile" |

### 12.2 Chunking profiles: panel, list and form

| Key | en | zh | it |
|-----|----|----|----|
| `panel.title` | Chunking profiles | 分块配置 | Profili di chunking |
| `panel.description` | Chunk sizes per document type. Build a new profile next to the current one, compare it in the sweep report, then activate it. Applies to every workspace in this deployment. | 按文档类型设置分块大小。先在当前配置旁边构建新配置，在对比报告中比较，再激活。对本部署的所有工作区生效。 | Dimensioni dei chunk per tipo di documento. Costruisci un nuovo profilo accanto a quello attuale, confrontalo nel report, poi attivalo. Vale per tutti gli spazi di lavoro di questa installazione. |
| `panel.tabsLabel` | Chunking profile views | 分块配置视图 | Viste dei profili di chunking |
| `tab.profiles` | Profiles | 配置 | Profili |
| `tab.report` | Sweep report | 对比报告 | Report di confronto |
| `action.new` | New profile | 新建配置 | Nuovo profilo |
| `action.refresh` | Refresh profiles | 刷新配置 | Aggiorna profili |
| `action.create` | Create profile | 创建配置 | Crea profilo |
| `action.closeForm` | Close form | 关闭表单 | Chiudi modulo |
| `action.build` | Build profile | 构建配置 | Costruisci profilo |
| `action.buildAria` | Build profile {id} | 构建配置 {id} | Costruisci il profilo {id} |
| `action.continue` | Continue build | 继续构建 | Continua costruzione |
| `action.buildMissing` | Build missing documents | 构建缺失文档 | Costruisci documenti mancanti |
| `action.pause` | Pause build | 暂停构建 | Sospendi costruzione |
| `action.activate` | Activate profile | 激活配置 | Attiva profilo |
| `action.activateAria` | Activate profile {id} for {type} | 为{type}激活配置 {id} | Attiva il profilo {id} per {type} |
| `action.rollback` | Roll back profile | 回滚配置 | Ripristina profilo |
| `action.rollbackAria` | Roll back {type} to the previous profile | 将{type}回滚到上一个配置 | Ripristina il profilo precedente per {type} |
| `action.keep` | Keep current profile | 保留当前配置 | Mantieni profilo attuale |
| `action.reload` | Reload panel | 重新加载面板 | Ricarica pannello |
| `list.loading` | Loading chunking profiles… | 正在加载分块配置… | Caricamento dei profili di chunking… |
| `list.loaded` | Profiles loaded: {count}. | 已加载配置：{count} 个。 | Profili caricati: {count}. |
| `list.updatedAt` | Updated {time} | 更新于 {time} | Aggiornato alle {time} |
| `list.empty.title` | No chunking profiles found | 未找到分块配置 | Nessun profilo di chunking trovato |
| `list.empty.body` | The profile table is empty, which means the Phase 4 database migrations have not been applied. Apply the files under supabase/migrations (0406 and later), then select Reload panel. | 配置表为空，说明尚未应用第 4 阶段的数据库迁移。请应用 supabase/migrations 下的文件（0406 及之后），然后点击“重新加载面板”。 | La tabella dei profili è vuota: le migrazioni del database della fase 4 non sono state applicate. Applica i file in supabase/migrations (0406 e successivi), poi seleziona «Ricarica pannello». |
| `group.active` | Active: {profile} | 当前使用：{profile} | Attivo: {profile} |
| `group.since` | since {date} | 自 {date} 起 | dal {date} |
| `group.onlyLegacy` | Legacy chunks are active. No other profiles for this document type yet. | 当前使用原有分块。此文档类型还没有其他配置。 | Sono attivi i chunk originali. Nessun altro profilo per questo tipo di documento. |
| `table.caption` | Chunking profiles for {type} | {type}的分块配置 | Profili di chunking per {type} |
| `col.profile` | Profile | 配置 | Profilo |
| `col.sizes` | Sizes | 大小 | Dimensioni |
| `col.status` | Status | 状态 | Stato |
| `col.documents` | Documents built | 已构建文档 | Documenti costruiti |
| `col.actions` | Actions | 操作 | Azioni |
| `legacy.name` | Legacy chunks | 原有分块 | Chunk originali |
| `legacy.sizes` | As first ingested | 按最初入库时的方式 | Come al primo caricamento |
| `sizes.pair` | {child} / {parent} tokens | {child} / {parent} 个 token | {child} / {parent} token |
| `mode.structure` | Parents follow the document structure | 父块按文档结构划分 | I chunk padre seguono la struttura del documento |
| `mode.fixed` | Fixed-size parents | 父块大小固定 | Chunk padre a dimensione fissa |
| `preset.label` | Preset {name} | 预设 {name} | Preset {name} |
| `preset.custom` | Custom | 自定义 | Personalizzato |
| `preset.default` | default | 默认 | predefinito |
| `status.building` | Building | 构建中 | In costruzione |
| `status.ready` | Ready | 就绪 | Pronto |
| `status.active` | Active | 使用中 | Attivo |
| `status.retired` | Retired | 已停用 | Ritirato |
| `docs.built` | {built} of {total} | {built} / {total} | {built} di {total} |
| `docs.missing` | Missing: {missing} | 缺失：{missing} | Mancanti: {missing} |
| `docs.notMeasured` | Not measured | 未统计 | Non misurato |
| `docs.notApplicable` | Not applicable | 不适用 | Non applicabile |
| `badge.decision` | Sweep decision | 评估选定 | Scelta del confronto |
| `coverage.warning` | Documents missing from the active profile {id}: {count}. Until the profile is rebuilt, questions about them are answered from legacy chunks. Select Build missing documents to add them. | 当前使用的配置 {id} 缺少文档：{count} 个。在重新构建该配置之前，关于这些文档的问题仍由原有分块回答。点击“构建缺失文档”补齐。 | Documenti mancanti dal profilo attivo {id}: {count}. Finché il profilo non viene ricostruito, le domande su questi documenti ricevono risposta dai chunk originali. Seleziona «Costruisci documenti mancanti» per aggiungerli. |
| `coverage.unknown` | The documents missing from the active profile {id} could not be counted. Select Refresh profiles. | 无法统计当前配置 {id} 缺少的文档数量。请点击“刷新配置”。 | Non è stato possibile contare i documenti mancanti dal profilo attivo {id}. Seleziona «Aggiorna profili». |
| `help.decision` | Activation needs a passing sweep decision recorded in the database. The decision shown here is the one in this deployment's files, and the two can differ. After a sweep, record the decision with {command}. | 激活需要数据库中记录有通过的评估决定。这里显示的是本部署文件中的决定，两者可能不同。评估完成后，用 {command} 记录决定。 | L'attivazione richiede una decisione di confronto superata e registrata nel database. Quella mostrata qui è nei file di questa installazione e può essere diversa. Dopo un confronto, registra la decisione con {command}. |
| `decision.line` | Sweep decision: {profile}, {gate}, {source}, {date} | 评估决定：{profile}，{gate}，{source}，{date} | Decisione del confronto: {profile}, {gate}, {source}, {date} |
| `decision.none` | No decision recorded | 没有记录决定 | Nessuna decisione registrata |
| `decision.unavailable` | Sweep decisions are unavailable right now. Open Sweep report for details. | 暂时无法读取评估决定。详情见“对比报告”。 | Le decisioni del confronto non sono disponibili al momento. Apri «Report di confronto» per i dettagli. |
| `form.title` | New chunking profile | 新建分块配置 | Nuovo profilo di chunking |
| `form.docType` | Document type | 文档类型 | Tipo di documento |
| `form.preset` | Sizes | 大小 | Dimensioni |
| `form.child` | Child size (tokens) | 子块大小（token） | Dimensione del chunk figlio (token) |
| `form.childHelp` | The small pieces that are searched. | 用于检索的小块。 | I pezzi piccoli in cui si cerca. |
| `form.parent` | Parent size (tokens) | 父块大小（token） | Dimensione del chunk padre (token) |
| `form.parentHelp` | The larger passage sent to the model around a matching child. | 命中子块后发送给模型的较大段落。 | Il passaggio più ampio inviato al modello attorno a un chunk figlio trovato. |
| `form.mode` | Parent boundaries | 父块边界 | Confini dei chunk padre |
| `form.mode.structure` | Follow the document structure, up to the parent size | 按文档结构划分，不超过父块大小 | Segui la struttura del documento, fino alla dimensione del padre |
| `form.mode.fixed` | Fixed size | 固定大小 | Dimensione fissa |
| `form.id` | Profile ID | 配置 ID | ID profilo |
| `form.idHelp` | Lower-case letters, digits, dots, hyphens and underscores, up to 64 characters. The suggested ID matches the sweep report, so a recorded decision finds this profile. | 小写字母、数字、点、连字符和下划线，最多 64 个字符。建议的 ID 与对比报告一致，这样记录的决定才能对应到此配置。 | Lettere minuscole, cifre, punti, trattini e trattini bassi, fino a 64 caratteri. L'ID suggerito corrisponde al report di confronto, così una decisione registrata trova questo profilo. |
| `form.presetLocked` | Set by the preset. Choose Custom to change it. | 由预设决定。选择“自定义”可修改。 | Impostato dal preset. Scegli «Personalizzato» per modificarlo. |
| `form.number` | Enter a whole number of 1 or more. | 请输入不小于 1 的整数。 | Inserisci un numero intero pari o superiore a 1. |
| `form.idInvalid` | Use lower-case letters, digits, dots, hyphens and underscores, starting with a letter or a digit. | 请使用小写字母、数字、点、连字符和下划线，并以字母或数字开头。 | Usa lettere minuscole, cifre, punti, trattini e trattini bassi, iniziando con una lettera o una cifra. |
| `form.idReserved` | The ID "legacy" is reserved. Enter another ID. | ID“legacy”已被保留，请换一个。 | L'ID «legacy» è riservato. Inseriscine un altro. |
| `form.checking` | Checking with the server… | 正在向服务器核对… | Verifica con il server… |
| `form.serverUnchecked` | These values could not be checked with the server. You can still create the profile; the server checks them again. | 无法向服务器核对这些值。仍可创建配置，服务器会再次检查。 | Non è stato possibile verificare questi valori con il server. Puoi comunque creare il profilo: il server li controlla di nuovo. |
| `form.creating` | Creating… | 正在创建… | Creazione… |
| `form.created` | Profile {id} created for {type}. Select Build profile to fill it with documents. | 已为{type}创建配置 {id}。点击“构建配置”为其写入文档。 | Profilo {id} creato per {type}. Seleziona «Costruisci profilo» per riempirlo di documenti. |
| `finding.child_exceeds_embedding_input` | The child size is larger than the embedding model accepts. Enter a smaller child size. | 子块大小超过了 Embedding 模型可接受的上限。请填写更小的子块大小。 | La dimensione del chunk figlio supera il limite del modello di embedding. Inserisci un valore più piccolo. |
| `finding.parent_below_twice_child` | The parent size must be at least twice the child size: {min} or more. | 父块大小至少应为子块的两倍：不小于 {min}。 | La dimensione del padre deve essere almeno il doppio del figlio: {min} o più. |
| `finding.parent_tokens_required` | Enter a parent size. | 请填写父块大小。 | Inserisci la dimensione del padre. |
| `finding.ratio_outside_4_8` | The parent is {ratio} times the child. The tested range is 4 to 8 times. You can still create the profile. | 父块是子块的 {ratio} 倍。经过验证的范围是 4 到 8 倍。仍可创建配置。 | Il padre è {ratio} volte il figlio. L'intervallo provato va da 4 a 8 volte. Puoi comunque creare il profilo. |
| `finding.top_k_parent_over_budget` | With this parent size, the retrieved parents can be larger than the context token budget, so the context is cut to fit. You can still create the profile; the sweep report shows the context tokens it measured. | 按此父块大小，检索到的父块可能超出上下文 token 预算，上下文会被截断以适应预算。仍可创建配置；对比报告会显示实测的上下文 token 数。 | Con questa dimensione, i chunk padre recuperati possono superare il budget di token del contesto, che viene tagliato per rientrarvi. Puoi comunque creare il profilo: il report di confronto mostra i token di contesto misurati. |
| `finding.invalid_shape` | Some values are missing or are not whole numbers. Check each field. | 有些值缺失或不是整数。请检查每个字段。 | Alcuni valori mancano o non sono numeri interi. Controlla ogni campo. |
| `error.listUnavailable` | Chunking profiles are unavailable right now. Select Reload panel in a moment. | 暂时无法读取分块配置。请稍后点击“重新加载面板”。 | I profili di chunking non sono disponibili al momento. Seleziona «Ricarica pannello» tra poco. |
| `error.createUnavailable` | The profile was not created because the service is unavailable. Your values are still in the form. Select Create profile again in a moment. | 服务暂时不可用，配置未创建。表单中的值已保留。请稍后再次点击“创建配置”。 | Il profilo non è stato creato perché il servizio non è disponibile. I valori sono ancora nel modulo. Seleziona di nuovo «Crea profilo» tra poco. |
| `error.profileExists` | A profile with this ID already exists for this document type. Change the profile ID. | 此文档类型已有相同 ID 的配置。请修改配置 ID。 | Esiste già un profilo con questo ID per questo tipo di documento. Cambia l'ID del profilo. |
| `error.rejected` | The database did not accept these values. Check the sizes and the profile ID, then select Create profile again. | 数据库未接受这些值。请检查大小和配置 ID，然后再次点击“创建配置”。 | Il database non ha accettato questi valori. Controlla le dimensioni e l'ID del profilo, poi seleziona di nuovo «Crea profilo». |
| `error.invalidField` | Check {field}: the server did not accept its value. | 请检查“{field}”：服务器未接受该值。 | Controlla {field}: il server non ha accettato il valore. |
| `error.invalid` | The request was not accepted. Select Reload panel, then try again. | 请求未被接受。请点击“重新加载面板”后重试。 | La richiesta non è stata accettata. Seleziona «Ricarica pannello» e riprova. |
| `error.profileGone` | This profile no longer exists. The list has been refreshed. | 此配置已不存在，列表已刷新。 | Questo profilo non esiste più. L'elenco è stato aggiornato. |
| `error.changeUnknown` | The server did not confirm the change, so it may or may not have been applied. The list has been refreshed and shows which profile is active now. | 服务器未确认此更改，可能已生效，也可能没有。列表已刷新，显示当前使用的配置。 | Il server non ha confermato la modifica: potrebbe essere stata applicata oppure no. L'elenco è stato aggiornato e mostra il profilo attivo ora. |

### 12.3 Chunking profiles: build, confirmations and gate refusals

`{command}` in `gate.no_evidence` and `gate.stale_evidence` is `npm run rag:chunking -- record-decision <decision.json>`; in
`gap.no_parse_output` it is `npm run rag:rechunk -- --profile {id} --dry-run`.

| Key | en | zh | it |
|-----|----|----|----|
| `build.barLabel` | Build progress for {id} | {id} 的构建进度 | Avanzamento della costruzione di {id} |
| `build.starting` | Starting the build… | 正在开始构建… | Avvio della costruzione… |
| `build.progress` | {done} of {total} documents built | 已构建 {done} / {total} 个文档 | {done} di {total} documenti costruiti |
| `build.note` | Each step runs for up to 45 seconds. Keep this page open; if you leave, the build pauses and Continue build picks it up. | 每一步最多运行 45 秒。请保持此页面打开；离开后构建会暂停，点击“继续构建”即可接着进行。 | Ogni passo dura fino a 45 secondi. Tieni aperta questa pagina: se esci, la costruzione si sospende e «Continua costruzione» la riprende. |
| `build.gaps` | Documents that could not be built so far: {count} | 目前无法构建的文档：{count} 个 | Documenti non costruiti finora: {count} |
| `build.busy` | A build is running. Pause it or wait for it to finish. | 正在构建。请先暂停或等待完成。 | È in corso una costruzione. Sospendila o attendi che finisca. |
| `build.pausing` | Pausing after this step… | 完成当前步骤后暂停… | Sospensione dopo questo passo… |
| `build.paused` | Build paused at {done} of {total} documents. Select Continue build to resume. | 构建已暂停，进度 {done} / {total} 个文档。点击“继续构建”恢复。 | Costruzione sospesa a {done} di {total} documenti. Seleziona «Continua costruzione» per riprendere. |
| `build.completed` | Build finished. Documents built: {total}. {id} is now ready. | 构建完成。已构建文档：{total} 个。{id} 已就绪。 | Costruzione completata. Documenti costruiti: {total}. {id} è ora pronto. |
| `build.repaired` | Build finished. No documents are missing from {id} now. | 构建完成。{id} 不再缺少文档。 | Costruzione completata. Ora a {id} non manca alcun documento. |
| `build.none` | Nothing to build. Every {type} document already has chunks in {id}. | 无需构建。所有{type}文档在 {id} 中都已有分块。 | Niente da costruire. Tutti i documenti di tipo {type} hanno già chunk in {id}. |
| `build.incomplete` | Build finished, but some documents were left out: {count}. {id} cannot be activated until they are built. | 构建已结束，但有文档未能写入：{count} 个。在补齐之前，{id} 无法激活。 | Costruzione terminata, ma alcuni documenti sono rimasti fuori: {count}. {id} non può essere attivato finché non vengono costruiti. |
| `gap.no_parse_output` | No stored parse output: {count}. These documents were ingested before parse output was kept. On the server, run {command} to list them, upload them again, then select Continue build. | 没有保存的解析结果：{count} 个。这些文档是在保存解析结果之前入库的。请在服务器上运行 {command} 列出它们，重新上传后点击“继续构建”。 | Senza output di parsing salvato: {count}. Questi documenti sono stati caricati prima che l'output di parsing venisse conservato. Sul server esegui {command} per elencarli, caricali di nuovo, poi seleziona «Continua costruzione». |
| `gap.failed` | Could not be chunked: {count}. Check the app log for [RAG Rechunk], fix the cause, then select Continue build. | 无法分块：{count} 个。请在应用日志中查找 [RAG Rechunk]，排除原因后点击“继续构建”。 | Chunking non riuscito: {count}. Cerca [RAG Rechunk] nel log dell'app, risolvi la causa, poi seleziona «Continua costruzione». |
| `gap.other` | Left out with the code {code}: {count}. Check the app log for [RAG Rechunk]. | 因代码 {code} 未写入：{count} 个。请在应用日志中查找 [RAG Rechunk]。 | Esclusi con il codice {code}: {count}. Cerca [RAG Rechunk] nel log dell'app. |
| `build.failed` | The build stopped at {done} of {total} documents. Progress so far is saved. Select Continue build. If it stops again, check the app log for [RAG Rechunk]. | 构建在 {done} / {total} 个文档处停止。已完成的进度已保存。请点击“继续构建”。如果再次停止，请在应用日志中查找 [RAG Rechunk]。 | La costruzione si è fermata a {done} di {total} documenti. L'avanzamento è salvato. Seleziona «Continua costruzione». Se si ferma di nuovo, cerca [RAG Rechunk] nel log dell'app. |
| `build.stalled` | The build is not moving forward. Progress so far is saved. Wait a minute, then select Continue build. | 构建没有进展。已完成的进度已保存。请等待一分钟后点击“继续构建”。 | La costruzione non avanza. L'avanzamento è salvato. Attendi un minuto, poi seleziona «Continua costruzione». |
| `build.unavailable` | The build service is unavailable right now. Progress so far is saved. Select Continue build in a moment. | 构建服务暂时不可用。已完成的进度已保存。请稍后点击“继续构建”。 | Il servizio di costruzione non è disponibile al momento. L'avanzamento è salvato. Seleziona «Continua costruzione» tra poco. |
| `build.network` | The connection dropped during the build. Progress so far is saved. Check that the Config UI server is running, then select Continue build. | 构建过程中连接中断。已完成的进度已保存。请确认 Config UI 服务器正在运行，然后点击“继续构建”。 | La connessione è caduta durante la costruzione. L'avanzamento è salvato. Verifica che il server della Config UI sia in esecuzione, poi seleziona «Continua costruzione». |
| `build.saved` | Progress so far is saved. | 已完成的进度已保存。 | L'avanzamento è salvato. |
| `build.refused.profile_retired` | This profile is retired and cannot be built. Create a new profile instead. | 此配置已停用，无法构建。请新建一个配置。 | Questo profilo è ritirato e non può essere costruito. Crea un nuovo profilo. |
| `build.refused.other` | The build was refused with the code {code}. Select Reload panel, then try again. | 构建被拒绝，代码 {code}。请点击“重新加载面板”后重试。 | La costruzione è stata rifiutata con il codice {code}. Seleziona «Ricarica pannello» e riprova. |
| `confirm.activate.title` | Activate {id} for {type}? | 为{type}激活 {id}？ | Attivare {id} per {type}? |
| `confirm.activate.body` | Questions about {type} documents will be answered from this profile ({sizes}) in every workspace, starting at once. The current profile, {current}, stays built, and Roll back profile returns to it. | 所有工作区中关于{type}文档的问题将立即改由此配置（{sizes}）回答。当前配置 {current} 会保留，点击“回滚配置”即可恢复。 | Le domande sui documenti di tipo {type} riceveranno subito risposta da questo profilo ({sizes}) in tutti gli spazi di lavoro. Il profilo attuale, {current}, resta costruito e «Ripristina profilo» vi fa ritorno. |
| `confirm.activate.bodyLegacy` | Questions about {type} documents will be answered from legacy chunks in every workspace, starting at once. The current profile, {current}, stays built and can be activated again. | 所有工作区中关于{type}文档的问题将立即改由原有分块回答。当前配置 {current} 会保留，可以再次激活。 | Le domande sui documenti di tipo {type} riceveranno subito risposta dai chunk originali in tutti gli spazi di lavoro. Il profilo attuale, {current}, resta costruito e può essere riattivato. |
| `confirm.rollback.title` | Roll back {type} to the previous profile? | 将{type}回滚到上一个配置？ | Ripristinare il profilo precedente per {type}? |
| `confirm.rollback.body` | {type} documents go back to {previous} in every workspace, starting at once. {current} stays built and can be activated again. | 所有工作区中的{type}文档将立即恢复使用 {previous}。{current} 会保留，可以再次激活。 | I documenti di tipo {type} tornano subito a {previous} in tutti gli spazi di lavoro. {current} resta costruito e può essere riattivato. |
| `confirm.activating` | Activating… | 正在激活… | Attivazione… |
| `confirm.rollingBack` | Rolling back… | 正在回滚… | Ripristino… |
| `activate.done` | {id} is now active for {type}. {previous} stays built. | {id} 已成为{type}的当前配置。{previous} 已保留。 | {id} è ora attivo per {type}. {previous} resta costruito. |
| `activate.already` | {id} was already active for {type}. Nothing changed. | {id} 已经是{type}的当前配置，未作更改。 | {id} era già attivo per {type}. Nessuna modifica. |
| `rollback.done` | {type} now uses {restored}. {rolledBack} is ready and can be activated again. | {type}现在使用 {restored}。{rolledBack} 已就绪，可以再次激活。 | {type} ora usa {restored}. {rolledBack} è pronto e può essere riattivato. |
| `gate.incomplete` | Not activated. Some {type} documents have no chunks in {id} yet. Select Build missing documents on that profile, then activate again. | 未激活。部分{type}文档在 {id} 中还没有分块。请在该配置上点击“构建缺失文档”，然后再次激活。 | Non attivato. Alcuni documenti di tipo {type} non hanno ancora chunk in {id}. Seleziona «Costruisci documenti mancanti» su quel profilo, poi attiva di nuovo. |
| `gate.open_gaps` | Not activated. The last build of {id} left out documents it could not build. Build the profile again and fix what the build reports, then activate again. | 未激活。{id} 最近一次构建有文档未能写入。请重新构建该配置并处理构建报告的问题，然后再次激活。 | Non attivato. L'ultima costruzione di {id} ha lasciato fuori documenti che non è riuscita a costruire. Costruisci di nuovo il profilo e risolvi ciò che segnala, poi attiva di nuovo. |
| `gate.no_evidence` | Not activated. No sweep decision is recorded in the database for {id}. Run the chunking sweep, record its decision with {command}, then activate again. | 未激活。数据库中没有 {id} 的评估决定。请运行分块评估，用 {command} 记录决定，然后再次激活。 | Non attivato. Nel database non è registrata alcuna decisione di confronto per {id}. Esegui il confronto dei profili, registra la decisione con {command}, poi attiva di nuovo. |
| `gate.eval_failed` | Not activated. The recorded sweep decision for {id} did not pass the check against legacy chunks. Open Sweep report, compare the profiles, and activate one that passed. | 未激活。{id} 的评估决定未通过与原有分块的对比。请打开“对比报告”比较各配置，激活一个通过的配置。 | Non attivato. La decisione registrata per {id} non ha superato il confronto con i chunk originali. Apri «Report di confronto», confronta i profili e attivane uno che l'ha superato. |
| `gate.stale_evidence` | Not activated. The recorded sweep decision is older than the latest build of {id}. Run the chunking sweep again and record the new decision with {command}. | 未激活。记录的评估决定早于 {id} 最近一次构建。请重新运行分块评估，并用 {command} 记录新的决定。 | Non attivato. La decisione registrata è precedente all'ultima costruzione di {id}. Esegui di nuovo il confronto e registra la nuova decisione con {command}. |
| `gate.not_ready` | Not activated. {id} is still building. Finish its build, then activate again. | 未激活。{id} 仍在构建中。请先完成构建，然后再次激活。 | Non attivato. {id} è ancora in costruzione. Completa la costruzione, poi attiva di nuovo. |
| `gate.ambiguous_profile` | Not activated. More than one document type has a profile with this ID. Select Reload panel, then activate it from its own document type's table. | 未激活。有多个文档类型存在相同 ID 的配置。请点击“重新加载面板”，然后在对应文档类型的表格中激活。 | Non attivato. Più tipi di documento hanno un profilo con questo ID. Seleziona «Ricarica pannello», poi attivalo dalla tabella del suo tipo di documento. |
| `gate.no_previous` | Nothing to roll back. {type} already uses legacy chunks. | 没有可回滚的内容。{type}已在使用原有分块。 | Niente da ripristinare. {type} usa già i chunk originali. |
| `gate.other` | Not changed. The server refused with the code {code}. Select Reload panel and try again. If it repeats, check the app log for [RAG Admin]. | 未更改。服务器拒绝了请求，代码 {code}。请点击“重新加载面板”后重试。如果再次出现，请在应用日志中查找 [RAG Admin]。 | Nessuna modifica. Il server ha rifiutato con il codice {code}. Seleziona «Ricarica pannello» e riprova. Se si ripete, cerca [RAG Admin] nel log dell'app. |

### 12.4 Chunking profiles: sweep report

`{command}` is `python -m rag_eval.sweep chunking`.

| Key | en | zh | it |
|-----|----|----|----|
| `report.loading` | Loading the sweep report… | 正在加载对比报告… | Caricamento del report di confronto… |
| `report.fixture` | This report comes from the built-in test fixture. It shows that the sweep works; it does not measure your documents. Run the live sweep before choosing a profile. | 此报告来自内置的测试数据。它只说明评估流程可用，并不反映你的文档。选择配置之前，请先运行实际评估。 | Questo report proviene dai dati di prova integrati. Dimostra che il confronto funziona, non misura i tuoi documenti. Esegui il confronto reale prima di scegliere un profilo. |
| `report.empty.title` | No sweep report yet | 还没有对比报告 | Nessun report di confronto |
| `report.empty.body` | Run {command} to compare the profiles with legacy chunks, commit the report and redeploy. The comparison then appears here. | 运行 {command}，将各配置与原有分块进行对比，提交报告并重新部署。对比结果随后会显示在这里。 | Esegui {command} per confrontare i profili con i chunk originali, salva il report nel repository e ridistribuisci. Il confronto apparirà qui. |
| `report.baselineOnly` | Only legacy chunks were measured. Add candidate profiles to the sweep to compare them. | 只评估了原有分块。请在评估中加入候选配置以进行对比。 | Sono stati misurati solo i chunk originali. Aggiungi profili candidati al confronto. |
| `report.unreadable` | The sweep report or the decision file in this deployment is not valid, so it cannot be shown. Run {command} again, commit the result and redeploy. | 本部署中的对比报告或决定文件无效，无法显示。请重新运行 {command}，提交结果并重新部署。 | Il report di confronto o il file delle decisioni di questa installazione non è valido e non può essere mostrato. Esegui di nuovo {command}, salva il risultato nel repository e ridistribuisci. |
| `report.unavailable` | The sweep report is unavailable right now. Select Reload panel in a moment. | 暂时无法读取对比报告。请稍后点击“重新加载面板”。 | Il report di confronto non è disponibile al momento. Seleziona «Ricarica pannello» tra poco. |
| `report.decisions` | Sweep decisions | 评估决定 | Decisioni del confronto |
| `report.col.type` | Document type | 文档类型 | Tipo di documento |
| `report.col.chosen` | Chosen profile | 选定的配置 | Profilo scelto |
| `report.col.gate` | Check against legacy | 与原有分块对比 | Confronto con i chunk originali |
| `report.col.source` | From | 来源 | Origine |
| `report.col.recorded` | Recorded | 记录日期 | Registrata il |
| `source.live` | Live sweep | 实际评估 | Confronto reale |
| `source.fixture` | Test fixture | 测试数据 | Dati di prova |
| `gate.passed` | Passed | 通过 | Superato |
| `gate.failed` | Failed | 未通过 | Non superato |
| `gate.baseline` | Baseline | 基准 | Riferimento |
| `gate.showRegressions` | Show what got worse ({count}) | 查看变差的指标（{count}） | Mostra cosa è peggiorato ({count}) |
| `gate.regression` | {metric}, {slice}: {diff} (allowed: {band}) | {metric}，{slice}：{diff}（允许：{band}） | {metric}, {slice}: {diff} (consentito: {band}) |
| `report.compareOn` | Compare on | 对比范围 | Confronta su |
| `slice.overall` | Overall | 全部 | Complessivo |
| `slice.group.docType` | Document type | 文档类型 | Tipo di documento |
| `slice.group.language` | Question language | 提问语言 | Lingua della domanda |
| `slice.group.kind` | Question kind | 问题类型 | Tipo di domanda |
| `kind.fact_lookup` | Fact lookup | 事实查找 | Ricerca di un dato |
| `kind.context_heavy` | Needs wider context | 需要较多上下文 | Richiede più contesto |
| `kind.clause` | Contract clause | 合同条款 | Clausola contrattuale |
| `kind.other` | Other | 其他 | Altro |
| `lang.zh` | Chinese | 中文 | Cinese |
| `lang.en` | English | 英语 | Inglese |
| `lang.it` | Italian | 意大利语 | Italiano |
| `report.caption` | Chunking profiles compared on: {slice} | 分块配置对比：{slice} | Profili di chunking a confronto su: {slice} |
| `report.col.profile` | Profile | 配置 | Profilo |
| `report.col.recall` | Recall@k | Recall@k | Recall@k |
| `report.col.mrr` | MRR | MRR | MRR |
| `report.col.falseRefusal` | False refusals | 误拒答 | Rifiuti errati |
| `report.col.correctRefusal` | Correct refusals | 正确拒答 | Rifiuti corretti |
| `report.col.judge` | Answer correctness | 回答正确率 | Correttezza delle risposte |
| `report.col.context` | Context tokens (mean) | 上下文 token（平均） | Token di contesto (media) |
| `report.col.latency` | Latency p50 / p95 | 延迟 p50 / p95 | Latenza p50 / p95 |
| `report.rateSub` | point estimate, 95% upper bound | 点估计，95% 上界 | stima puntuale, limite superiore al 95% |
| `cell.point` | point estimate | 点估计 | stima puntuale |
| `cell.upper` | 95% upper bound {value} | 95% 上界 {value} | limite superiore al 95% {value} |
| `cell.n` | n = {n} | n = {n} | n = {n} |
| `report.registeredAs` | Registered as {id} ({status}) | 已登记为 {id}（{status}） | Registrato come {id} ({status}) |
| `report.judgeSkipped` | Skipped (see notes) | 已跳过（见备注） | Saltata (vedi note) |
| `report.noData` | No data | 无数据 | Nessun dato |
| `report.latency` | {p50} / {p95} ms | {p50} / {p95} 毫秒 | {p50} / {p95} ms |
| `report.notes` | Notes from the sweep (in English) | 评估备注（英文） | Note del confronto (in inglese) |

In `gate.regression`, `{metric}` is the matching column label and `{slice}` the slice's display name (`overall`, `language:<code>`,
`doc_type:<id>`); a metric or slice the panel does not know is shown as its raw name in `code.font-mono`.

### 12.5 Refusal calibration

`{command}` is `python -m rag_eval.calibrate refusal`.

| Key | en | zh | it |
|-----|----|----|----|
| `panel.title` | Refusal calibration | 拒答校准 | Calibrazione del rifiuto |
| `panel.description` | Read-only. Shows which refusal thresholds the app can use and how they scored when they were calibrated. Thresholds change only through the calibration tool and a pull request. Applies to every workspace in this deployment. | 只读。显示应用可以使用哪些拒答阈值，以及校准时的表现。阈值只能通过校准工具和合并请求修改。对本部署的所有工作区生效。 | Sola lettura. Mostra quali soglie di rifiuto l'app può usare e come si sono comportate in calibrazione. Le soglie cambiano solo tramite lo strumento di calibrazione e una pull request. Vale per tutti gli spazi di lavoro di questa installazione. |
| `action.refresh` | Refresh status | 刷新状态 | Aggiorna stato |
| `action.reload` | Reload panel | 重新加载面板 | Ricarica pannello |
| `status.loading` | Loading refusal calibration… | 正在加载拒答校准… | Caricamento della calibrazione del rifiuto… |
| `status.loaded` | Status loaded. Thresholds: {cells}. Warnings: {warnings}. | 状态已加载。阈值：{cells} 个。警告：{warnings} 条。 | Stato caricato. Soglie: {cells}. Avvisi: {warnings}. |
| `status.updatedAt` | Updated {time} | 更新于 {time} | Aggiornato alle {time} |
| `summary.pipeline` | Pipeline | 检索流程 | Pipeline |
| `pipeline.legacy` | Legacy | 旧版 | Legacy |
| `summary.refusal` | Threshold refusal | 阈值拒答 | Rifiuto a soglia |
| `value.on` | On | 开 | Attivo |
| `value.off` | Off | 关 | Disattivo |
| `summary.reranker` | Reranker | 重排模型 | Reranker |
| `reranker.none` | None | 无 | Nessuno |
| `reranker.local_bm25` | Local BM25 | 本地 BM25 | BM25 locale |
| `summary.scores` | Score type | 分数类型 | Tipo di punteggio |
| `scores.calibrated` | Comparable across questions | 不同问题之间可比较 | Confrontabile tra domande |
| `scores.relative` | Relative to each question's candidates | 仅在同一问题的候选之间有意义 | Relativo ai candidati di ogni domanda |
| `scores.none` | No reranker | 没有重排模型 | Nessun reranker |
| `models.caption` | Reranker model by use and question language | 按用途和提问语言列出的重排模型 | Modello di reranking per uso e lingua della domanda |
| `use.chat` | Chat ({tier}) | 聊天（{tier}） | Chat ({tier}) |
| `use.voice` | Voice ({tier}) | 语音（{tier}） | Voce ({tier}) |
| `tier.quality` | quality tier | 质量档 | livello qualità |
| `tier.fast` | fast tier | 快速档 | livello rapido |
| `summary.versions` | Current versions: tokenizer {tokenizer}, rerank text {rerankText}. Thresholds calibrated with other versions are not used. | 当前版本：分词器 {tokenizer}，重排文本 {rerankText}。用其他版本校准的阈值不会被使用。 | Versioni attuali: tokenizer {tokenizer}, testo di reranking {rerankText}. Le soglie calibrate con altre versioni non vengono usate. |
| `note.legacyPipeline` | The legacy pipeline is selected. Threshold refusal works only with the v2 pipeline (RAG Modes, Retrieval pipeline). | 当前选择的是旧版流程。阈值拒答只在 v2 流程下生效（RAG Modes，Retrieval pipeline）。 | È selezionata la pipeline legacy. Il rifiuto a soglia funziona solo con la pipeline v2 (RAG Modes, Retrieval pipeline). |
| `note.refusalOff` | Threshold refusal is off, so no threshold below is applied to live answers. Turn it on under RAG Modes, Retrieval pipeline. | 阈值拒答已关闭，下方的阈值都不会用于实际回答。可在 RAG Modes 的 Retrieval pipeline 中开启。 | Il rifiuto a soglia è disattivo: nessuna delle soglie qui sotto viene applicata alle risposte reali. Attivalo in RAG Modes, Retrieval pipeline. |
| `note.pending` | Settings show threshold refusal {draft}; the app uses {live} until it restarts with the saved value. | 设置中的阈值拒答为“{draft}”；在应用以保存的值重启之前，仍为“{live}”。 | Nelle impostazioni il rifiuto a soglia è {draft}; l'app usa {live} finché non viene riavviata con il valore salvato. |
| `note.pendingReranker` | Settings show the reranker {draft}; the app uses {live} until it restarts with the saved value. | 设置中的重排模型为“{draft}”；在应用以保存的值重启之前，仍为“{live}”。 | Nelle impostazioni il reranker è {draft}; l'app usa {live} finché non viene riavviata con il valore salvato. |
| `warnings.heading` | Warnings | 警告 | Avvisi |
| `warnings.none` | No warnings for the current settings. | 当前设置下没有警告。 | Nessun avviso per le impostazioni attuali. |
| `warning.refusal_on_without_calibrated_cell` | Threshold refusal is on, but there is no calibrated live threshold for questions in {languages} with the current reranker. For those questions the similarity floor decides instead. To use thresholds there, run {command} against the live app for the models listed below, commit the result and redeploy. | 阈值拒答已开启，但在当前重排模型下，{languages}提问没有经过校准的实际阈值。这些问题改由相似度下限决定。要在这些语言上使用阈值，请针对下列模型在实际应用上运行 {command}，提交结果并重新部署。 | Il rifiuto a soglia è attivo, ma con il reranker attuale non esiste una soglia reale calibrata per le domande in {languages}. Per queste domande decide la soglia minima di similarità. Per usare le soglie, esegui {command} sull'app reale per i modelli elencati qui sotto, salva il risultato nel repository e ridistribuisci. |
| `warning.missingItem` | {use}: {model}, {language} | {use}：{model}，{language} | {use}: {model}, {language} |
| `warning.fixture_cells_only` | All thresholds below come from the test fixture. They show that the calibration tool works and are used in evaluation only, never for live answers. Run {command} against the live app to get thresholds for your data. | 下方所有阈值都来自测试数据。它们只说明校准工具可用，仅用于评估，不会用于实际回答。请在实际应用上运行 {command}，得到针对你的数据的阈值。 | Tutte le soglie qui sotto provengono dai dati di prova. Dimostrano che lo strumento di calibrazione funziona e sono usate solo nella valutazione, mai per le risposte reali. Esegui {command} sull'app reale per ottenere soglie per i tuoi dati. |
| `warning.stale_cells` | Thresholds calibrated with an older tokenizer or rerank text version: {count}. They are marked Stale below and are not used. Run {command} again, commit the result and redeploy. | 用旧版分词器或重排文本校准的阈值：{count} 个。它们在下方标为“已过期”，不会被使用。请重新运行 {command}，提交结果并重新部署。 | Soglie calibrate con una versione precedente del tokenizer o del testo di reranking: {count}. Qui sotto sono contrassegnate come «Obsoleta» e non vengono usate. Esegui di nuovo {command}, salva il risultato nel repository e ridistribuisci. |
| `warning.relative_reranker` | The {provider} reranker scores each candidate relative to the others for the same question, so a threshold cannot apply to it. The similarity floor decides instead. To use threshold refusal, choose Cohere or Voyage as the reranker under RAG Modes. | {provider} 重排模型的分数只在同一问题的候选之间有意义，因此无法应用阈值。此时由相似度下限决定。要使用阈值拒答，请在 RAG Modes 中选择 Cohere 或 Voyage 作为重排模型。 | Il reranker {provider} dà a ogni candidato un punteggio relativo agli altri della stessa domanda, quindi una soglia non può applicarsi. Decide la soglia minima di similarità. Per usare il rifiuto a soglia, scegli Cohere o Voyage come reranker in RAG Modes. |
| `warning.thresholds_invalid` | The threshold file in this deployment (eval/config/refusal-thresholds.json) is not valid, so no threshold is applied and the similarity floor decides. Run {command} again, commit the result and redeploy. | 本部署中的阈值文件（eval/config/refusal-thresholds.json）无效，因此不会应用任何阈值，由相似度下限决定。请重新运行 {command}，提交结果并重新部署。 | Il file delle soglie di questa installazione (eval/config/refusal-thresholds.json) non è valido: nessuna soglia viene applicata e decide la soglia minima di similarità. Esegui di nuovo {command}, salva il risultato nel repository e ridistribuisci. |
| `cells.heading` | Thresholds | 阈值 | Soglie |
| `cells.caption` | Refusal thresholds by reranker model and question language | 按重排模型和提问语言列出的拒答阈值 | Soglie di rifiuto per modello di reranking e lingua della domanda |
| `cells.explain` | False refusals are answerable questions that were refused. Correct refusals are questions with no answer in the knowledge base that were refused. The 95% upper bound is the highest false-refusal rate the data still allows; with few items it is far above the point estimate. | 误拒答是指本可回答却被拒答的问题。正确拒答是指知识库中没有答案并被拒答的问题。95% 上界是数据仍然允许的最高误拒答率；条目很少时，它会远高于点估计。 | I rifiuti errati sono domande a cui si poteva rispondere e che sono state rifiutate. I rifiuti corretti sono domande senza risposta nella base di conoscenza e rifiutate. Il limite superiore al 95% è il tasso di rifiuti errati più alto ancora compatibile con i dati; con pochi elementi è molto più alto della stima puntuale. |
| `cells.empty.title` | No thresholds yet | 还没有阈值 | Nessuna soglia |
| `cells.empty.body` | No calibration result is in this deployment, so threshold refusal applies nowhere and the similarity floor decides. Run {command}, commit the result and redeploy. | 本部署中没有校准结果，因此阈值拒答不会生效，由相似度下限决定。请运行 {command}，提交结果并重新部署。 | In questa installazione non c'è alcun risultato di calibrazione: il rifiuto a soglia non si applica e decide la soglia minima di similarità. Esegui {command}, salva il risultato nel repository e ridistribuisci. |
| `cells.noThreshold` | None | 无 | Nessuna |
| `col.model` | Reranker model | 重排模型 | Modello di reranking |
| `col.language` | Question language | 提问语言 | Lingua della domanda |
| `col.pairing` | Document language | 文档语言 | Lingua del documento |
| `pairing.same` | Same as the question | 与提问相同 | Uguale alla domanda |
| `pairing.cross` | Different from the question | 与提问不同 | Diversa dalla domanda |
| `col.status` | Status | 状态 | Stato |
| `col.threshold` | Threshold | 阈值 | Soglia |
| `group.dev` | Dev set | 开发集 | Set di sviluppo |
| `group.holdout` | Holdout set | 留出集 | Set di verifica |
| `col.falseRefusal` | False refusals | 误拒答 | Rifiuti errati |
| `col.falseRefusalSub` | point estimate, 95% upper bound | 点估计，95% 上界 | stima puntuale, limite superiore al 95% |
| `col.correctRefusal` | Correct refusals | 正确拒答 | Rifiuti corretti |
| `col.correctRefusalSub` | point estimate | 点估计 | stima puntuale |
| `col.recorded` | Recorded | 记录日期 | Registrata il |
| `cell.point` | point estimate | 点估计 | stima puntuale |
| `cell.upper` | 95% upper bound {value} | 95% 上界 {value} | limite superiore al 95% {value} |
| `cell.n` | n = {n} | n = {n} | n = {n} |
| `cell.noAnswerable` | No answerable items | 没有可回答的条目 | Nessun elemento con risposta |
| `cell.noNoAnswer` | No no-answer items | 没有无答案的条目 | Nessun elemento senza risposta |
| `status.calibrated` | Calibrated | 已校准 | Calibrata |
| `status.uncalibrated` | Not calibrated | 未校准 | Non calibrata |
| `status.insufficient_data` | Not enough data | 数据不足 | Dati insufficienti |
| `status.failed_holdout` | Failed the holdout check | 未通过留出集检查 | Verifica non superata |
| `status.hint.calibrated` | Passed the holdout check. | 已通过留出集检查。 | Ha superato la verifica. |
| `status.hint.uncalibrated` | No threshold was fitted. Never causes a refusal. | 没有拟合出阈值，不会导致拒答。 | Nessuna soglia calcolata. Non causa mai un rifiuto. |
| `status.hint.insufficient_data` | Too few items to fit a threshold. Never causes a refusal. | 条目太少，无法拟合阈值，不会导致拒答。 | Troppi pochi elementi per calcolare una soglia. Non causa mai un rifiuto. |
| `status.hint.failed_holdout` | The threshold did not hold on the holdout set. Never causes a refusal. | 阈值在留出集上不成立，不会导致拒答。 | La soglia non ha retto sul set di verifica. Non causa mai un rifiuto. |
| `badge.fixture` | Fixture, eval only | 测试数据，仅用于评估 | Dati di prova, solo valutazione |
| `badge.stale` | Stale | 已过期 | Obsoleta |
| `legend.summary` | What the statuses mean | 状态说明 | Significato degli stati |
| `legend.fixture` | Fixture, eval only: calibrated on the built-in test data. Used when evaluating, never for live answers. | 测试数据，仅用于评估：用内置测试数据校准，只在评估时使用，不会用于实际回答。 | Dati di prova, solo valutazione: calibrata sui dati di prova integrati. Usata nella valutazione, mai per le risposte reali. |
| `legend.stale` | Stale: calibrated with another tokenizer or rerank text version than the app runs now. Not used until calibrated again. | 已过期：校准时使用的分词器或重排文本版本与应用当前版本不同。重新校准之前不会使用。 | Obsoleta: calibrata con una versione del tokenizer o del testo di reranking diversa da quella in uso. Non viene usata finché non è ricalibrata. |
| `error.unavailable` | Refusal calibration is unavailable right now. Select Reload panel in a moment. | 暂时无法读取拒答校准。请稍后点击“重新加载面板”。 | La calibrazione del rifiuto non è disponibile al momento. Seleziona «Ricarica pannello» tra poco. |
| `error.statusUnreadable` | The refusal calibration status could not be read. Select Reload panel. If it repeats, check the app log for [RAG Admin]. | 无法读取拒答校准状态。请点击“重新加载面板”。如果再次出现，请在应用日志中查找 [RAG Admin]。 | Non è stato possibile leggere lo stato della calibrazione. Seleziona «Ricarica pannello». Se si ripete, cerca [RAG Admin] nel log dell'app. |
| `pointer.text` | Calibration status and warnings are under RAG administration, Refusal calibration. | 校准状态和警告位于 RAG administration 的“拒答校准”中。 | Lo stato della calibrazione e gli avvisi sono in RAG administration, Calibrazione del rifiuto. |
| `pointer.open` | Open refusal calibration | 打开拒答校准 | Apri calibrazione del rifiuto |

`{languages}` is the list of language names (`lang.*`, the same three keys as in 12.4, repeated in `REFUSAL_LABELS`) joined with
`Intl.ListFormat(locale, { type: 'conjunction' })`. `{draft}` and `{live}` are `value.on` / `value.off`, or reranker display names.
Tab and card names that the page itself shows in English ("RAG Modes", "Retrieval pipeline", "RAG administration") stay in English in
all three locales, so the admin can find them.

---

## 13. Color

DaisyUI theme tokens are the contract; hex values are the DaisyUI 4.4 defaults, for reference only, and are never hard-coded. These two
panels use no brand orange: in RAG administration, `myrag-primary` already means "metered premium pages" in the Ingestion panel and
keeps that single meaning.

| Role | Token | Reference (dark / light) | Usage |
|------|-------|--------------------------|-------|
| Dominant (60%) | `base-100` | ≈ #1D232A / #FFFFFF | Tab card behind the panels; the form region, the build region, the highlighted report row, dialog boxes |
| Secondary (30%) | `base-200`, `base-300` | ≈ #191E24, #15191E / #F2F2F2, #E5E6E6 | Panel cards; dividers between document types; table borders; the rate-mark track; the progress track |
| Text | `base-content`, `/70` for secondary | ≈ #A6ADBB / #1F2937 | All text; muted lines use `/70`, never lower. The rate mark's dot is `base-content`, its range `base-content/30` |
| Accent (10%) | `primary` (DaisyUI) | theme primary | See the reserved list below |
| Info | `info` | theme info | Building badge (outline), fixture badge (outline), the fixture notices (`alert-info`) |
| Success | `success` | theme success | Active badge (solid), Calibrated and Passed badges (outline) |
| Warning | `warning` | theme warning | Sign-in alert, gate-refusal alert, coverage warning, calibration warnings, incomplete and stalled builds, "Missing" lines, Stale and Failed badges, validation warnings |
| Destructive | `error` | theme error | No destructive action exists here, so no button is ever `error`. Used only for: hard validation errors, unavailable alerts, a failed build, `thresholds_invalid` |

Accent reserved for: Create profile; the single next-step button of a profile row (Build profile, Continue build, Build missing
documents, Activate profile), including Build missing documents inside the coverage warning; the confirm button of the two dialogs;
the checked size-preset radio; the build progress bar's fill; focus outlines. Nothing else is `primary`: not headings, not links, not
New profile, Roll back profile, Pause build, Refresh or Reload (all outline or ghost), not badges, and never a rate.

A rate is never coloured by its value. Success, warning and error colours describe states the server names (a status, a gate result,
a warning code), never a judgement the UI makes about a number.

---

## 14. Decisions made in this contract

No question was asked. Each row is a recommendation adopted as the contract; the PO or the planner may override it. Rows 1 to 4 differ
from the wording of `04-36-PLAN.md` and need the plan's behaviour lines and helper tests to follow this file.

| # | Question | Decision and reason |
|---|----------|---------------------|
| 1 | The plan fills the validator context from the list route, which returns none (finding 2). | The JS validator takes the context as an argument and skips a rule whose context value is missing. The panel passes no context; the two context rules come from `POST /validate`, debounced. No route changes. Alternative, if the planner prefers instant feedback on all five rules: add `validation_context { max_child_tokens, top_k, context_budget }` to the list answer (a change to a 04-34 route, outside this plan's `files_modified`) |
| 2 | The plan stops a build "until status ready or a gap is reported" (findings 4 and 5). | The loop runs while `more === true`, shows the running gap count, and reports all gaps by reason at the end. Stopping at the first gap would leave the rest unbuilt |
| 3 | The plan mounts the refusal panel "next to the refusal switch", which is on the RAG Modes tab. | The panel is a section of RAG administration, the one tab that already says it uses the admin session. RAG Modes edits `.env.local` and works without that session; a sign-in alert and a ten-column table do not belong inside its two-column checkbox grid. A pointer line with a link sits next to the switch (section 6.10), and the panel notes when the checkbox differs from the running value |
| 4 | The plan says the panel "shows whether a passing decision is recorded" (finding 3). | The panel shows the committed decision per document type from `GET /report`, says in its help line that the database record is what activation checks, and names the command. It learns the database's answer from the 409. Alternative: add `evidence` and `open_gaps` from `rag_chunking_profile_state` to the list answer |
| 5 | Are activate and rollback "destructive"? | No data is removed and each undoes the other. Both get a confirmation dialog with default focus on "Keep current profile" and a body that says the change is immediate and for every workspace. Neither uses the `error` colour |
| 6 | Where does the editor open? | Inline region under the toolbar, one form for all document types, with the document type as its first field |
| 7 | Which parent modes does the form offer? | Structure and fixed. Presets fix structure. `none` is not offered: it is the legacy shape, and legacy already exists |
| 8 | What ID does a new profile get? | Suggested `p{child}-{parent}-{doc_type}`, the sweep's convention (finding 9), editable |
| 9 | Should Activate be hidden when the gate will refuse? | Only when the list answer proves it (missing documents: the row offers Build missing documents instead). Never from the committed decision file |
| 10 | Does the report offer Activate? | No. Compare under Sweep report, switch under Profiles; one place per action |
| 11 | How are rates shown? | Always as point estimate plus 95% upper bound plus n, with the neutral rate mark. No target line, no pass or fail colour, never "≤" (F-19, finding 11) |
| 12 | Report notes and unknown server messages are English. | Shown as they are, marked `lang="en"`, under a heading that says so. They are tool output, not interface copy |
| 13 | Panel language. | Follows the browser language (zh, it, otherwise en), like the Ingestion and Document types panels |
| 14 | `badge.fixture` wording. | "Fixture, eval only" in sentence case. The plan quotes it in lower case; its helper test should compare without regard to case |
| 15 | May the admin leave during a build? | Yes. No `beforeunload` prompt: each step saves, and Continue build resumes the open run |

Observed while reading, outside this plan: the Ingestion panel's sign-in alert passes the literal text `{appUrl}` to the shared label
(`ingestion.js`, `mapIngestionError`), so its message shows the placeholder instead of the app address. The new panels fill it
(section 8). Fixing the Ingestion panel is a separate change.

---

## UI Considerations

Applicable state considerations resolved: 27 covered, 5 backstop, 0 unresolved.

| Category | Element(s) | Status | Resolution / Reason |
|----------|------------|--------|---------------------|
| empty | Profile list (no rows at all) | ✅ covered | Renders `list.empty.title` and `list.empty.body` with Reload panel (12.2) |
| empty | Document type with only legacy | ✅ covered | One line, `group.onlyLegacy`, no table |
| empty | New profile form, untouched | ✅ covered | Opens with General, preset 256/1024, structure and a suggested ID, so it is never blank |
| empty | Sweep report with no profiles | ✅ covered | `report.empty.title` and `report.empty.body` with the command |
| empty | Sweep decisions (none recorded) | ✅ covered | `decision.none` for each of the six types |
| empty | Threshold cells (none) | ✅ covered | `cells.empty.title` and `cells.empty.body`; summary and warnings still render |
| empty | Split with zero items | ✅ covered | `cell.noAnswerable` / `cell.noNoAnswer`, no numbers and no mark |
| loading | List, report, refusal status: first load and refresh | ✅ covered | First load shows a spinner with its text key; refresh keeps content at 60% opacity with `aria-busy` |
| loading | Server check, create, activate, roll back | ✅ covered | Each shows a spinner with its text and disables its own controls (section 7) |
| loading | Build in progress | ✅ covered | Progress bar with `build.progress`, `build.note`, Pause build; other actions disabled with a stated reason |
| error | 401 and 403 | ✅ covered | Panel content replaced by the shared sign-in message with the main app's address and Reload panel; no password prompt |
| error | 503 per route, 500 for report and refusal status, network failure | ✅ covered | Per-route sentence from section 8, each with a next step |
| error | 409 gate refusal on activate and rollback | ✅ covered | Gate-refusal alert in the type's block with `gate.<reason>`; list reloads |
| error | 409 `profile_exists`, 400 on create | ✅ covered | Message at the Profile ID or the named field; form keeps its values |
| error | 404 on build or activate | ✅ covered | `error.profileGone`; list reloads |
| error | Build: failed run, incomplete with gaps, stalled, refused | ✅ covered | `build.failed`, `build.incomplete` with one line per reason, `build.stalled`, `build.refused.*`; each says progress is saved or what to fix |
| error | Unknown reason or warning code | ✅ covered | Shown inside a full sentence with the code in `code.font-mono`; unknown warnings show the route's message |
| populated | Six document types, several profiles each | ✅ covered | Blocks in a fixed order; rows ordered active, ready, building, legacy, retired |
| populated | Report at 4 profiles and 14 slices | ✅ covered | One table for the chosen slice; slices chosen from a grouped select |
| populated | 6 threshold cells with warnings | ✅ covered | Summary, warnings, then the table; fixture and stale marked per row |
| partial | Active profile missing documents | ✅ covered | Coverage warning with the count and Build missing documents; `null` count shows `coverage.unknown` |
| partial | Completeness not measured | ✅ covered | `docs.notMeasured`; legacy shows an em dash with a hidden "Not applicable" |
| partial | Report loaded, decisions failed (or the reverse) | ✅ covered | The report sub-view shows `report.unreadable`; Profiles renders without decision lines and says `decision.unavailable` |
| partial | Metric with `value: null`, judge skipped | ✅ covered | Em dash with hidden `report.noData`; `report.judgeSkipped` pointing to the notes |
| partial | Paused or interrupted build | ✅ covered | `build.paused`; the row's button becomes Continue build and the open run resumes |
| zero-one-many | Counts in sentences | ✅ covered | Every count is written "label: number", so no plural form is needed in en, zh or it |
| zero-one-many | Warnings: none, one, several | ✅ covered | `warnings.none`, or one alert per warning in the route's order |
| overflow | Comparison and threshold tables on narrow screens | 🧪 backstop | Columns hide at 1024px and 768px and the rest scrolls inside a focusable region; verify at 360px, 768px and 1024px that the page itself never scrolls sideways |
| overflow | A document type with many profiles | 🧪 backstop | The table grows with the panel, no inner scroll; verify with 20 profiles in one type that actions stay reachable |
| long-text | 64-character profile ids and long model ids | 🧪 backstop | `break-all` in cells, dialogs and alerts; verify with a 64-character id in the table, both dialogs and a gate-refusal alert |
| long-text | zh and it strings in buttons, badges and table headers | 🧪 backstop | Toolbars and button rows wrap; headers wrap; verify in zh and it at 360px and 768px |
| error | Markup in ids, model ids, notes and warning messages | 🧪 backstop | All server strings set with `textContent`; the test injects markup and asserts no element is created (T-04-78) |

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none (not applicable: the Config UI does not use shadcn) | not required |
| Third-party | none | not applicable; no package is installed (T-04-SC). DaisyUI 4.4.24, the Tailwind Play CDN and Bootstrap Icons 1.11.3 are already loaded by the page and are not changed by this plan |

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS
- [ ] Dimension 7 Inventory Provenance: PASS

**Approval:** pending
