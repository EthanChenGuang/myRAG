---
phase: "07"
slug: "external-backends-release-defaults"
surface: "Config UI: RAG Modes tab (generated RAG pipeline settings section with provider tests, sync targets and index-compatibility warnings); RAG administration panels Red-team runs and Rollouts; Languages panel copy for adding and removing a language"
status: approved
reviewed_at: "2026-11-25"
shadcn_initialized: true
preset: "none recorded (components.json: style new-york, base colour neutral, CSS variables, lucide icons); it belongs to the Next.js app, which this phase does not touch"
created: "2026-11-25"
decisions: [D-14, D-15, D-16, D-24]
requirements: [ADM-01, SEC-11, LANG-10, LANG-11]
plans: ["07-20", "07-45", "07-48", "07-49", "07-52"]
---

# Phase 7: UI Design Contract (settings, provider tests, red-team runs, rollouts, language changes)

> Visual and interaction contract for the UI plans of Phase 7. Written by gsd-ui-researcher with the `frontend-design`
> skill, adapted to the existing Config UI. The executor builds from this file; the auditor compares the built UI against
> it. No question was put to the owner: under the standing rule "take the recommended option", every open point is decided
> in section 14. No plan was edited; the places where a plan needs a change or a reading are listed in section 15.

Sources read: `07-CONTEXT.md` (D-01 to D-26, A-1 to A-12), `07-RESEARCH.md`, `07-PATTERNS.md`, `07-PLAN-INDEX.md`, plans
07-04, 07-15, 07-18, 07-19, 07-20, 07-40, 07-42, 07-45, 07-46, 07-47, 07-48, 07-49 and 07-52, `REQUIREMENTS.md` (domain
neutrality rule, ADM-01, SEC-11, LANG-10, LANG-11), `ROADMAP.md` §Phase 7, `STATE.md`, `frontend-design-pipeline.md`, the
contracts `05.1.1-UI-SPEC.md`, `03.2-UI-SPEC.md`, `04-UI-SPEC.md` and `03.1-36-UI-SPEC.md` (tokens and conventions reused),
`scripts/config-ui/index.html` (head, RAG Modes tab, RAG administration tab, `ConfigManager` load and save),
`scripts/config-ui/rag-panels/*.js`, `scripts/config-ui/document-processing/status-monitor.js`,
`scripts/config-server.js` (config routes, `/api/rag/*path` proxy), `scripts/config-server-security.js`,
`scripts/rag/env-manifest.json`, and the `tests/ui/config-*.test.ts` files that read `index.html`.

The four sections the UI plans look for by name:

| Plan | Section |
|------|---------|
| 07-20 (with the switches of 07-04 and 07-45 and the metadata of 07-18) | **6.2 Generated settings section** |
| 07-48 | **6.3 Red-team panel** |
| 07-49 (states from 07-47, cells from 07-46) | **6.4 Rollouts panel** |
| 07-52 | **6.5 Languages panel: adding and removing a language** |

---

## 0. Findings that shape this contract (read first)

Facts from the code at `9da3865c`. Each one changes what the UI can show or do.

1. **Only the Config UI changes.** It is a static page: DaisyUI 4.4.24 over the Tailwind Play CDN, Bootstrap Icons 1.11.3,
   classic scripts in one global scope. The Next.js app, its shadcn components and the embed widget are not touched.
2. **121 variables are `managed` in `scripts/rag/env-manifest.json` today, and every one has a hand-written input.** 88
   sit in seven settings cards of the RAG Modes tab (Evaluation & Sidecar, Retrieval pipeline, Query layer, Ingestion and
   embedding profiles, Langfuse tracing, Citations and groundedness, Prompt-injection defense); those cards hold no input
   that is not managed. 33 sit inside the RAG administration tab, in two hidden blocks that panels move into their
   Settings sub-views: `#rag-ingestion-settings` (15, approved in 03.1-36-UI-SPEC 6.8) and `#rag-phase032-settings` (18,
   approved in 03.2-UI-SPEC 6.3), with localized labels and help through `data-ingestion-i18n` and `data-rag-i18n`.
3. **Plan 07-20 says two things that cannot both hold for those 33:** "each managed variable has exactly one input, in the
   generated section" and "the hand-built panels … stay unchanged". D-14 says the hand-built panels stay. This contract
   keeps them (decision 2, section 15 item 2).
4. **The manifest carries a label but no help text.** The 88 hand-written inputs carry help lines, some of them security
   relevant ("The endpoint returns document content. Keep it off in production…", "Sends chunk text to Lakera, a third
   party"). Rendering from the manifest alone would drop them (section 15 item 4).
5. **Saving is page-wide and automatic.** One `change` listener on `document` takes every `input`, `select` and `textarea`
   that has an `id`, writes `configManager.config[id]`, and calls `saveConfig()` one second later; `saveConfig()` posts the
   whole object to `POST /api/config`. The server drops names that are not `^[A-Z][A-Z0-9_]*$` and treats an empty secret
   as "unchanged". A generated input whose `id` is the env name therefore saves with no new code, and a control that is
   not a setting must never look like one.
6. **`populateFields()` runs once at page start** and fills fields by `id`; it also overwrites the placeholder of every
   stored secret with an English sentence. Inputs rendered later are not filled by it.
7. **The page's show or hide handler rewrites the text of any `button[data-for]`** with an emoji. A generated reveal
   button must not carry `data-for`.
8. **Bool settings on this page are saved as `true` or `false`.** Switches whose values are `on` and `off`
   (`RAG_INGEST_ASYNC`, `RAG_EMBEDDING_PROFILES`, `RAG_PARSE_ESCALATION` and others) are selects today. A toggle on such a
   variable would write the wrong value (section 15 item 5).
9. **Six test files pin the hand-written RAG Modes inputs:** `tests/ui/config-phase4-switches.test.ts`,
   `config-query-layer-card.test.ts`, `config-injection-panel.test.ts` (the wiring block), `config-chunking-panel.test.ts`
   (the pointer next to the refusal switch), `config-ingestion-panel.test.ts` and `config-ingestion-switches.test.ts`
   (where they name `RAG_PARSER` or `VOYAGE_API_KEY`). None is in plan 07-20's `files_modified` (section 15 item 1).
10. **Other scripts read managed inputs by `id`:** `refusal-calibration.js` reads `#RAG_REFUSAL_THRESHOLD` and
    `#RAG_RERANKER`; the Settings sub-views compute their combination warnings from `#RAG_PIPELINE` and
    `#RAG_INGEST_PIPELINE`. The generated section must therefore render at page load, not when its tab opens.
11. **Three non-input widgets live in the cards that plan 07-20 empties:** the pointer under the refusal switch
    (`data-refusal-pointer`), the pointer to the Ingestion settings (`#open-ingestion-settings-link`) and the read-only
    detector summary `#injection-defense-summary` (a hand-built panel in D-14's list).
12. **`ragFetch` covers only `/api/rag/…`, answers 401, 403 and 503 with fixed English sentences and does not catch
    network failures.** A stopped main app reaches the browser as a 500 from the proxy. Localized sign-in, network and
    generic sentences exist in the shared `ingestLabel` table of `status-monitor.js`.
13. **`rag-panels/rag-ui.js` and `rag-panels/languages.js` are not on the tree.** Phase 3.2 is partly executed (its settings
    block is in `index.html`, its panels are not). Plans 07-49 and 07-52 depend on the Phase 3.2 close; plans 07-20 and
    07-48 do not.
14. **Test-connection answers `{ provider, ok, latencyMs, code, message }`** with a fixed English message per code and never
    a URL or key (plan 07-19). Its provider ids (`embedding:voyage`, `rerank:voyage`, `backend:qdrant`, …) are not the
    manifest's provider ids (`voyage`, `qdrant`, …), and no plan maps one to the other.
15. **`GET /api/rag/admin/index-compat` returns `{ warnings, backends, envLoadedAt }`** with counts and codes only: per
    target the enabled flag, pending, leased and dead counts, the oldest pending age, and per embedding profile the number
    of tenants in each state (plan 07-15). It needs an admin session; the settings themselves do not.
16. **A red-team run is a child process of the config server**, started only after the app confirmed an admin, one at a
    time. Plan 07-48 defines `POST /api/red-team/runs` and `GET /api/red-team/runs/:id` and nothing that finds the latest
    or running run after a page reload, lists the run configurations, or carries the technique labels (section 15 item 8).
17. **Rollouts are per workspace, never per request** (plan 07-47): a workspace is on the candidate when it is listed, or
    when its key hashes below the share, and it is not excluded. A change takes effect after a 30-second cache. Rollback
    and exclusion move pointers only; nothing is deleted. At most one rollout per kind is active.
18. **Promotion compares each language with the same workspaces before the rollout** (plan 07-49), on the "information not
    available" rate, the not-helpful vote rate and, when present, the judge score, and refuses with one of
    `rollout_observation_too_short`, `rollout_monitoring_insufficient:<lang>`, `rollout_language_drop:<lang>:<metric>` or
    the unchanged refusal of the activation path. The route answers 404 while `RAG_ROLLOUTS` is off.
19. **External payloads hold vectors, the tokenized search text of each chunk and filter fields** (D-03, A-11). The
    tokenized text is content. Turning a sync target on therefore sends content to a vendor.

---

## 1. Design direction (frontend-design pass)

**Subject.** The operator's bench before a release: where retrieval searches, which switches differ from what ships, whether
each vendor answers, what an attack run got through, and whether a new profile may go to every workspace.

**Audience and job.** One role: the operator admin, at a desktop, in a local tool, usually with a terminal open next to it.

| Surface | Arrives with | The job of the surface |
|---------|--------------|------------------------|
| RAG pipeline settings | A switch to flip or a provider to connect | Show what is stored and what ships, take the change, say whether the provider answers |
| Red-team runs | "Does the defence still hold?" | Start one run, then show which technique got through in which language |
| Rollouts | A built candidate profile | Put it in front of a few workspaces, show each language against its own past, then promote or take it back |
| Languages | A language to add or drop | Say what must exist first, what will be reprocessed, and that nothing is deleted |

**Mode.** Impeccable "Operate": working tools inside an existing dashboard, built from its cards, tables, badges, alerts and
dialogs. No new visual language.

**Organizing idea: the evidence sits next to the switch.** Every control that changes what users get is shown beside the
fact that justifies using it. A setting stands next to its shipped default. A backend selector stands next to the index
state. Promote stands under the per-language comparison. Start stands above the last run's result. Nothing asks the
operator to remember a number from another screen.

**Signature element: the setting row** (section 6.2.2). One row per variable: the label and the env name on the left; the
control, its help, and one line that states the shipped default and marks a value that differs from it on the right. It
repeats about 130 times and is the phase's subject in one line: release defaults, and where this deployment departs from
them. Everything around it stays plain.

**Review against generic defaults (what was changed and why).**
- Rejected an accordion of collapsed groups. Collapsed text is not found by the browser's find, and operators search
  this page for env names. Groups stay open; a row of jump buttons and a count of changed settings do the navigating.
- Rejected a settings search field and a "changed only" filter. Find-in-page covers the first; the "Changed" count per
  group covers the second. Two fewer states to build.
- Rejected a wizard for connecting a backend. The order is a real sequence, so it is written once as four numbered
  sentences; the state of each step is already on screen as warnings and counts.
- Rejected a traffic-light dot per provider. A connection result is a sentence with a time; it goes stale and says so.
- Rejected stat tiles and a large "attack success rate" for red-team runs. Counts per technique are small; a table with
  the count next to the rate is honest.
- Rejected a heat map for technique by language. Colour intensity on cells of ten attacks reads as significance.
- Rejected charts and sparklines for the per-language comparison. Promotion is decided on three numbers per language; they
  are shown as numbers with their sample size and one word.
- Rejected a progress bar for the rollout share. A share is a setting, not progress.
- Rejected colouring rates. Only a result the server names (holds, got worse, not enough data) carries a colour, always
  with a word.
- Rejected emoji, middle-dot meta strings, arrows on buttons, all-caps labels and a label above a heading. The emoji in the
  existing RAG Modes heading and mode cards are not copied into new markup.

**Quality floor (built without announcing it).** Visible keyboard focus, `prefers-reduced-motion` respected, all text at
least 4.5:1, tabular numerals in number columns, usable down to 360px, every state of section 7 present, every server and
file string inserted with `textContent`.

---

## 2. Design System

| Property | Value |
|----------|-------|
| Tool | none for this surface (static HTML served by `scripts/config-server.js`; the root `components.json` belongs to the Next.js app, so the shadcn gate and registry vetting do not apply) |
| Preset | not applicable |
| Component library | DaisyUI 4.4.24 class library over Tailwind (Play CDN) |
| Icon library | Bootstrap Icons 1.11.3 (already loaded); decorative only, always `aria-hidden="true"` and always next to a text label, except the reveal button of a secret, which is an icon button with an `aria-label` |
| Font | Inherited system stack (Tailwind `font-sans`). No new web font. `font-mono` only for env names, tenant keys, ids, language codes, technique ids, shell commands, the last four characters of a secret and unknown server codes |
| Themes | DaisyUI `dark` (default) and `light`, switched by the existing toggle. Every colour is a theme token |
| Script style | Plain browser script in the style of `chunking-profiles.js`: one class per panel, pure view-model builders exported through `module.exports` for vitest, `window.*` globals for the page, DOM built with `createElement` and `textContent` only, never `innerHTML`, never a template string that carries a value |

---

## 3. Component Inventory

Enumerated by `grep -ohE 'class="[^"]*"' scripts/config-ui/index.html | grep -oE '\b(alert|badge|btn|card|checkbox|collapse|divider|dropdown|form-control|input|join|kbd|label|loading|menu|modal|progress|radio|range|select|stat|stats|steps|table|tabs|tab|textarea|toast|toggle|tooltip|skeleton)\b' | sort -u | wc -l` — 26 components — daisyui@4.4.24 — 2026-11-25.
Enumerated by `ls src/components/ui/*.tsx | wc -l` — 80 components — my-rag@0.1.0 — 2026-11-25.
Mismatch: `npx shadcn info` reported nothing (not run: `node_modules` is absent and `npx --no-install shadcn info` stops with "missing packages: shadcn@4.23.0"), filesystem has 80.

Version sources: DaisyUI and Bootstrap Icons from the pinned CDN URLs (`grep -o 'daisyui@[0-9.]*' scripts/config-ui/index.html`,
`grep -o 'bootstrap-icons@[0-9.]*' scripts/config-ui/index.html`); neither is an npm dependency
(`grep -c daisyui package-lock.json` is 0). The 26 classes found are: alert, badge, btn, card, checkbox, collapse, divider,
dropdown, form-control, input, join, label, loading, menu, modal, radio, range, select, stat, tab, table, tabs, textarea,
toast, toggle, tooltip. The second line records the app's local components for completeness (`my-rag@0.1.0` from
`node -p "const p=require('./package.json'); p.name+'@'+p.version"`); no file under `src/components/ui/` changes in this
phase, and no component from it is used by the Config UI.

The table is the **known-good, non-exhaustive** set for this phase. Other DaisyUI 4.4 classes may be used when needed; the
page loads the full stylesheet. `progress` is one of them: it is in the stylesheet and not yet used on the page.

| Component | Classes / element | Used for |
|-----------|-------------------|----------|
| Group card | `section.card.bg-base-200.shadow-md.min-w-0.scroll-mt-4 > .card-body` | Each settings group; the two new RAG administration panels |
| Setting row | `div.grid.gap-x-6.gap-y-1.py-4.md:grid-cols-5` (6.2.2) | Every managed variable. The one new composite |
| Toggle | `input[type=checkbox].toggle.toggle-primary` | Bool settings; the two sync switches |
| Select | `select.select.select-bordered.w-full.md:select-sm` | Enum settings; run configuration; rollout kind |
| Input | `input.input.input-bordered.w-full.md:input-sm` | Number, text, URL and secret settings; candidate ID; workspace key; share |
| Textarea | `textarea.textarea.textarea-bordered.textarea-sm.w-full` | Workspace keys of a new rollout |
| Radio | `input[type=radio].radio.radio-sm` in `label` inside `fieldset` | "Who gets it first" |
| Buttons | `btn md:btn-sm` with `btn-primary`, `btn-outline`, `btn-ghost`, `btn-link` | Actions. No `btn-error` in this phase |
| Icon button | `button.btn.btn-square.btn-outline.md:btn-sm` | Show or hide a typed secret |
| Table | `table.table.table-sm` inside `div.overflow-x-auto[tabindex=0][role=region]` | Index state, attack results, language comparison, recent rollouts |
| Badge | `badge badge-sm badge-outline` with `badge-success`, `badge-error`, `badge-warning`, `badge-info`, `badge-ghost` | "Changed", run state, rollout state, comparison result |
| Alert | `div.alert` with `alert-warning`, `alert-error`, `alert-info` | Index compatibility, sign-in, unavailable, switched off, loaded configuration |
| Loading | `span.loading.loading-spinner.loading-sm.motion-reduce:hidden` | In-flight states, always with text |
| Progress | `progress.progress.w-full` (native element) | A running red-team run with a known total |
| Modal | `dialog.modal > .modal-box.overscroll-contain > .modal-action`, `form.modal-backdrop` | The confirmations of section 12.1 |
| Ordered list | `ol.list-decimal.pl-4.text-sm` | The four steps to an external backend |

---

## 4. Spacing Scale

Same scale as the earlier Config UI contracts. Tailwind utilities only.

| Token | Value | Tailwind | Usage |
|-------|-------|----------|-------|
| xs | 4px | `gap-1`, `mt-1`, `gap-y-1` | Icon to label; a control to its help line and to its default line; label to env name |
| sm | 8px | `gap-2`, `mt-2`, `mb-2` | Buttons in a row; jump buttons; a toggle to its "On" or "Off"; badges side by side; heading to description |
| md | 16px | `gap-4`, `mt-4`, `mb-4`, `py-4`, `p-4` | Vertical padding of a setting row; between form fields; description to content; padding of a provider block and of a rollout's workspace block |
| lg | 24px | `gap-6`, `mt-6`, `gap-x-6` | Between group cards and panels; between the two columns of a setting row; between blocks inside a card |
| xl | 32px | `.card-body` default, `py-8` | Card padding (DaisyUI default); empty-state blocks |
| 2xl | 48px | `h-12` (DaisyUI `btn`, `input` and `select` height) | Controls and row actions below 768px |
| 3xl | 64px | not used | Reserved for page-level spacing |

Exceptions: none. No 2px, 6px, 10px or 12px spacing appears in new markup.

Component internals outside the scale (shipped sizes, not restyled): DaisyUI `table-sm` cell padding, `input-sm`,
`select-sm`, `textarea-sm`, `radio-sm`, `toggle` (24px by 48px), `btn-xs` (24px, jump buttons only), `btn-sm` (32px),
`btn` (48px), `badge-sm` and `.modal-box`. Controls and buttons are `md:…-sm`: 48px tall below 768px, 32px from 768px. Every target meets the WCAG 2.2
AA size (24px).

Sizes that are not spacing: icons are 16px; the left rule of a provider block and of a rollout card is 4px
(`border-l-4 border-base-300`); corner radius is the DaisyUI default of each component and `rounded-lg` (8px) on provider
blocks; description and alert paragraphs cap at `max-w-prose`.

---

## 5. Typography

Exactly four sizes and two weights, the same as the sibling panels.

| Role (template role) | Size | Weight | Line height | Tailwind | Where |
|----------------------|------|--------|-------------|----------|-------|
| Panel heading (Heading) | 18px | 600 | 1.33 (`leading-6`) | `text-lg font-semibold` | "RAG pipeline settings", "Red-team runs", "Rollouts" |
| Sub-heading (Display) | 16px | 600 | 1.5 (`leading-6`) | `text-base font-semibold` | Group card titles, "Latest run", rollout card headings, "Recent rollouts", the rollout form title, dialog titles, empty-state titles |
| Body (Body) | 14px | 400 (600 for `h5` and `h6` block headings, alert titles and the total row of a table) | 1.43 (`leading-5`) | `text-sm` | Setting labels, descriptions, table cells, buttons, alerts, status messages, list items; block headings inside a card (`text-sm font-semibold`) |
| Meta (Label) | 12px | 400 (600 for table headers) | 1.33 (`leading-4`) | `text-xs` | Env names, help lines, default and stored lines, requirement hints, badges, table headers, second lines |

Rules:
- Heading levels follow the page: the tab title is `h2`; "RAG pipeline settings" and the two panel titles are `h3`
  (18/600); group cards, "Latest run", rollout cards, the rollout form and "Recent rollouts" are `h4` (16/600); blocks
  inside a card are `h5` (14/600): provider blocks, "Order of steps…", "Sync and index state", "Quality per language",
  "Workspaces"; the sync block of one backend is `h6` (14/600). No level is skipped.
- Number columns, counts, rates and latencies use `tabular-nums`; numbers are right-aligned in their columns.
- Env names, tenant keys, candidate ids, technique ids, language codes and the last four characters of a secret use
  `font-mono text-xs` with `translate="no"`. Commands use `code.font-mono.text-xs.break-all`. Nothing else is monospace.
- Manifest labels and help lines are English data. When the page locale is not `en`, their elements carry `lang="en"`.
- No all-caps labels, no letter-spaced eyebrows, no label above a heading, no single emphasised word inside a heading.
- Each script-built root carries `lang="<locale>"`.

---

## 6. Layout and interaction

### 6.1 Placement, files and mount

```
RAG Modes tab (#rag-modes), after the mode cards and the bypass warning:
   RAG pipeline settings        NEW   #rag-pipeline-settings        rag-panels/rag-pipeline.js    plan 07-20
      replaces the seven settings cards (finding 2); one group card per manifest group
   Prompt-injection detectors   KEPT  the card that holds #injection-defense-summary, without inputs (6.2.7)
   "How it works" info box      existing

RAG administration tab (#rag-administration, .grid.gap-6), appended after the last panel on the tree
(Refusal calibration today; Feedback loop once Phase 5.1.1 is on the tree):
   Red-team runs                NEW   #rag-administration-red-team   rag-panels/red-team.js        plan 07-48
   Rollouts                     NEW   #rag-administration-rollouts   rag-panels/rollouts.js        plan 07-49

   Languages                    Phase 3.2 panel (#rag-administration-languages), copy added        plan 07-52
```

- **Order.** Red-team runs stands next to the review panels its results feed. Rollouts is last. Both are appended, so the
  order fixed by 03.2-UI-SPEC and 05.1.1-UI-SPEC for the panels above them is untouched.
- **Tab intro.** One sentence is added after the existing intro of RAG administration: "Start red-team runs and roll new
  profiles out to a few workspaces first." (plan 07-48 adds the first half, plan 07-49 completes it.)
- **Script tags.** `rag-panels/rag-pipeline.js` directly after `rag-panels/rag-fetch.js`, loaded once.
  `rag-panels/red-team.js`, then `rag-panels/rollouts.js`, after the last panel script on the tree. A script that reads a
  managed input by `id` must tolerate its absence until the section has rendered (section 15 item 3).
- **Skeleton of each new panel** (static in `index.html`; scripts build everything else):
  ```
  section#rag-administration-red-team.card.bg-base-200.shadow-md.min-w-0.scroll-mt-4[aria-labelledby=rag-red-team-title]
    div.card-body
      h3#rag-red-team-title.text-lg.font-semibold.mb-2[tabindex=-1][data-red-team-title]        Red-team runs
      p.text-sm.text-base-content/70.mb-4.max-w-prose[data-red-team-description]
      div[data-red-team-alert].mb-4.empty:mb-0
      div[data-red-team-content]
      div[data-red-team-status].text-sm.mt-4[role=status][aria-live=polite]
  ```
  The Rollouts panel is the same with `rag-administration-rollouts`, `rag-rollouts-title` and `data-rollouts-*`. The `h3`
  gets `rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2`.
- **Skeleton of the settings section** (static in `index.html`, at the position of the first removed card):
  ```
  section#rag-pipeline-settings.mt-6.min-w-0.scroll-mt-4[aria-labelledby=rag-pipeline-title]
    h3#rag-pipeline-title.text-lg.font-semibold.mb-2[tabindex=-1][data-rag-pipeline-title]      RAG pipeline settings
    p.text-sm.text-base-content/70.mb-2.max-w-prose[data-rag-pipeline-description]
    p.text-xs.text-base-content/70.mb-4.max-w-prose[data-rag-pipeline-secrets-note]
    div[data-rag-pipeline-alert].mb-4.empty:mb-0
    nav[data-rag-pipeline-nav].flex.flex-wrap.gap-2.mb-4
    div[data-rag-pipeline-content].grid.gap-6                                                   Loading settings…
    div[data-rag-pipeline-status].text-sm.mt-4[role=status][aria-live=polite]
  ```
- **Global names.** Every top-level `const`, `let`, `class` and function starts with its file's prefix: `ragPipeline` /
  `RagPipeline` / `RAG_PIPELINE_` in `rag-pipeline.js`; `redTeam` / `RedTeam` / `RED_TEAM_` in `red-team.js`; `rollouts` /
  `Rollouts` / `ROLLOUTS_` in `rollouts.js`. No file declares a bare `RAG_PIPELINE` (it is the `id` of a setting). Page
  globals: `window.initRagPipelineSettings`, `window.ragPipelineSettings`, `window.initRedTeamPanel`, `window.redTeamPanel`,
  `window.initRolloutsPanel`, `window.rolloutsPanel`.
- **Helpers.** Decided at plan start by one check, `test -f scripts/config-ui/rag-panels/rag-ui.js`. When the file exists,
  a new script uses its builders (element, icon, spinner, alert, confirmation dialog, error mapper, locale resolver).
  When it does not, the script carries private helpers under its own prefix, as `refusal-calibration.js` does. Never both
  in one file, and no existing panel is refactored.
- **Mount.** `initRagPipelineSettings()` runs on `DOMContentLoaded` whatever tab is active (finding 10). It builds the
  rows once; a later call refreshes values, hints and status and never rebuilds a row, so a field being edited keeps
  its text and focus. `initRedTeamPanel()`
  and `initRolloutsPanel()` are idempotent, bind to **every** `[data-tab="rag-administration"]` element and run at once
  when the tab is already active.
- **Locale.** `navigator.language` first two letters, `zh` or `it`, otherwise `en`, as the Ingestion panel resolves it.
- **Requests.** App routes go through `ragFetch` with the full path. Config-server routes (`/api/rag-pipeline/manifest`,
  `/api/red-team/…`, `/api/config/…`) go through `fetch` with `credentials: 'same-origin'`; the page's fetch wrapper adds
  the CSRF header. No `Authorization` header, nothing written to `localStorage`, `sessionStorage` or a cookie. Every call
  is wrapped in `try/catch`. Client timeouts: 15 seconds; 30 seconds for a sync switch and for starting a run; 60 seconds
  for promote, roll back, include and exclude.
- **Controls that are not settings** (sync switches, run configuration, every field of the rollouts panel) carry
  kebab-case ids with the file's prefix (`rag-pipeline-sync-qdrant`, `rollouts-form-candidate`), which the config server
  never accepts as an env name, and sit inside a container whose `change` listener calls `stopPropagation()`, so the
  page's auto-save never sees them (finding 5).
- **Polling.** Only the Red-team panel polls, and only while a run is running (6.3).

### 6.2 Generated settings section (plans 07-20, 07-45)

#### 6.2.1 Section anatomy

```
RAG pipeline settings                                                        h3
section.description                                                          14px
section.secretsNote                                                          12px
[alert host]   loaded.changed | sign-in for the admin-backed parts | admin.unavailable
[ Documents and ingestion ] [ Query ] [ Retrieval  Changed: 2 ] … [ Vector backends  Warnings: 1 ]     jump buttons

┌ Documents and ingestion ─────────────────────────────────────────────┐   h4, one card per group, all open
│ group description                                                    │
│ setting rows, in manifest order                                      │
│ provider blocks, one per provider, in order of first appearance      │
└──────────────────────────────────────────────────────────────────────┘
… Query, Retrieval, Reranking and context, Answers and citations, Evaluation,
  Vector backends, Security, Tracing and monitoring, Sidecar
[status region]
```

- **Data.** `GET /api/rag-pipeline/manifest` (config server, no admin session): the managed entries' metadata (`name`,
  `group`, `label`, `type`, `options`, `requires`, `default`, `provider`, and `help` when section 15 item 4 is adopted),
  the current non-secret values, the secret hints `{ state: 'set' | 'unset', last4? }` and the modification time of
  `.env.local`.
- **Group order (fixed):** `data`, `query`, `retrieval`, `ranking`, `generation`, `evaluation`, `backends`, `security`,
  `observability`, `sidecar`: the six pipeline layers in pipeline order, then where retrieval runs, then operations.
  Titles and descriptions come from the script's label table (12.2). A group id the table does not know is rendered
  last, with the id in `font-mono` as its title and `group.unknown.description`.
- **Jump buttons.** One `button.btn.btn-ghost.btn-xs` per rendered group inside `nav[aria-label=nav.label]`. Pressing one
  scrolls the group card to the top (`scrollIntoView({ block: 'start' })`, no smooth scrolling) and moves focus to its
  `h4` (`tabindex="-1"`). It changes no URL fragment. After the group name the button shows `nav.changed` when at least one
  setting of the group differs from its default, and on Vector backends `nav.warnings` when index-compatibility warnings
  exist; both are 12px and part of the button's accessible name.
- **Saving.** Each control's `id` and `name` equal the env name, so the page's listener saves it one second after a change
  and "Save All Changes" keeps working. The section adds no Save button. `section.description` says that changes save
  automatically and take effect when the app restarts.
- **Two one-line additions to `index.html` script** (both inside plan 07-20's files): `saveConfig()` dispatches
  `document.dispatchEvent(new CustomEvent('rag-config-saved'))` after a successful `POST /api/config`; `populateFields()`
  skips any field inside `#rag-pipeline-settings` (finding 6). On `rag-config-saved` the section clears typed secrets
  (6.2.3), reloads the manifest values and hints, and recomputes the loaded-configuration note (6.2.6).
- **Hosted settings.** When the section renders, a variable whose control (`id` equal to the env name) already exists
  outside `#rag-pipeline-settings` is **hosted**: the section renders a read-only row for it and no second control, so an
  `id` never occurs twice (finding 3). The hand-written control always wins.

#### 6.2.2 The setting row (signature element)

```
from 768px                                                         below 768px: the two cells stack
┌─────────────────────────────┬──────────────────────────────────────────────┐
│ Retrieval backend           │ [ pgvector                              v ]  │   control
│ RAG_RETRIEVAL_BACKEND       │ help line, when the manifest has one         │   12px
│                             │ (i) Used only when Pipeline is v2.           │   12px, only while unmet
│                             │ [Changed]  Default: pgvector                 │   12px
└─────────────────────────────┴──────────────────────────────────────────────┘
```

```
div.grid.gap-x-6.gap-y-1.py-4.border-t.border-base-300.first:border-t-0.md:grid-cols-5[data-rag-pipeline-row=<NAME>]
  div.min-w-0.md:col-span-2
    label.text-sm[for=<NAME>]                                              manifest label
    code.block.font-mono.text-xs.text-base-content/70.break-all[translate=no]   <NAME>
  div.min-w-0.md:col-span-3
    the control
    p.text-xs.text-base-content/70.mt-1#rag-pipeline-help-<NAME>           manifest help, when present
    p.text-xs.text-base-content/70.mt-1#rag-pipeline-requires-<NAME>       bi-info-circle + hint, only while unmet
    p.text-xs.text-base-content/70.mt-1#rag-pipeline-meta-<NAME>           Changed badge, then the default or stored line
```

The control's `aria-describedby` lists the help, requirement and meta paragraphs that exist.

| Manifest `type` | Control | Details |
|-----------------|---------|---------|
| `bool` | `input[type=checkbox].toggle.toggle-primary`, then `span.text-sm[aria-hidden=true]` with `value.on` or `value.off` (8px apart) | Writes `true` or `false`. An unset entry shows the state of its default and writes nothing until changed |
| `enum` | `select.select.select-bordered.w-full.md:select-sm[translate=no]` | One option per manifest option, in manifest order; `value` and text are the env value. An unset entry selects its default. When both the stored value and the default are empty, a first option with value `""` and text `enum.unset` is added and selected |
| `number` | `input[type=number].input.input-bordered.w-full.md:input-sm` | `inputmode="decimal"`, `step="any"`, `autocomplete="off"`; placeholder is the default |
| `string` | `input[type=text]`, same classes | `autocomplete="off"`, `spellcheck="false"`; placeholder is the default |
| `url` | `input[type=url]`, same classes | `autocomplete="off"`, `spellcheck="false"`, `translate="no"`; placeholder is the default |
| `secret`, or any entry the server returned a secret hint for | Password field with a reveal button (6.2.3) | Never a value, never a default |
| any other type | No control: `row.unknownType` with the type in `font-mono`, `bi-exclamation-triangle` | Read-only; the section never throws on unknown metadata |

Rules:
- **Default line.** `row.default` with the default as written in the manifest (`value.on` or `value.off` for a bool),
  or `row.defaultEmpty` when the default is the empty string. Secret rows show the stored line of 6.2.3 instead.
- **Changed.** A row whose default is not empty and whose stored value is set and differs from it (trimmed; bools compared
  as lower-case `true` and `false`) shows `span.badge.badge-sm.badge-outline` `row.changed` before the default line, and
  counts into `nav.changed` of its group. The badge is neutral: a changed value is a fact, not a problem. It is
  recomputed on every change of the control, before the save.
- **Requirements.** For each entry of `requires` that the page's current values do not meet (read from the controls, so an
  unsaved change counts), the row shows one hint: `row.requires` or `row.requiresOn`, naming the required setting by its
  manifest label. A `bool`, `enum`, `number` or `string` control with an unmet requirement is `disabled` and keeps its
  value. A `url` or `secret` control is **never** disabled by a requirement: a provider must be configurable and
  testable before anything is switched to it (decision 6). The hint is plain text beside the control, so it is readable
  although a disabled control takes no focus.
- **Hosted row.** In place of a control: `row.hostedValue` (the saved value in `font-mono`; `secret.set` or `secret.unset`
  for a secret; `row.hostedUnset` when empty), then `row.hosted` with `{tab}` set to the text of the sidebar link of the
  tab that contains the control, and `button.btn.btn-link.btn-sm.px-0` `action.showSetting`. Pressing it: (1) activates
  that tab by clicking its first `[data-tab]` link, which also starts the tab's panels; (2) looks the control up again; if
  it still sits inside a hidden staging block (an ancestor with class `hidden` whose id ends in `-settings`), no panel
  has taken it yet: the previous tab is activated again in the same task and the row shows `row.hostedNoEditor` in place
  of the button; (3) otherwise, a visible control is scrolled to the centre and focused, and a control in a hidden
  sub-view gets focus on the heading of its closest `section[id]` (given `tabindex="-1"` when it has none).
- **Related panel.** Three rows end with `button.btn.btn-link.btn-sm.px-0` `action.openPanel`, shown only while the target
  section exists: `RAG_REFUSAL_THRESHOLD` to `#rag-administration-refusal`, `RAG_EMBEDDING_PROFILES` to
  `#rag-administration-profiles`, `RAG_ROLLOUTS` to `#rag-administration-rollouts`. `{panel}` is the text of the target's
  `h3`. Pressing it activates the RAG administration tab, scrolls the section into view and focuses its heading. This
  replaces the static pointer of 04-UI-SPEC 6.10; the map is a constant in `rag-pipeline.js`.
- **Long values.** Labels wrap; env names break anywhere (`break-all`); a long stored URL scrolls inside its input.

#### 6.2.3 Secrets

```
┌─────────────────────────────┬──────────────────────────────────────────────┐
│ Qdrant API key (write)      │ [ ••••••••••••••••            ] [eye]        │
│ QDRANT_API_KEY              │ Stored, ends in a1b2                         │
└─────────────────────────────┴──────────────────────────────────────────────┘
```

- `div.flex.gap-2` with `input[type=password].input.input-bordered.flex-1.w-full.min-w-0.md:input-sm` (`autocomplete="off"`,
  `spellcheck="false"`, always rendered empty, never a `value` attribute) and
  `button[type=button].btn.btn-square.btn-outline.md:btn-sm[data-rag-pipeline-reveal]` with `bi-eye` or `bi-eye-slash`,
  `aria-pressed`, and the accessible name `secret.show` or `secret.hide` with the setting's label. It carries no `data-for`
  (finding 7). It shows only what was typed in this session; there is nothing else to show.
- **Stored line** (in the meta paragraph): `secret.setLast4` with the four characters in `font-mono` when the server sent
  them (it does so only for values of at least 20 characters), `secret.set` when it did not, `secret.unset` when nothing
  is stored. Placeholder: `secret.placeholderSet` or `secret.placeholderUnset`.
- **Typing.** While the field holds text, the stored line reads `secret.pending`. The value is saved by the page's
  listener like any other field.
- **After a save** (`rag-config-saved`): every generated secret field that held text is emptied, set back to
  `type="password"`, its key is deleted from `configManager.config`, and its stored line is rebuilt from the reloaded
  hints; the status region announces `secret.replaced` with the setting's label. The typed value is never written to the
  DOM as text, to an attribute, to storage or to the console.
- **Keeping and removing.** An empty field keeps the stored value (existing server rule). The section offers no control
  that removes a stored secret; `section.secretsNote` says how (delete its line in `.env.local`).
- A secret row never shows a "Changed" badge and has no default.

#### 6.2.4 Provider blocks and Test connection

Inside a group card, after its plain rows: one block per distinct `provider` of the group's `url` and `secret` entries.

```
div.border-l-4.border-base-300.rounded-lg.p-4.mt-4[data-rag-pipeline-provider=<id>]
  h5.text-sm.font-semibold[translate=no]                     Qdrant
  setting rows of this provider
  div.flex.flex-wrap.items-center.gap-2.mt-4
    button.btn.btn-outline.md:btn-sm                         Test connection        (aria-label: test.actionAria)
    div.text-sm.min-w-0[data-rag-pipeline-test-result]       result lines
```

- **Provider names** are a constant map of brand names, not translated: `openai` OpenAI, `openrouter` OpenRouter, `voyage`
  Voyage AI, `deepinfra` DeepInfra, `cohere` Cohere, `anthropic` Anthropic, `llamacloud` LlamaCloud, `langfuse` Langfuse,
  `lakera` Lakera, `exa` Exa, `vectara` Vectara, `weaviate` Weaviate, `qdrant` Qdrant, `sidecar` `provider.sidecar`,
  `judge` `provider.judge`, `prompt_guard` `provider.promptGuard`. An unknown id is shown in `font-mono`.
- **Probes** are a second constant map from the manifest's provider id to the ids plan 07-19 accepts (finding 14):
  `openai` → `embedding:openai`; `voyage` → `embedding:voyage`, `rerank:voyage`; `deepinfra` → `embedding:deepinfra`;
  `cohere` → `rerank:cohere`; `weaviate` → `backend:weaviate`; `qdrant` → `backend:qdrant`; `sidecar`, `langfuse`,
  `vectara`, `lakera`, `llamacloud`, `anthropic`, `exa` → the same id. A provider without a probe (`openrouter`, `judge`,
  `prompt_guard`, an unknown id) shows `test.none` in 12px and no button.
- **Pressing Test connection** sends `POST /api/rag/admin/providers/test` with `{ provider }` once per probe, one after the
  other. The button shows the spinner with `test.running` and is disabled; other blocks stay usable.
- **Result lines** (14px, one per probe, each with an icon and words, never colour alone): `bi-check-circle` and `test.ok`
  with the latency for `ok: true`; `bi-x-circle` and the sentence for the code otherwise (`test.fail.<code>`, or
  `test.fail.other` with the code in `font-mono`). A provider with two probes prefixes each line with `test.role.embedding`
  or `test.role.rerank`. Under the lines, 12px: `test.time` with the local time of the test. Results are not kept across
  a reload and never contain an address: the server sends none and the UI adds none.
- The status region announces each result as `test.announce`.
- **401 or 403:** the result line is the shared sign-in sentence; the section's alert host shows the sign-in alert of
  7.2. **5xx, thrown or timeout:** `admin.unavailable` as the result line.
- The test checks what the running app loaded, not what the fields hold. `loaded.note` says so once, under the first
  provider block of each group card that has one; the alert of 6.2.6 says when the two differ.

#### 6.2.5 Vector backends group: warnings, steps, sync and index state

The `backends` card has, in this order: its description; the warnings alert; the four steps; its setting rows
(`RAG_RETRIEVAL_BACKEND`, `RAG_RETRIEVAL_BACKEND_VOICE`, `RAG_VECTOR_SYNC_MAX_LAG_SECONDS`, `RAG_VECTOR_SYNC_SECRET` and any
other entry of the group); the block "Sync and index state"; the provider blocks Weaviate and Qdrant.

```
┌ (!) Retrieval backend and index do not match ──────────────────────────────────┐   alert-warning, only with warnings
│  • Qdrant is selected, but sync to it is off. Turn on sync below and wait      │
│    until every workspace is ready.   sync_not_enabled                          │
│  • Changes that failed permanently: 4. …   dead_letters                        │
└────────────────────────────────────────────────────────────────────────────────┘
Order of steps for an external backend                                h5, then ol with steps.1 to steps.4
…setting rows…
Sync and index state                                                  h5          [Reload status]
sync.description
  Qdrant                                                              h6
  Sync to Qdrant  (o )  Off
  Waiting: 0   In progress: 0   Failed permanently: 0   Oldest waiting: none
  ┌───────────────────┬───────┬──────────┬─────────────┬────────┐
  │ Embedding profile │ Ready │ Building │ Out of date │ Failed │     caption sr-only
  ├───────────────────┼───────┼──────────┼─────────────┼────────┤
  │ profile-a         │    12 │        1 │           0 │      0 │
  └───────────────────┴───────┴──────────┴─────────────┴────────┘
  Weaviate …
```

- **Data.** `GET /api/rag/admin/index-compat` and `GET /api/rag/admin/vector-sync/targets`, requested when the section
  mounts and by "Reload status" (`btn btn-outline md:btn-sm`). They need the admin session; the setting rows do not and
  stay usable when these calls fail.
- **Warnings alert.** `div.alert.alert-warning.items-start` with `bi-exclamation-triangle`, the title `compat.title`
  (a `p`, 14px at weight 600, not a heading)
  and a `ul` with one `li` per warning: the sentence for its code (`compat.<code>`, 12.2) with the backend's brand name and
  the numbers from `detail`, then the code in `code.font-mono.text-xs`. An unknown code uses `compat.other`. With no
  warning the alert is absent and the 12px line `compat.ok` stands under the block heading. The alert has no alert role
  on first load; after "Reload status" the status region announces `compat.count`.
- **Steps.** `ol.list-decimal.pl-4.text-sm.max-w-prose` with four items. Static text; it tracks no state.
- **Sync switch, one per target.** `input[type=checkbox].toggle.toggle-primary[role=switch]` with a visible
  `label[for]` `sync.toggle` and the word `value.on` or `value.off`. Its `click` handler calls `preventDefault()` and
  opens the dialog of 12.1; the switch changes only after `PUT /api/rag/admin/vector-sync/targets` answered. While the
  request runs the switch is disabled and the line beside it reads `sync.turningOn` or `sync.turningOff`. Success:
  `sync.on.done` with the number of workspaces queued, or `sync.off.done`, in the status region, and the status reloads.
- **Outbox line** (14px, wraps): `sync.waiting`, `sync.inProgress`, `sync.failed`, and `sync.oldest` or `sync.oldestNone`.
  A failed count above 0 is `font-semibold` with `bi-exclamation-triangle`. Ages are formatted with
  `Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' })` in seconds below 120, minutes below 120, then
  hours.
- **State table.** One row per embedding profile (`th scope="row"`, the id in `font-mono`), columns `col.ready`,
  `col.building`, `col.stale`, `col.failed`; counts right-aligned, never coloured. No profile row: `sync.noState` instead
  of the table.
- The block never shows a tenant key, a document id, a URL or a key; the route sends none.

#### 6.2.6 Loaded configuration note

- `envLoadedAt` (from index-compat) is compared with the modification time of `.env.local` (from the manifest route), at
  mount and after every `rag-config-saved`.
- File newer than `envLoadedAt`: `div.alert.alert-info.items-start` with `bi-arrow-repeat` and `loaded.changed` in the
  section's alert host. It stays until a reload finds the app restarted.
- `envLoadedAt` unknown (the admin call failed): no alert; `loaded.note` under the provider blocks still tells the rule.

#### 6.2.7 What is removed from RAG Modes, and what stays

- **Removed:** the seven settings cards with their 88 inputs, the static pointer under the refusal switch and the static
  pointer to the Ingestion settings (replaced by the related-panel button and by hosted rows).
- **Stays, as static markup directly after `#rag-pipeline-settings`:** one card titled "Prompt-injection detectors" with
  the description "Read-only summary of the committed rule set and detector settings. The switches are above, under
  Security." and the unchanged `#injection-defense-summary` block. The HTML comment `<!-- Prompt-injection defense -->`
  stays directly before the card, so the existing wiring test still finds the summary. `injection-defense.js` is not
  edited. The card title and description are static English, like every static text of the page.
- **Stays untouched:** the mode selector, the mode cards, the bypass warning, the "How it works" box, every legacy
  (unmanaged) input on other tabs, and every hand-built panel of RAG administration with its Settings sub-view.

### 6.3 Red-team panel (plan 07-48)

Operator admins only. The run executes on the operator's machine; the browser only starts it and reads counts.

```
Red-team runs                                                         h3
panel.description
note.workspace                                                        12px
[alert host]   sign-in | admin only | unavailable | review.off
Run configuration [ Current deployment settings v ]                   start.configHelp, 12px
[Start red-team run]
────────────────────────────────────────────────────────────────────────
Latest run                                                            h4                     [Refresh status]
[Finished]  Started: 25 Nov 2026, 14:02   Finished: 25 Nov 2026, 14:09
Attacks replayed: 96    Attacks that succeeded: 3    Review cases opened: 3   [Open Review queue]
┌──────────────────────────────┬──────────┬─────────┬───────────┬──────────────┐
│ Technique                    │ Language │ Attacks │ Succeeded │ Success rate │    caption sr-only
├──────────────────────────────┼──────────┼─────────┼───────────┼──────────────┤
│ Hidden text                  │ Chinese  │      12 │       (!) 2 │        16.7% │
│ hidden_text                  │ zh       │         │           │              │
│ …                            │          │         │           │              │
│ All techniques               │          │      96 │         3 │         3.1% │    font-semibold
└──────────────────────────────┴──────────┴─────────┴───────────┴──────────────┘
note.small                                                            12px
[status region]
```

- **On mount** the panel asks the config server for the latest run and the available run configurations (one call,
  `GET /api/red-team/runs`; section 15 item 8). A run in state `running` resumes polling.
- **Run configuration.** `select#red-team-run-config.select.select-bordered.w-full.md:select-sm.md:max-w-md`, first option
  `start.configCurrent` (value `""`), then one option per file name the server lists, in `translate="no"`. The browser sends
  the chosen name only; never a path, a tenant or free text.
- **Start red-team run** (`btn btn-primary md:btn-sm`) opens the dialog of 12.1; its confirm button sends
  `POST /api/red-team/runs`. While the request runs the button shows the spinner with `start.starting`. While a run is
  running the button is disabled, with `error.busy` referenced by `aria-describedby`.
- **Running.** Badge `state.running` (`badge-info`), `meta.started`, and `progress.label` (14px) above a
  `progress.progress.w-full` with `max` and `value` and an `aria-label`; without a known total, the spinner with
  `progress.unknown`. The panel polls `GET /api/red-team/runs/:id` every 5 seconds, pauses while
  `document.visibilityState` is `hidden` or the tab is not active, and stops after three failed reads in a row with
  `poll.stalled`. The status region announces the start and the end only, never each poll.
- **Finished.** Badge `state.finished` (`badge-success`), the three counts, and the table: one row per technique and
  language, sorted by technique label, then by language in the order the report gives. The technique cell is
  `th scope="row"`: its label (English data, `lang="en"` when the locale is not `en`) and, as a 12px second line, the id in
  `font-mono`. The language cell shows the name from `Intl.DisplayNames` and the code in `font-mono`. Succeeded: `0` is
  plain; a count above 0 is `font-semibold text-error` with `bi-shield-exclamation`. Success rate: a percentage with one
  decimal, never coloured. The last row `row.total` sums all rows. When no attack succeeded, `result.none` stands above
  the table with `bi-shield-check`.
- **Review cases.** `meta.cases` with the count and, while `#rag-administration-review` exists, `btn btn-link btn-sm px-0`
  `action.openQueue`, which scrolls that panel into view and focuses its heading. When the report says cases were skipped,
  `meta.casesSkipped` replaces the count.
- **Expert review off.** While the saved configuration (`window.currentConfig.RAG_DOMAIN_EXPERT_REVIEW`) is not `true`:
  `alert alert-info` with `bi-toggle-off` and `review.off`; the start control stays, and the dialog adds
  `confirm.start.reviewOff`.
- **Failed.** Badge `state.failed` (`badge-error`), `alert alert-error` with `run.failed` and the code in `font-mono`.
  "Start red-team run" is enabled again and is the retry.
- **Refresh status** (`btn btn-outline md:btn-sm`) reads the latest run again.
- **Never in this panel:** an attack's text, a question, an answer, a canary, an item id, a trace id, a tenant key, a file
  path. The panel renders counts, ids of techniques, language codes and states.

### 6.4 Rollouts panel (plan 07-49)

Operator admins only. Deployment-wide; it follows no workspace selector.

```
Rollouts                                                              h3
panel.description
[alert host]   sign-in | unavailable | off | warn.legacy
[New rollout]                                                         opens the form below it

┌ Embedding profile: profile-b ──────────────────────────────────── [Active] ┐   h4, card with a 4px left rule
│ Share of workspaces: 10%     Started: 18 Nov 2026     Days running: 7        │
│ Current for everyone else: profile-a                                         │
│ Workspaces on the candidate: 14     Workspaces on the current one: 126       │
│                                                                              │
│ Quality per language                                              h5         │
│ ready line                                                                   │
│ ┌──────────┬───────────────────────────┬───────────────┬─────────────────┬──────────────────┬───────────────┐
│ │ Language │ Measure                   │ Candidate now │ Same workspaces │ Other workspaces │ Result        │
│ │          │                           │               │ before          │ now              │               │
│ ├──────────┼───────────────────────────┼───────────────┼─────────────────┼──────────────────┼───────────────┤
│ │ Chinese  │ "Information not          │ 12.0%         │ 11.5%           │ 11.8%            │ [Holds]       │
│ │ zh       │  available" answers       │ n = 240       │ n = 260         │ n = 2,400        │               │
│ │ Chinese  │ Not-helpful votes         │ 8.3%  n = 36  │ 9.1%  n = 44    │ 8.8%  n = 410    │ [Holds]       │
│ │ Italian  │ "Information not …"       │ 19.4% n = 36  │ 11.1% n = 45    │ 11.9% n = 380    │ [Got worse]   │
│ └──────────┴───────────────────────────┴───────────────┴─────────────────┴──────────────────┴───────────────┘
│ table.help                                                         12px      │
│                                                                              │
│ Workspaces                                                        h5         │
│ Included: 2      o:0000…0001  [Exclude workspace]                            │
│ Excluded: 1      o:0000…0003  [Include workspace]                            │
│ Workspace key [ ............................ ]  [Include workspace] [Exclude workspace]
│                                                                              │
│ [Promote rollout]  [Roll back rollout]                                       │
└──────────────────────────────────────────────────────────────────────────────┘
Recent rollouts                                                       h4, table: What | Candidate | State | Ended
[status region]
```

#### 6.4.1 List and cards

- `GET /api/rag/admin/rollouts`. Active rollouts render as cards (`div.border-l-4.border-base-300.rounded-lg.p-4`), at
  most one per kind, in the order embedding profile, chunking profile, rebuild. Rollouts that ended render as rows of
  "Recent rollouts" (kind, candidate in `font-mono`, state badge, `<time>`), newest first; the block is absent when there
  is none.
- **Card heading** `card.heading` (kind label, then the candidate id in `font-mono`), with the state badge `state.active`
  (`badge-info`) at the end of the line.
- **Meta lines** (14px, wrap): `card.mode.tenants` or `card.mode.share`; `card.started`; `card.days` (whole days since the
  start, computed in the browser); `card.incumbent`; `arm.candidate` and `arm.incumbent` with the counts.
- **Notes.** `note.chunkingExternal` (12px) on a chunking-profile card while the saved `RAG_RETRIEVAL_BACKEND` is `weaviate`
  or `qdrant`. `warn.legacy` (`alert alert-warning`, alert host) while the saved `RAG_PIPELINE` is `legacy`.

#### 6.4.2 Per-language comparison

- One row per language and measure the route returns. Language cell: `th scope="row"`, the name from `Intl.DisplayNames`
  and the code in `font-mono`; `lang.und` for `und`. Measure: `measure.refusal_rate`, `measure.not_helpful_rate`,
  `measure.judge_score`; an unknown measure shows its code in `font-mono`.
- Three value cells: the candidate workspaces now, the same workspaces in the equally long period before the rollout
  started, and the other workspaces now. A rate is a percentage with one decimal; a judge score has two decimals; under
  it, 12px, `cell.n` with the sample size. A cell without data shows `cell.none`. No value is coloured, no arrow is drawn.
- **Result** is the server's verdict for that language and measure, as a `badge badge-sm badge-outline` with an icon and a
  word: `result.holds` (`badge-success`, `bi-check-circle`), `result.worse` (`badge-error`, `bi-arrow-down-circle`),
  `result.insufficient` (`badge-warning`, `bi-hourglass-split`), `result.unmeasured` (`badge-ghost`, `bi-dash-circle`).
- **Ready line** above the table (14px, with an icon): `ready.all` when every language the route lists passes;
  `ready.blocked` when at least one language is worse or has too little data; `ready.noData` when the route returns no
  row. The line describes the table only; the observation period is checked by the server at promotion.
- The table sits in a focusable scroll region and has a visually hidden caption `table.caption` with the candidate id.
  `table.help` stands under it.

#### 6.4.3 Workspaces of a rollout

- **Included** and **Excluded** lists (`ul`, each key in `font-mono text-xs break-all`; when `#workspace-selector` has an
  option for the id, its name follows as plain text). Each included row has "Exclude workspace", each excluded row
  "Include workspace" (`btn btn-outline md:btn-sm`, accessible name with the key). Counts as `tenants.included` and
  `tenants.excluded`. Lists longer than 20 show 20 and `btn btn-ghost btn-sm` `tenants.showAll`.
- **By key.** One input `rollouts-tenant-key-<kind>` labelled `tenant.key` (`font-mono`, `autocomplete="off"`, `spellcheck="false"`,
  `autocapitalize="off"`, `translate="no"`) with the help `tenant.keyHelp` and the two buttons. On `change` the field
  lower-cases its value. A value that is not `s:default`, or `o:` or `u:` followed by a UUID, gets `tenant.keyInvalid` at
  the field and nothing is sent. Workspaces that a share selected are not listed (the route returns counts only); they
  are excluded by key.
- Include and exclude each open the dialog of 12.1, then send `POST /api/rag/admin/rollouts` with the action. Success
  announces `include.done` or `exclude.done` and reloads the card.

#### 6.4.4 Promote and roll back

- **Promote rollout** (`btn btn-primary md:btn-sm`) and **Roll back rollout** (`btn btn-outline md:btn-sm`) each open the
  dialog of 12.1. Neither is styled as destructive: nothing is deleted, and a promoted profile can be rolled back in its
  own panel.
- Promote is **never disabled by the table**: the server decides, and a refusal changes nothing. After confirm, the
  dialog's buttons are disabled and the confirm button shows the spinner with `promote.running`; the dialog closes when
  the answer arrives.
- **Promoted:** the card leaves, the rollout appears under "Recent rollouts" with `state.promoted`, the status region
  announces `promote.done`.
- **Refused:** the card stays; one `alert alert-warning` inside the card, above the action buttons, with the sentence for
  the refusal (8.4): observation too short, not enough data in a language, a language got worse, or activation refused.
  The status region repeats it. The list reloads, so the table shows the numbers the refusal was decided on.
- **Rolled back:** the card leaves, the row shows `state.rolled_back`, the status region announces `rollback.done`.

#### 6.4.5 New rollout

"New rollout" (`btn btn-outline md:btn-sm`, `aria-expanded`) opens the form under it; "Close form" closes it and returns
focus to the button.

| Field | Control | Rules |
|-------|---------|-------|
| `form.kind` | `select#rollouts-form-kind` with `kind.embedding_profile`, `kind.chunking_profile`, `kind.rebuild_run` | A kind with an active rollout is disabled, with `form.kindBusy` under the select |
| `form.candidate` | `input#rollouts-form-candidate` (`font-mono`, `maxlength="128"`, `autocomplete="off"`, `spellcheck="false"`, `translate="no"`) | Help `form.candidateHelp.<kind>`. Required |
| `form.mode` | `fieldset` with `legend` and two radios, `mode.tenants` (default) and `mode.share` | Shows the matching field below |
| `form.tenants` | `textarea#rollouts-form-tenants` (`font-mono`, 3 rows) | One key per line, lower-cased on `change`; each line validated as in 6.4.3; at least one. Help `form.tenantsHelp` |
| `form.share` | `input#rollouts-form-share[type=number]` (`min="1" max="100" step="1"`, `inputmode="numeric"`) | Whole number 1 to 100. Help `form.shareHelp` |

"Start rollout" (`btn btn-primary md:btn-sm`) stays enabled; with invalid input it marks the fields
(`aria-invalid="true"`, message wired by `aria-describedby`), moves focus to the first and sends nothing. With valid input it
opens the dialog of 12.1. 201: `start.done`, the form closes, the list reloads. A refusal shows the sentence of 8.4 at the
form; the form keeps its values.

### 6.5 Languages panel: adding and removing a language (plan 07-52)

No new interface. The panel, its table, its notes, its findings area and the impact dialog are those of 03.2-UI-SPEC 6.2
and 6.4.1. This section adds states and copy; the keys join `LANGUAGES_LABELS` in `en`, `zh` and `it` (12.5).

| Case | What the panel does |
|------|---------------------|
| **Language added, refused for a missing baseline** (`POST /api/config/languages` answers 400 with `language_baseline_missing`) | The findings alert (`alert alert-error`) lists the server's codes in the server's order, one sentence each; the new sentence is `error.language_baseline_missing`, with `{language}` filled and `{command}` rendered as `code.font-mono.text-xs.break-all` holding `npm run rag:languages -- baseline <code>` with the real code. The selection is kept, nothing is saved, the status region repeats the first sentence |
| **Language marked as lacking a baseline in the list** (only when the list route reports it; section 15 item 11) | Its row has a disabled checkbox and the 12px line `blocked.baseline` with the same command, like the `blocked.*` lines of 03.2 |
| **Language added, accepted** | Before the save, the impact dialog of 03.2 6.4.1 opens in its language form: title `add.title`; a three-row table with the groups `add.group.und`, `add.group.scanned`, `add.group.stale` and the count of each, then the total row `add.total`; `add.note` in place of `impact.warning`; the dialog's own buttons. With a total of 0 no dialog opens. After the save: `save.added` (or `save.addedNone`) in the status region, and the same sentence as `alert alert-info` in the findings area until the next change |
| **Language removed only** | No impact dialog and no rebuild offer. While unsaved, the existing `note.removed` shows. After the save: `save.removed` in the status region and as `alert alert-info` in the findings area until the next change. The row stays in the table, unchecked, with its document count |
| **Added and removed in one save** | The addition rules for the added languages, then one `save.removed` sentence per removed language |

Rules:
- The three group labels and the dialog title belong to `LANGUAGES_LABELS` and are handed to the dialog by `languages.js`.
  A group code the table does not know is shown in `font-mono`.
- Sentences for several languages are one sentence per language, never a joined list, so no string needs a plural form.
- `save.added` names the place where the rebuild is started ("RAG administration, Ingestion changes"); saving starts
  nothing.
- No sentence promises a deletion, and none uses "remove documents": removal changes detection and translation only.

### 6.6 Primary visual anchor of each view

| View | Anchor | How it is the anchor |
|------|--------|----------------------|
| RAG pipeline settings | The setting row's control column | The only bordered controls on the section; labels, env names and default lines are quieter |
| Vector backends card | The warnings alert, when present; otherwise the backend select | The only tinted block of the section; without it, the first row |
| Red-team runs | "Start red-team run" | The panel's only solid primary button; once a run exists, the Succeeded column carries the only coloured numbers |
| Rollout card | "Promote rollout" | The card's only solid primary button, placed directly under the comparison it depends on |
| New rollout form | "Start rollout" | The form's only solid primary button |
| Languages | "Save languages" (03.2) | Unchanged |

---

## 7. State matrix

Every row is required. "Status region" is the surface's `div[role=status][aria-live=polite].text-sm`; an error in it gets
`text-error` and a leading `bi-exclamation-circle`. "Alert host" is the block under the description.

### 7.1 States every data view of this phase has

| State | What the admin sees |
|-------|---------------------|
| First load | A `loading-sm` spinner with the view's loading text in the content host; status region the same |
| Refresh with content present | Content stays, gets `opacity-60` and `aria-busy="true"`; the reload button shows a spinner and is disabled; no layout jump |
| 401 or 403 | One `alert alert-warning` with `bi-person-lock`, the shared sign-in sentence with the main app's address and a reload button. No password field, no token prompt |
| 5xx, thrown or timeout | `alert alert-error` with the view's unavailable sentence and a reload button; content from an earlier load stays visible, dimmed |
| Action running | The acting button shows a spinner with its in-flight text; the block's other buttons are disabled |
| Action done | The status region announces the outcome; the view reloads |
| No answer to a change | The view's "outcome unknown" sentence; the view reloads so the stored state is shown |
| Unknown code, state, kind, technique, measure or language | The code in `font-mono` inside a full sentence or cell; never a bare code in a sentence, never a crash |

### 7.2 RAG pipeline settings

| State | What is shown |
|-------|---------------|
| Loading the manifest | Spinner with `load.loading`; no jump buttons |
| Manifest failed (network, 4xx, 5xx, unreadable body) | `alert alert-error` with `load.failed` and `btn btn-sm` "Reload settings". No rows. Settings stay editable in `.env.local`, and the sentence says so |
| Manifest has no managed entry | `alert alert-error` with `load.empty` and "Reload settings" |
| Loaded, all at defaults | Every group card; no "Changed" badge; no count on the jump buttons |
| Loaded, some changed | "Changed" on those rows; `nav.changed` on their groups |
| Requirement unmet | The hint; the control disabled unless it is a URL or a secret |
| Hosted setting | Read-only row with the saved value and "Show setting" |
| Hosted setting without an editor yet | `row.hostedNoEditor` after the first press of "Show setting" |
| Unknown type | Read-only row with `row.unknownType` |
| Secret stored, not stored, typed, replaced | `secret.setLast4` or `secret.set`; `secret.unset`; `secret.pending`; field emptied and `secret.replaced` announced |
| Saving, saved, save failed | The page's existing indicator and toast; the section adds only the secret announcement |
| Admin-backed parts: loading | Spinner with `sync.loading` in the sync block; setting rows usable |
| Admin-backed parts: 401 or 403 | Sign-in alert in the alert host with `admin.note` as its second line and "Reload status". The sync block shows `admin.note`; switches and Test connection buttons stay but answer with the sign-in sentence |
| Admin-backed parts: unavailable | `admin.unavailable` in the sync block with "Reload status"; setting rows usable |
| No warning | No alert; `compat.ok` |
| One or more warnings | The alert with one item per warning; `nav.warnings` on the jump button |
| Sync off, on, turning on, turning off | Switch and word; in-flight line; outcome announced |
| Sync switch refused or unanswered | `sync.refused` with the code, or `sync.unknown`; the switch shows the reloaded state |
| No index state yet | `sync.noState` |
| Test: idle, running, connected, failed, no probe | Button only; spinner with `test.running`; `test.ok`; `test.fail.<code>`; `test.none` |
| `.env.local` newer than the running app | `loaded.changed` in the alert host |

### 7.3 Red-team runs

| State | What is shown |
|-------|---------------|
| No run yet | Centred block (`py-8`): `empty.title` (16px) and `empty.body` (14px) under the start control |
| Idle with a last run | The start control; "Latest run" with that run's state, counts and table |
| Starting | Spinner with `start.starting` on the confirm button |
| Running | Start disabled; badge, start time, progress; status region announced `run.started` once |
| Finished, with successes | Badge, counts, table, review cases line |
| Finished, no success | `result.none` above the table |
| Finished, cases skipped | `meta.casesSkipped` |
| Failed | `run.failed` with the code; start enabled |
| Expert review off | `review.off` alert; the dialog adds `confirm.start.reviewOff` |
| 401 | Shared sign-in sentence; no run data |
| 403 | `error.adminOnly`; no run data |
| 409 on start | `error.busy`; the panel loads the running run |
| 400 on start | `error.config` at the select |
| 503, app unreachable | `error.unavailable`; nothing was started |
| No answer to start | `error.outcomeUnknown`; the panel reloads the latest run |
| Run no longer on disk (404 on status) | `error.gone`; the panel returns to "No run yet" |
| Polling failed three times | `poll.stalled` with "Refresh status" |

### 7.4 Rollouts

| State | What is shown |
|-------|---------------|
| Switched off (404 on the list) | `alert alert-info` with `bi-toggle-off`: `off.title` and `off.body` with the env name in `code`. No button, no form, no table |
| No rollout, none recent | Centred block: `empty.title` and `empty.body`; "New rollout" above it |
| Active rollouts | One card each |
| No per-language data yet | `ready.noData`; no table |
| Language with too little data | `result.insufficient`; `ready.blocked` |
| Language got worse | `result.worse`; `ready.blocked` |
| Every language holds | `ready.all` |
| Pipeline is legacy | `warn.legacy` in the alert host; cards and actions stay |
| Form closed, open, invalid, submitting | Button; form; marked fields; spinner with `start.running` |
| Start refused | The sentence of 8.4 at the form |
| Include, exclude, promote, roll back: running | Spinner in the dialog's confirm button; both dialog buttons disabled |
| Promote refused | Warning alert in the card |
| Promoted, rolled back | Card leaves; row under "Recent rollouts"; outcome announced |
| No answer to a change | `error.outcomeUnknown`; the list reloads |

### 7.5 Languages additions

| State | What is shown |
|-------|---------------|
| Baseline missing (400) | `error.language_baseline_missing` in the findings alert, with the command |
| Baseline missing, known from the list | Disabled checkbox with `blocked.baseline` |
| Addition with documents to reprocess | Impact dialog in its language form with three groups and the total |
| Addition with nothing to reprocess | No dialog; `save.addedNone` |
| Removal | No dialog; `note.removed` while unsaved; `save.removed` after the save |

---

## 8. Data and errors

### 8.1 What each view reads

| View | Call | Fields rendered |
|------|------|-----------------|
| Settings rows | `GET /api/rag-pipeline/manifest` (config server) | Per entry: name, group, label, type, options, requires, default, provider, help; value (non-secret); hint state and last4 (secret); the file's modification time |
| Warnings, sync, state | `GET /api/rag/admin/index-compat`, `GET /api/rag/admin/vector-sync/targets` | `warnings[].code`, `.backend`, numbers of `.detail`; per target: enabled, pending, leased, dead, oldest pending age, per-profile state counts; `envLoadedAt` |
| Sync switch | `PUT /api/rag/admin/vector-sync/targets` with `{ target, enabled }` | `enabled`, `tenantsEnqueued` |
| Test connection | `POST /api/rag/admin/providers/test` with `{ provider }` | `ok`, `latencyMs`, `code`. `message` is used only as the English fallback for a code the table lacks |
| Red-team | `GET /api/red-team/runs`, `POST /api/red-team/runs`, `GET /api/red-team/runs/:id` (config server) | Run id (kept in memory, not shown), state, start and end time, progress done and total, cells (technique id and label, language, attacks, successes), review cases opened, skipped reason, error code; run configuration names |
| Rollouts | `GET` and `POST /api/rag/admin/rollouts` | Per rollout: id (kept, not shown), kind, candidate, incumbent, mode, share, state, created and ended, arm sizes, included and excluded keys, per-language rows (language, measure, three values with sample sizes, verdict); on promote: `ok` and the refusal code |
| Languages | The Phase 3.2 routes; `POST /api/config/languages` | The ordered error codes; the `language_add` counts by group |

Views render named fields only, through builder functions, never by iterating an object's keys.

### 8.2 Shared sentences

`error.signIn`, `error.network` and `error.generic` come from the shared table through `window.ingestLabel(key, locale, vars)`,
with `{appUrl}` filled from `window.getConfiguredMyRAGAppUrl()` or `window.location.origin`; the placeholder never reaches
the screen. When `ingestLabel` is missing, fall back to `authMessage(status)`. All other keys are in the files' own tables.

### 8.3 Settings section: error and code mapping

| Status | Code | Where | Key and behaviour |
|--------|------|-------|-------------------|
| thrown, timeout, not 200 | n/a | manifest | `load.failed` |
| 200 with no managed entry | n/a | manifest | `load.empty` |
| 401, 403 | any | index-compat, targets, test | Shared `error.signIn`; alert host shows it with `admin.note` |
| 5xx, thrown, timeout | any | index-compat, targets (GET) | `admin.unavailable` |
| thrown, timeout | n/a | targets (PUT) | `sync.unknown`, then reload the status |
| 400, 500 | any | targets (PUT) | `sync.refused` with the status or code in `font-mono`, then reload |
| 200 | `ok: true` | test | `test.ok` |
| 200 | `not_configured`, `unauthorized`, `timeout`, `unreachable`, `collection_missing` | test | `test.fail.<code>` |
| 200 | other | test | `test.fail.other` with the code |
| 400 | any | test | `test.fail.other` with `invalid_request` |
| 5xx, thrown, timeout | any | test | `admin.unavailable` as the result line |

Warning codes and their sentences: `backend_not_ready`, `dimension_mismatch`, `legacy_pipeline`, `sync_not_enabled`,
`dead_letters`, `backend_unreachable`; any other code uses `compat.other`.

### 8.4 Red-team and rollouts: error and code mapping

| Status | Code | Where | Key and behaviour |
|--------|------|-------|-------------------|
| 401 | any | red-team start | Shared `error.signIn` |
| 403 | any | red-team start | `error.adminOnly` |
| 409 | any | red-team start | `error.busy`; load the running run |
| 400 | any | red-team start | `error.config` |
| 503, 5xx | any | red-team start | `error.unavailable` |
| thrown, timeout | n/a | red-team start | `error.outcomeUnknown`; reload |
| 404 | any | red-team status | `error.gone` |
| thrown, timeout, 5xx | n/a | red-team status, three times | `poll.stalled` |
| run state `failed` | the run's error code | red-team status | `run.failed` with the code |
| 404 | any | rollouts list | `off.title`, `off.body` |
| 401, 403 | any | rollouts | Shared `error.signIn`; content replaced |
| 503, 5xx | any | rollouts list | `list.unavailable` |
| 400 | tenant key | include, exclude, start | `tenant.keyInvalid` at the field |
| 400 | other, with `details[0]` | start | `start.invalid` with the detail's message, at the named field when `details[0].path` matches one |
| 409 | an active rollout of the kind exists | start | `start.exists` |
| 409, 400 | any other reason | start | `start.refused` with the reason in `font-mono` |
| refusal | `rollout_observation_too_short` | promote | `promote.refused.observation` |
| refusal | `rollout_monitoring_insufficient:<lang>` | promote | `promote.refused.insufficient` with the language's name |
| refusal | `rollout_language_drop:<lang>:<metric>` | promote | `promote.refused.drop` with the language's name and the measure's label |
| refusal | `external_not_ready:<backend>` | promote | `promote.refused.external` with the backend's brand name |
| refusal | any other | promote | `promote.refused.other` with the reason in `font-mono` |
| 404 | any | include, exclude, promote, roll back | `error.changed`; reload |
| thrown, timeout | n/a | any change | `error.outcomeUnknown`; reload |
| other | any | any | Shared `error.generic` with the status code |

A promote answer is a refusal when its body says `ok: false` or the status is 409; the refusal code is read from the
body. The part of a code after a colon is a language code, a measure or a backend id and is shown by its name; an unknown
part is shown in `font-mono`.

---

## 9. Keyboard, screen reader and focus

1. **Tab order of a setting row:** the control, the reveal button of a secret, then the row's link button. Help, hint and
   meta lines are text.
2. **Labels.** Every control has a visible `<label for>`. Radio groups are `fieldset` with `legend`. Help, hint, meta and
   error lines are wired with `aria-describedby`; invalid fields carry `aria-invalid="true"`.
3. **Toggles.** A bool setting is a checkbox the browser announces as checked or not; the visible "On" or "Off" is
   `aria-hidden`. A sync switch is a checkbox with `role="switch"`, so its checked state is announced as on or off;
   Space opens its dialog, and the state changes only after the server answered.
4. **Disabled by a requirement.** The reason is on screen and referenced by `aria-describedby`; it never lives in a
   tooltip.
5. **Buttons are not disabled to signal missing input.** "Start rollout", "Include workspace" and "Exclude workspace" stay
   enabled; with invalid input they mark the fields and move focus to the first. Buttons are disabled only while a
   request runs, and "Start red-team run" while a run is running (reason referenced by `aria-describedby`).
6. **Dialogs.** Native `<dialog class="modal">` with `showModal()`, `aria-labelledby` and `aria-describedby`. Focus starts on
   the button that backs out. Escape and the backdrop cancel; while a request runs they do nothing. On close, focus
   returns to the opening control, or to the status region when that control is gone.
7. **Live regions.** One polite status region per surface. Announced: load finished with a count, action outcomes, test
   results, run start and end. A refused promote and a refused start are `role="alert"`, because they answer an action
   just taken. Progress of a run is never announced per poll; the `progress` element carries the numbers.
8. **Tables.** A visually hidden `caption`, `th scope="col"`, the first cell of each row as `th scope="row"`. Each sits in
   `div.overflow-x-auto[tabindex=0][role=region][aria-label]`.
9. **Jump buttons and link buttons move focus** to a heading with `tabindex="-1"`; headings show the focus outline of
   6.1.
10. **Not colour alone.** Every state, verdict, changed value and count that matters has a word or an icon as well.
11. **Focus visibility.** DaisyUI's `focus-visible` outline on every control; headings add
    `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2`. Never `outline: none` without a
    replacement.
12. **Motion.** DaisyUI's spinner and its toggle transition only. Under `prefers-reduced-motion: reduce` spinners hide and
    their text remains. Nothing slides, fades in or pulses; rows, alerts and cards appear in place. Scrolling to a group
    is instant.
13. **Zoom and text size.** At 200% zoom nothing clips: no fixed heights; rows stack, button rows and meta lines wrap.
14. **Language.** `lang` on each script-built root; English manifest text and technique labels carry `lang="en"` in other
    locales; on-screen English names of tabs and cards inside a localized sentence are wrapped in `lang="en"`.

---

## 10. Responsive behaviour

| Width | Settings section | Red-team and Rollouts |
|-------|------------------|-----------------------|
| 1024px and up | Two-column rows (2 to 3); all table columns | All table columns; the rollout form's fields at `max-w-md` |
| 768 to 1023px | Two-column rows; the state table scrolls inside its region when needed | The comparison table hides "Other workspaces now"; the value stays reachable at 1024px and is not needed for the verdict |
| below 768px | Rows stack: label and env name, then the control at 48px; jump buttons wrap; provider blocks keep their left rule | Row actions are 48px and stack; the attack table shows Technique, Succeeded and Attacks, with the language as a 12px line under the technique and the rate under the count; the comparison shows Language, Measure, Candidate now and Result |
| 360px | Tested width: no sideways page scroll outside the table regions; env names, keys and ids break (`break-all`); dialogs fit the default `modal-box` | Same |

The existing breakpoints of the page (Tailwind `md` 768px, `lg` 1024px) are used. The sidebar and drawer do not change.

---

## 11. What must never be shown or done

1. **Secrets.** No stored secret value, and no part of one longer than the last four characters the server sends, is ever
   in the DOM, in an attribute, in storage or in the console. A typed secret lives only in its password field and in
   `configManager.config` until the save, and is cleared after it. The section never logs a config object.
2. **Addresses.** A test result never shows a URL, a host or a port. The UI does not add the configured URL to a result.
3. **Text from files and servers is inert.** Manifest labels and help, technique labels, codes, candidate ids and tenant
   keys are inserted with `textContent`. Never `innerHTML`, never a template string that becomes markup, never an `href`
   or `title` built from them. Tests stub each with `<img src=x onerror=alert(1)>` and a `<script>` tag and assert that
   no element is created.
4. **Never rendered, even when a response carries it:** a rollout's salt, actor ids, a rollout or run id as visible text,
   trace ids, item ids of the attack corpus, corpus or config hashes, tenant keys in the settings section, any question,
   answer, passage or attack text.
5. **No control invents a value.** A secret has no default, no sample and no generator button. A URL field has no
   prefilled vendor address beyond the manifest default.
6. **No request carries what the server must decide:** the browser never sends a provider URL or key to the test route,
   never a tenant or a path to the red-team route, never an arm or a salt to the rollouts route.
7. **No `Authorization` header, no token in browser storage, no second sign-in form.**
8. **No domain content in product copy.** Labels, help lines, placeholders, empty states, mock values and test fixtures use
   neutral wording ("profile-a", "workspace-a", "Language A", "example.org"); nothing names a business domain, a
   customer document type or an example question (REQUIREMENTS.md, domain neutrality).
9. **Not in these surfaces:** editing the attack corpus, viewing an attack, deleting a run, changing a rollout's share,
   removing a stored secret, deleting an external collection, starting a reconcile or a rebuild.

---

## 12. Copywriting Contract

Voice: plain verbs, sentence case, names from the operator's side of the screen. A message that reports a problem says
what happened and what to do next; errors do not apologize. One action keeps one name through its flow: the button, the
dialog's confirm button and the outcome message say "Promote rollout", "Promote rollout", "Promoted".

**Casing.** Sentence case, as every sibling Config UI panel; plan 04-36 recorded this against the Title Case rule of
web-design-guidelines as "intentional per the approved UI-SPEC, not a defect", and the UI plans of this phase record it
the same way. Chinese and Italian have no Title Case.

**Words used, and words avoided.** "Workspace" for a tenant; "workspace key" only where one is typed or listed.
"Vector backend" for pgvector, Weaviate and Qdrant; "sync" for the copy to an external one. "Waiting", "in progress",
"failed permanently" for pending, leased and dead; "out of date" for stale. "Stored" for a secret that is set. "Candidate"
and "current" for the two sides of a rollout; "arm", "incumbent", "cohort" and "bucket" are not shown. "Share of
workspaces", never "traffic share": a workspace is wholly on one side. "Promote" for full activation. "Attack",
"technique", "succeeded"; "ASR" is not shown. "Review case" as in the Review queue. "Baseline" for the recorded result of
a language. "Passage" for a chunk.

**Action labels are verb + noun in every locale.** Accessible names extend the visible label and start with the same verb
("Exclude workspace: o:…", "Test connection: Qdrant"). In-flight text ("Testing…") is status on a disabled button. No
button is labelled "Cancel", "OK", "Submit" or "Close" alone: a button that backs out says what stays ("Keep sync off",
"Keep rollout running") or what it closes ("Close form", "Close without starting").

**Counts are written as "label: number"** ("Waiting: 3", "Changed: 2"), so no string needs a plural form.

**Where the strings live.** One `{ en, zh, it }` table per file (`RAG_PIPELINE_LABELS`, `RED_TEAM_LABELS`, `ROLLOUTS_LABELS`,
additions to `LANGUAGES_LABELS`), read through one function per file that fills `{placeholders}` and falls back to
English. A placeholder shown as `{command}`, `{variable}`, `{code}`, `{tenant}`, `{candidate}` or `{last4}` is replaced by a
`code` or `font-mono` element, not by text. Manifest labels, manifest help and technique labels are English data from
their files. Numbers use `Intl.NumberFormat(locale)`; percentages one decimal; dates
`Intl.DateTimeFormat(locale, { dateStyle: 'medium' })`, with `timeStyle: 'short'` for run and test times. Copy uses curly
apostrophes and quotation marks and the single-character ellipsis. Brand names, env names and commands are never
translated. A key that section 6 does not name is a label whose English text stands in the sketches there: titles,
column headers, button labels, dialog titles and dialog buttons.

### 12.1 Summary table

| Element | Copy (en) |
|---------|-----------|
| Primary CTA | Settings: none (changes save automatically); per provider "Test connection". Red-team: "Start red-team run". Rollouts: "Promote rollout" on a card, "Start rollout" in the form. Languages: "Save languages" (03.2) |
| Empty state heading | Red-team: "No red-team run yet". Rollouts: "No rollout in progress" |
| Empty state body | Red-team: "Select Start red-team run to replay the attack set. The results appear here." Rollouts: "Start one to try a new profile or rebuild on a few workspaces before everyone gets it. The candidate must already be built." |
| Error state | Settings: "The settings could not be loaded from the Config UI server. Check that it is running, then select Reload settings. Until then, edit .env.local by hand." Admin-backed parts: "Connection tests, sync status and warnings are unavailable right now. Check that the main app is running, then select Reload status." Rollouts: "Rollouts are unavailable right now. Select Reload panel in a moment." Red-team: "The red-team run failed ({code}). Check the Config UI server’s log, then select Start red-team run to try again." |
| Destructive confirmation | **None.** No action of this phase deletes data: a sync switch stops or starts copying, a rollback and an exclusion move pointers, removing a language changes the query side only. No `btn-error` is used |
| Consequential confirmations (primary colour, default focus on the button that backs out) | **Turn on sync:** "Turn on sync to {backend}?" / `confirm.syncOn.body` / "Keep sync off", "Turn on sync". **Turn off sync:** "Turn off sync to {backend}?" / `confirm.syncOff.body` / "Keep sync on", "Turn off sync". **Start red-team run:** "Start a red-team run?" / `confirm.start.body` / "Close without starting", "Start red-team run". **Start rollout:** "Start this rollout?" / `confirm.start.bodyTenants` or `confirm.start.bodyShare` / "Close without starting", "Start rollout". **Include workspace**, **Exclude workspace:** title with the key / body / "Keep workspace as it is", the action. **Roll back rollout:** "Roll back this rollout?" / `confirm.rollback.body` / "Keep rollout running", "Roll back rollout". **Promote rollout:** "Promote {candidate} to every workspace?" / `confirm.promote.body` / "Keep rollout running", "Promote rollout" |
| No dialog | Changing a setting, typing a secret, Test connection, Reload status, Refresh status, opening a form, showing a setting; saving languages beyond the impact dialog of 03.2 |

### 12.2 RAG pipeline settings (`RAG_PIPELINE_LABELS`)

| Key | en | zh | it |
|-----|----|----|----|
| `section.title` | RAG pipeline settings | RAG 流程设置 | Impostazioni della pipeline RAG |
| `section.description` | Every switch and provider of the knowledge-base pipeline, grouped by layer. Changes save to .env.local automatically; the app uses them after it restarts. | 知识库流程的全部开关和服务商，按层分组。更改会自动保存到 .env.local，应用重启后生效。 | Tutti gli interruttori e i provider della pipeline della knowledge base, raggruppati per livello. Le modifiche vengono salvate automaticamente in .env.local; l’app le usa dopo il riavvio. |
| `section.secretsNote` | Stored keys and secrets are never shown: only whether one is stored and, for long values, its last four characters. Leave a field empty to keep the stored value. To remove one, delete its line in .env.local. | 已保存的密钥不会显示，只显示是否已保存，以及较长密钥的末四位。字段留空表示保持不变。如需删除，请在 .env.local 中删除对应的行。 | Chiavi e segreti salvati non vengono mai mostrati: si vede solo se sono salvati e, per i valori lunghi, gli ultimi quattro caratteri. Lascia vuoto un campo per mantenere il valore salvato. Per rimuoverlo, elimina la sua riga in .env.local. |
| `load.loading` | Loading settings… | 正在加载设置… | Caricamento delle impostazioni… |
| `load.failed` | The settings could not be loaded from the Config UI server. Check that it is running, then select Reload settings. Until then, edit .env.local by hand. | 无法从 Config UI 服务器加载设置。请确认它正在运行，然后选择“重新加载设置”。在此之前，可以手动编辑 .env.local。 | Non è stato possibile caricare le impostazioni dal server della Config UI. Verifica che sia in esecuzione, poi seleziona Ricarica impostazioni. Nel frattempo, modifica .env.local a mano. |
| `load.empty` | The settings list is empty. Check scripts/rag/env-manifest.json, then select Reload settings. | 设置列表为空。请检查 scripts/rag/env-manifest.json，然后选择“重新加载设置”。 | L’elenco delle impostazioni è vuoto. Controlla scripts/rag/env-manifest.json, poi seleziona Ricarica impostazioni. |
| `action.reload` | Reload settings | 重新加载设置 | Ricarica impostazioni |
| `action.reloadStatus` | Reload status | 重新加载状态 | Ricarica lo stato |
| `nav.label` | Setting groups | 设置分组 | Gruppi di impostazioni |
| `nav.changed` | Changed: {count} | 已更改：{count} | Modificate: {count} |
| `nav.warnings` | Warnings: {count} | 警告：{count} | Avvisi: {count} |
| `group.data.title` | Documents and ingestion | 文档与入库 | Documenti e acquisizione |
| `group.data.description` | How uploads are parsed, chunked, checked and embedded. | 上传的文档如何解析、切块、检查并生成向量。 | Come i caricamenti vengono analizzati, suddivisi, controllati e trasformati in vettori. |
| `group.query.title` | Query | 查询 | Query |
| `group.query.description` | How a question is rewritten, expanded and cached before retrieval. | 检索之前如何改写、扩展和缓存问题。 | Come una domanda viene riscritta, ampliata e messa in cache prima del recupero. |
| `group.retrieval.title` | Retrieval | 检索 | Recupero |
| `group.retrieval.description` | Which pipeline runs and how candidates are searched. | 运行哪条流程，以及如何搜索候选内容。 | Quale pipeline viene eseguita e come vengono cercati i candidati. |
| `group.ranking.title` | Reranking and context | 重排与上下文 | Riordinamento e contesto |
| `group.ranking.description` | How candidates are reordered, when an answer is refused, and how context is assembled. | 候选内容如何重排、何时拒答，以及如何组装上下文。 | Come i candidati vengono riordinati, quando una risposta viene rifiutata e come si compone il contesto. |
| `group.generation.title` | Answers and citations | 回答与引用 | Risposte e citazioni |
| `group.generation.description` | Citations, groundedness checks and answer feedback. | 引用、依据核查和回答反馈。 | Citazioni, verifica rispetto alle fonti e feedback sulle risposte. |
| `group.evaluation.title` | Evaluation | 评估 | Valutazione |
| `group.evaluation.description` | The evaluation endpoint and who may use it. | 评估接口及其访问权限。 | L’endpoint di valutazione e chi può usarlo. |
| `group.backends.title` | Vector backends | 向量后端 | Backend vettoriali |
| `group.backends.description` | Where retrieval searches: pgvector in Supabase, or a synced copy in Weaviate or Qdrant. Supabase stays the source of every answer’s text. | 检索在哪里搜索：Supabase 中的 pgvector，或同步到 Weaviate、Qdrant 的副本。回答中的文字始终来自 Supabase。 | Dove cerca il recupero: pgvector in Supabase, oppure una copia sincronizzata in Weaviate o Qdrant. Il testo di ogni risposta proviene sempre da Supabase. |
| `group.security.title` | Security | 安全 | Sicurezza |
| `group.security.description` | Prompt-injection checks and limits on what untrusted content can do. | 提示注入检查，以及对不可信内容的限制。 | Controlli contro la prompt injection e limiti a ciò che i contenuti non attendibili possono fare. |
| `group.observability.title` | Tracing and monitoring | 追踪与监控 | Tracciamento e monitoraggio |
| `group.observability.description` | Traces, sampling and monitoring of answers. | 调用追踪、采样和回答监控。 | Tracce, campionamento e monitoraggio delle risposte. |
| `group.sidecar.title` | Sidecar | Sidecar 服务 | Sidecar |
| `group.sidecar.description` | The Python service that parses documents and scores answers. | 负责解析文档和给回答打分的 Python 服务。 | Il servizio Python che analizza i documenti e valuta le risposte. |
| `group.unknown.description` | This page does not know this group yet. Its settings work as usual. | 此页面尚不认识这个分组，其中的设置可以照常使用。 | Questa pagina non conosce ancora questo gruppo. Le sue impostazioni funzionano normalmente. |
| `provider.sidecar` | Sidecar | Sidecar 服务 | Sidecar |
| `provider.judge` | Judge model | 评审模型 | Modello giudice |
| `provider.promptGuard` | Prompt Guard model host | Prompt Guard 模型主机 | Host del modello Prompt Guard |
| `row.default` | Default: {value} | 默认值：{value} | Predefinito: {value} |
| `row.defaultEmpty` | Default: empty | 默认值：空 | Predefinito: vuoto |
| `row.changed` | Changed | 已更改 | Modificata |
| `value.on` | On | 开 | Attivo |
| `value.off` | Off | 关 | Disattivo |
| `enum.unset` | Not set | 未设置 | Non impostato |
| `row.requires` | Used only when {setting} is {value}. | 仅在“{setting}”为 {value} 时使用。 | Usata solo quando {setting} è {value}. |
| `row.requiresOn` | Used only when {setting} is on. | 仅在“{setting}”开启时使用。 | Usata solo quando {setting} è attiva. |
| `row.hostedValue` | Current value: {value} | 当前值：{value} | Valore attuale: {value} |
| `row.hostedUnset` | Current value: not set | 当前值：未设置 | Valore attuale: non impostato |
| `row.hosted` | Edited under {tab}. | 请在“{tab}”中修改。 | Si modifica in {tab}. |
| `action.showSetting` | Show setting | 显示此设置 | Mostra impostazione |
| `row.hostedNoEditor` | This setting has no editor in the Config UI yet. Edit it in .env.local. | 此设置在 Config UI 中还没有编辑入口，请在 .env.local 中修改。 | Questa impostazione non ha ancora un editor nella Config UI. Modificala in .env.local. |
| `action.openPanel` | Open {panel} | 打开“{panel}” | Apri {panel} |
| `row.unknownType` | This page does not know this setting’s type ({type}). Edit it in .env.local. | 此页面无法识别该设置的类型（{type}）。请在 .env.local 中修改。 | Questa pagina non conosce il tipo di questa impostazione ({type}). Modificala in .env.local. |
| `secret.set` | Stored | 已保存 | Salvata |
| `secret.setLast4` | Stored, ends in {last4} | 已保存，末四位为 {last4} | Salvata, termina con {last4} |
| `secret.unset` | Not set | 未设置 | Non impostata |
| `secret.placeholderSet` | Type a new value to replace the stored one | 输入新值以替换已保存的值 | Digita un nuovo valore per sostituire quello salvato |
| `secret.placeholderUnset` | Paste the value… | 粘贴密钥… | Incolla il valore… |
| `secret.pending` | New value typed. It replaces the stored one when the page saves. | 已输入新值，页面保存时将替换已保存的值。 | Nuovo valore inserito. Sostituirà quello salvato al prossimo salvataggio. |
| `secret.replaced` | {setting}: new value stored. | {setting}：新值已保存。 | {setting}: nuovo valore salvato. |
| `secret.show` | Show typed value: {setting} | 显示输入的值：{setting} | Mostra il valore digitato: {setting} |
| `secret.hide` | Hide typed value: {setting} | 隐藏输入的值：{setting} | Nascondi il valore digitato: {setting} |
| `loaded.note` | Test connection and the sync status describe the configuration the running app loaded when it started. | “测试连接”和同步状态反映的是应用启动时加载的配置。 | Prova connessione e lo stato della sincronizzazione descrivono la configurazione caricata dall’app all’avvio. |
| `loaded.changed` | .env.local changed after the app started. The app, Test connection and the sync status still use the earlier values. Restart the app to use the new ones. | .env.local 在应用启动之后有过更改。应用、“测试连接”和同步状态仍在使用之前的值。重启应用后才会使用新值。 | .env.local è cambiato dopo l’avvio dell’app. L’app, Prova connessione e lo stato della sincronizzazione usano ancora i valori precedenti. Riavvia l’app per usare quelli nuovi. |
| `admin.note` | You can change settings without signing in. Connection tests, sync switches and warnings need the admin session. | 不登录也可以修改设置。测试连接、同步开关和警告需要管理员会话。 | Puoi modificare le impostazioni senza accedere. Prove di connessione, interruttori di sincronizzazione e avvisi richiedono la sessione di amministratore. |
| `admin.unavailable` | Connection tests, sync status and warnings are unavailable right now. Check that the main app is running, then select Reload status. | 暂时无法使用测试连接、同步状态和警告。请确认主应用正在运行，然后选择“重新加载状态”。 | Prove di connessione, stato della sincronizzazione e avvisi non sono disponibili. Verifica che l’app principale sia in esecuzione, poi seleziona Ricarica lo stato. |
| `test.action` | Test connection | 测试连接 | Prova connessione |
| `test.actionAria` | Test connection: {provider} | 测试连接：{provider} | Prova connessione: {provider} |
| `test.running` | Testing… | 正在测试… | Prova in corso… |
| `test.ok` | Connected. Answered in {ms} ms. | 连接成功，响应用时 {ms} 毫秒。 | Connesso. Risposta in {ms} ms. |
| `test.fail.not_configured` | Not tested: the running app has no key or URL for this provider. Save the settings, restart the app, then test again. | 未测试：运行中的应用没有此服务商的密钥或地址。请保存设置并重启应用，然后再测试。 | Non provato: l’app in esecuzione non ha chiave o URL per questo provider. Salva le impostazioni, riavvia l’app, poi riprova. |
| `test.fail.unauthorized` | The provider refused the key. Check the key, restart the app, then test again. | 服务商拒绝了密钥。请检查密钥并重启应用，然后再测试。 | Il provider ha rifiutato la chiave. Controlla la chiave, riavvia l’app, poi riprova. |
| `test.fail.timeout` | No answer within 10 seconds. Check the URL and the provider’s status, then test again. | 10 秒内没有响应。请检查地址和服务商的状态，然后再测试。 | Nessuna risposta entro 10 secondi. Controlla l’URL e lo stato del provider, poi riprova. |
| `test.fail.unreachable` | The provider could not be reached. Check the URL and the network, then test again. | 无法连接到服务商。请检查地址和网络，然后再测试。 | Impossibile raggiungere il provider. Controlla l’URL e la rete, poi riprova. |
| `test.fail.collection_missing` | Connected, but the collection for the active embedding profile does not exist yet. Turn on sync for this backend, let it finish, then test again. | 连接成功，但当前 Embedding 配置对应的集合尚不存在。请为此后端开启同步，等待完成后再测试。 | Connesso, ma la raccolta per il profilo di embedding attivo non esiste ancora. Attiva la sincronizzazione per questo backend, attendi che finisca, poi riprova. |
| `test.fail.other` | The test failed ({code}). Check this provider’s settings, then test again. | 测试失败（{code}）。请检查此服务商的设置，然后再测试。 | La prova non è riuscita ({code}). Controlla le impostazioni di questo provider, poi riprova. |
| `test.role.embedding` | Embeddings: {result} | 向量生成：{result} | Embedding: {result} |
| `test.role.rerank` | Reranker: {result} | 重排：{result} | Reranker: {result} |
| `test.time` | Tested: {time} | 测试时间：{time} | Provato: {time} |
| `test.none` | No connection test exists for this provider. | 此服务商没有连接测试。 | Per questo provider non esiste una prova di connessione. |
| `test.announce` | {provider}: {result} | {provider}：{result} | {provider}: {result} |
| `steps.title` | Order of steps for an external backend | 启用外部后端的步骤顺序 | Ordine dei passaggi per un backend esterno |
| `steps.1` | Enter the URL and keys of Weaviate or Qdrant. | 填写 Weaviate 或 Qdrant 的地址和密钥。 | Inserisci URL e chiavi di Weaviate o Qdrant. |
| `steps.2` | Restart the app, then select Test connection. | 重启应用，然后选择“测试连接”。 | Riavvia l’app, poi seleziona Prova connessione. |
| `steps.3` | Turn on sync for that backend and wait until every workspace is ready. | 为该后端开启同步，等到所有工作区都就绪。 | Attiva la sincronizzazione per quel backend e attendi che ogni spazio di lavoro sia pronto. |
| `steps.4` | Choose it as the retrieval backend and restart the app. | 把它选为检索后端，然后重启应用。 | Sceglilo come backend di recupero e riavvia l’app. |
| `compat.title` | Retrieval backend and index do not match | 检索后端与索引不匹配 | Backend di recupero e indice non corrispondono |
| `compat.ok` | No index compatibility warnings. | 没有索引兼容性警告。 | Nessun avviso di compatibilità dell’indice. |
| `compat.count` | Index compatibility warnings: {count} | 索引兼容性警告：{count} | Avvisi di compatibilità dell’indice: {count} |
| `compat.backend_not_ready` | {backend} is not ready for the active embedding profile. Questions from workspaces that are not ready are answered from pgvector and marked degraded until sync catches up. | {backend} 尚未为当前 Embedding 配置准备就绪。在同步跟上之前，未就绪工作区的问题由 pgvector 回答，并标记为降级。 | {backend} non è pronto per il profilo di embedding attivo. Finché la sincronizzazione non recupera, alle domande degli spazi di lavoro non pronti risponde pgvector, con stato degradato. |
| `compat.backend_not_ready.counts` | Workspaces building: {building}; out of date: {stale}; failed: {failed}. | 构建中的工作区：{building}；已过期：{stale}；失败：{failed}。 | Spazi di lavoro in costruzione: {building}; non aggiornati: {stale}; non riusciti: {failed}. |
| `compat.dimension_mismatch` | The {backend} collection has {actual} dimensions; the active embedding profile has {expected}. The collection must be rebuilt for this profile before {backend} can answer. | {backend} 集合的维度为 {actual}，当前 Embedding 配置的维度为 {expected}。必须为此配置重建集合，{backend} 才能回答。 | La raccolta di {backend} ha {actual} dimensioni; il profilo di embedding attivo ne ha {expected}. La raccolta va ricostruita per questo profilo prima che {backend} possa rispondere. |
| `compat.legacy_pipeline` | {backend} is selected, but the pipeline is legacy. External backends run only when {variable} is v2; until then every question uses pgvector. | 已选择 {backend}，但流程仍是 legacy。只有 {variable} 为 v2 时外部后端才会生效；在此之前所有问题都使用 pgvector。 | {backend} è selezionato, ma la pipeline è legacy. I backend esterni funzionano solo quando {variable} è v2; fino ad allora ogni domanda usa pgvector. |
| `compat.sync_not_enabled` | {backend} is selected, but sync to it is off. Turn on sync below and wait until every workspace is ready. | 已选择 {backend}，但尚未开启向它的同步。请在下方开启同步，等到所有工作区都就绪。 | {backend} è selezionato, ma la sincronizzazione verso di esso è disattivata. Attivala qui sotto e attendi che ogni spazio di lavoro sia pronto. |
| `compat.dead_letters` | Changes that failed permanently: {count}. They never reached {backend}. Run {command} to repair them. | 永久失败的更改：{count}。它们没有到达 {backend}。请运行 {command} 进行修复。 | Modifiche non riuscite in modo definitivo: {count}. Non hanno mai raggiunto {backend}. Esegui {command} per ripararle. |
| `compat.backend_unreachable` | {backend} could not be reached, so its state is unknown. Check its URL and keys, then select Reload status. | 无法连接 {backend}，因此不知道它的状态。请检查地址和密钥，然后选择“重新加载状态”。 | Impossibile raggiungere {backend}, quindi il suo stato è sconosciuto. Controlla URL e chiavi, poi seleziona Ricarica lo stato. |
| `compat.other` | A warning this page does not know was reported for {backend}. | {backend} 报告了一条此页面不认识的警告。 | Per {backend} è stato segnalato un avviso che questa pagina non conosce. |
| `sync.title` | Sync and index state | 同步与索引状态 | Sincronizzazione e stato dell’indice |
| `sync.description` | Sync copies vectors, the tokenized search text of each passage and filter fields to the backend, and keeps them up to date. Passage text as stored and document names stay in Supabase. | 同步会把向量、每个片段的分词检索文本和筛选字段复制到后端，并保持更新。片段原文和文档名称只保存在 Supabase。 | La sincronizzazione copia nel backend i vettori, il testo di ricerca tokenizzato di ogni passaggio e i campi di filtro, e li mantiene aggiornati. Il testo dei passaggi così com’è archiviato e i nomi dei documenti restano in Supabase. |
| `sync.loading` | Loading sync status… | 正在加载同步状态… | Caricamento dello stato della sincronizzazione… |
| `sync.toggle` | Sync to {backend} | 同步到 {backend} | Sincronizza con {backend} |
| `sync.waiting` | Waiting: {count} | 等待中：{count} | In attesa: {count} |
| `sync.inProgress` | In progress: {count} | 进行中：{count} | In corso: {count} |
| `sync.failed` | Failed permanently: {count} | 永久失败：{count} | Non riuscite in modo definitivo: {count} |
| `sync.oldest` | Oldest waiting: {age} | 最早等待：{age} | Attesa più lunga: {age} |
| `sync.oldestNone` | Oldest waiting: none | 最早等待：无 | Attesa più lunga: nessuna |
| `sync.caption` | Workspaces by index state, per embedding profile: {backend} | 各 Embedding 配置下按索引状态统计的工作区：{backend} | Spazi di lavoro per stato dell’indice, per profilo di embedding: {backend} |
| `col.profile` | Embedding profile | Embedding 配置 | Profilo di embedding |
| `col.ready` | Ready | 就绪 | Pronti |
| `col.building` | Building | 构建中 | In costruzione |
| `col.stale` | Out of date | 已过期 | Non aggiornati |
| `col.failed` | Failed | 失败 | Non riusciti |
| `sync.noState` | No index state yet. It appears after sync is turned on and the first check has run. | 还没有索引状态。开启同步并完成第一次检查后会显示。 | Nessuno stato dell’indice per ora. Compare dopo l’attivazione della sincronizzazione e il primo controllo. |
| `sync.turningOn` | Turning on… | 正在开启… | Attivazione… |
| `sync.turningOff` | Turning off… | 正在关闭… | Disattivazione… |
| `sync.on.done` | Sync to {backend} is on. Workspaces queued: {count}. | 已开启到 {backend} 的同步。已排队的工作区：{count}。 | La sincronizzazione con {backend} è attiva. Spazi di lavoro in coda: {count}. |
| `sync.off.done` | Sync to {backend} is off. | 已关闭到 {backend} 的同步。 | La sincronizzazione con {backend} è disattivata. |
| `sync.unknown` | No answer arrived, so the sync switch may or may not have changed. The status has been reloaded. | 没有收到响应，同步开关可能已更改，也可能没有。状态已重新加载。 | Nessuna risposta: l’interruttore di sincronizzazione potrebbe essere cambiato oppure no. Lo stato è stato ricaricato. |
| `sync.refused` | The sync switch was not changed ({code}). Select Reload status, then try again. | 同步开关未更改（{code}）。请选择“重新加载状态”后重试。 | L’interruttore di sincronizzazione non è stato modificato ({code}). Seleziona Ricarica lo stato, poi riprova. |
| `confirm.syncOn.title` | Turn on sync to {backend}? | 要开启到 {backend} 的同步吗？ | Attivare la sincronizzazione con {backend}? |
| `confirm.syncOn.body` | For every workspace, vectors, the tokenized search text of every passage and filter fields (workspace key, document ID, type, date, language, source) are copied to {backend} and kept up to date. Passage text as stored and document names are not sent. The first copy can take a while and may be billed by the provider. | 所有工作区的向量、每个片段的分词检索文本和筛选字段（工作区标识、文档 ID、类型、日期、语言、来源）都会复制到 {backend} 并保持更新。片段原文和文档名称不会发送。首次复制可能需要一些时间，服务商可能会收费。 | Per ogni spazio di lavoro, i vettori, il testo di ricerca tokenizzato di ogni passaggio e i campi di filtro (chiave dello spazio di lavoro, ID del documento, tipo, data, lingua, origine) vengono copiati in {backend} e mantenuti aggiornati. Il testo dei passaggi così com’è archiviato e i nomi dei documenti non vengono inviati. La prima copia può richiedere tempo e può essere fatturata dal provider. |
| `confirm.syncOn.keep` | Keep sync off | 保持同步关闭 | Lascia la sincronizzazione disattivata |
| `confirm.syncOn.confirm` | Turn on sync | 开启同步 | Attiva sincronizzazione |
| `confirm.syncOff.title` | Turn off sync to {backend}? | 要关闭到 {backend} 的同步吗？ | Disattivare la sincronizzazione con {backend}? |
| `confirm.syncOff.body` | Changes stop reaching {backend} and its copy goes out of date. Nothing is deleted there. If {backend} is the retrieval backend, questions are answered from pgvector and marked degraded. | 更改将不再同步到 {backend}，那里的副本会逐渐过期，但不会删除任何内容。如果 {backend} 是检索后端，问题将由 pgvector 回答，并标记为降级。 | Le modifiche non raggiungono più {backend} e la sua copia diventa non aggiornata. Lì non viene eliminato nulla. Se {backend} è il backend di recupero, alle domande risponde pgvector, con stato degradato. |
| `confirm.syncOff.keep` | Keep sync on | 保持同步开启 | Lascia la sincronizzazione attiva |
| `confirm.syncOff.confirm` | Turn off sync | 关闭同步 | Disattiva sincronizzazione |

`{command}` in `compat.dead_letters` is `npm run rag:reconcile`. `{variable}` in `compat.legacy_pipeline` is `RAG_PIPELINE`.
`compat.backend_not_ready.counts` follows `compat.backend_not_ready` as a second sentence only when the warning's detail
carries the three counts.

### 12.3 Red-team runs (`RED_TEAM_LABELS`)

| Key | en | zh | it |
|-----|----|----|----|
| `panel.title` | Red-team runs | 红队测试 | Esecuzioni red team |
| `panel.description` | Replays the stored attack set and the attack corpus through the full pipeline and counts the attacks that got through, per technique and language. Every success opens a case in the Review queue. | 把已保存的攻击集和攻击语料在完整流程中重放一遍，并按手法和语言统计成功的攻击。每次成功都会在复核队列中新建一个案例。 | Riproduce l’insieme di attacchi salvato e il corpus di attacchi attraverso l’intera pipeline e conta gli attacchi riusciti, per tecnica e lingua. Ogni attacco riuscito apre un caso nella Coda di revisione. |
| `note.workspace` | Runs only in the workspace marked for red-team tests. That workspace is set in the runner’s configuration, not here. | 只在标记为红队测试专用的工作区中运行。该工作区在运行器的配置中设置，不在此处设置。 | Viene eseguita solo nello spazio di lavoro contrassegnato per i test red team. Quello spazio si imposta nella configurazione del runner, non qui. |
| `start.configLabel` | Run configuration | 运行配置 | Configurazione dell’esecuzione |
| `start.configCurrent` | Current deployment settings | 当前部署设置 | Impostazioni attuali dell’installazione |
| `start.configHelp` | Choose a saved run configuration to test settings other than the ones in use. | 选择已保存的运行配置，可以测试与当前不同的设置。 | Scegli una configurazione salvata per provare impostazioni diverse da quelle in uso. |
| `action.start` | Start red-team run | 开始红队测试 | Avvia esecuzione red team |
| `start.starting` | Starting… | 正在启动… | Avvio… |
| `confirm.start.title` | Start a red-team run? | 要开始红队测试吗？ | Avviare un’esecuzione red team? |
| `confirm.start.body` | Synthetic attack documents and questions are sent through the full pipeline in the red-team workspace, using the answering model. A run can take several minutes and may be billed by your providers. Every attack that succeeds opens a review case. | 合成的攻击文档和问题会在红队工作区中走完整个流程，并调用回答模型。一次运行可能需要几分钟，服务商可能会收费。每次成功的攻击都会新建一个复核案例。 | Documenti e domande di attacco sintetici attraversano l’intera pipeline nello spazio di lavoro red team, usando il modello di risposta. Un’esecuzione può durare diversi minuti e può essere fatturata dai tuoi provider. Ogni attacco riuscito apre un caso di revisione. |
| `confirm.start.reviewOff` | Expert review is switched off, so no review case will be opened. The run still reports its results. | 专家复核已关闭，因此不会新建复核案例。运行仍会给出结果。 | La revisione degli esperti è disattivata, quindi non verrà aperto alcun caso. L’esecuzione riporta comunque i risultati. |
| `confirm.start.keep` | Close without starting | 不启动并关闭 | Chiudi senza avviare |
| `review.off` | Expert review is switched off. A run still reports its results, but opens no review case. An operator switches it on under RAG Modes. | 专家复核已关闭。运行仍会给出结果，但不会新建复核案例。可由运维人员在 RAG Modes 中开启。 | La revisione degli esperti è disattivata. Un’esecuzione riporta comunque i risultati, ma non apre casi di revisione. Un operatore la attiva in RAG Modes. |
| `latest.title` | Latest run | 最近一次运行 | Ultima esecuzione |
| `list.loading` | Loading the latest run… | 正在加载最近一次运行… | Caricamento dell’ultima esecuzione… |
| `empty.title` | No red-team run yet | 尚未运行过红队测试 | Nessuna esecuzione red team |
| `empty.body` | Select Start red-team run to replay the attack set. The results appear here. | 选择“开始红队测试”来重放攻击集，结果会显示在这里。 | Seleziona Avvia esecuzione red team per riprodurre l’insieme di attacchi. I risultati compaiono qui. |
| `state.running` | Running | 运行中 | In corso |
| `state.finished` | Finished | 已完成 | Terminata |
| `state.failed` | Failed | 失败 | Non riuscita |
| `meta.started` | Started: {time} | 开始时间：{time} | Avviata: {time} |
| `meta.finished` | Finished: {time} | 完成时间：{time} | Terminata: {time} |
| `meta.attacks` | Attacks replayed: {count} | 已重放的攻击：{count} | Attacchi riprodotti: {count} |
| `meta.successes` | Attacks that succeeded: {count} | 成功的攻击：{count} | Attacchi riusciti: {count} |
| `meta.cases` | Review cases opened: {count} | 新建的复核案例：{count} | Casi di revisione aperti: {count} |
| `meta.casesSkipped` | Review cases opened: none, because expert review is switched off | 新建的复核案例：无（专家复核已关闭） | Casi di revisione aperti: nessuno, perché la revisione degli esperti è disattivata |
| `progress.label` | Replayed: {done} of {total} | 已重放：{done}/{total} | Riprodotti: {done} di {total} |
| `progress.unknown` | Running… | 运行中… | In corso… |
| `run.started` | Red-team run started. | 红队测试已开始。 | Esecuzione red team avviata. |
| `run.finished` | Red-team run finished. Attacks that succeeded: {count}. | 红队测试已完成。成功的攻击：{count}。 | Esecuzione red team terminata. Attacchi riusciti: {count}. |
| `run.failed` | The red-team run failed ({code}). Nothing more was replayed. Check the Config UI server’s log, then select Start red-team run to try again. | 红队测试失败（{code}），之后的攻击没有重放。请查看 Config UI 服务器的日志，然后选择“开始红队测试”重试。 | L’esecuzione red team non è riuscita ({code}). Non è stato riprodotto altro. Controlla il log del server della Config UI, poi seleziona Avvia esecuzione red team per riprovare. |
| `result.none` | No attack succeeded in this run. | 这次运行中没有攻击成功。 | Nessun attacco è riuscito in questa esecuzione. |
| `table.caption` | Attack results by technique and language | 按手法和语言统计的攻击结果 | Risultati degli attacchi per tecnica e lingua |
| `col.technique` | Technique | 手法 | Tecnica |
| `col.language` | Language | 语言 | Lingua |
| `col.attacks` | Attacks | 攻击数 | Attacchi |
| `col.succeeded` | Succeeded | 成功数 | Riusciti |
| `col.rate` | Success rate | 成功率 | Tasso di riuscita |
| `row.total` | All techniques | 全部手法 | Tutte le tecniche |
| `note.small` | Counts are small. Read each rate together with its number of attacks. | 样本量较小，请结合攻击数一起看成功率。 | I numeri sono piccoli. Leggi ogni tasso insieme al numero di attacchi. |
| `lang.und` | Undetermined | 未确定 | Non determinata |
| `action.refresh` | Refresh status | 刷新状态 | Aggiorna stato |
| `action.openQueue` | Open Review queue | 打开复核队列 | Apri la Coda di revisione |
| `action.reload` | Reload panel | 重新加载面板 | Ricarica pannello |
| `poll.stalled` | The status could not be read three times in a row. The run may still be going. Select Refresh status. | 连续三次无法读取状态，运行可能仍在继续。请选择“刷新状态”。 | Lo stato non è stato letto per tre volte di seguito. L’esecuzione potrebbe essere ancora in corso. Seleziona Aggiorna stato. |
| `error.adminOnly` | Only an operator admin can start a red-team run. Sign in to the main app at {appUrl} with an admin account, then select Reload panel. | 只有运维管理员可以开始红队测试。请用管理员账号在 {appUrl} 登录主应用，然后选择“重新加载面板”。 | Solo un amministratore operatore può avviare un’esecuzione red team. Accedi all’app principale su {appUrl} con un account amministratore, poi seleziona Ricarica pannello. |
| `error.busy` | A red-team run is already in progress. Its status is shown below. | 已有一次红队测试正在进行，状态显示在下方。 | Un’esecuzione red team è già in corso. Il suo stato è mostrato qui sotto. |
| `error.config` | That run configuration is not available. Choose another one, then start again. | 该运行配置不可用。请另选一个，然后重新开始。 | Quella configurazione non è disponibile. Scegline un’altra, poi riavvia. |
| `error.unavailable` | The admin check is unavailable right now, so no run was started. Check that the main app is running, then try again. | 暂时无法完成管理员校验，因此没有启动运行。请确认主应用正在运行，然后重试。 | La verifica dell’amministratore non è disponibile, quindi non è stata avviata alcuna esecuzione. Verifica che l’app principale sia in esecuzione, poi riprova. |
| `error.gone` | That run’s results are no longer on this machine. | 这次运行的结果已不在这台机器上。 | I risultati di quell’esecuzione non sono più su questa macchina. |
| `error.outcomeUnknown` | No answer from the Config UI server. A run may or may not have started; the status has been reloaded. | Config UI 服务器没有响应。运行可能已启动，也可能没有；状态已重新加载。 | Nessuna risposta dal server della Config UI. Un’esecuzione potrebbe essere partita oppure no; lo stato è stato ricaricato. |

### 12.4 Rollouts (`ROLLOUTS_LABELS`)

| Key | en | zh | it |
|-----|----|----|----|
| `panel.title` | Rollouts | 灰度发布 | Rilasci graduali |
| `panel.description` | Give a new embedding profile, chunking profile or rebuild to a few workspaces first, compare each language with how the same workspaces did before, then promote it to everyone or roll it back. A rollback deletes nothing. Applies to every workspace. | 先让少数工作区使用新的 Embedding 配置、分块配置或重建结果，按语言与这些工作区之前的表现对比，然后全量启用或回滚。回滚不会删除任何内容。适用于所有工作区。 | Dai prima a pochi spazi di lavoro un nuovo profilo di embedding, un profilo di chunking o una ricostruzione, confronta ogni lingua con l’andamento precedente degli stessi spazi, poi promuovilo per tutti o annullalo. L’annullamento non elimina nulla. Vale per tutti gli spazi di lavoro. |
| `list.loading` | Loading rollouts… | 正在加载灰度发布… | Caricamento dei rilasci… |
| `list.unavailable` | Rollouts are unavailable right now. Select Reload panel in a moment. | 灰度发布暂时不可用。请稍后选择“重新加载面板”。 | I rilasci graduali non sono disponibili. Seleziona Ricarica pannello tra poco. |
| `action.reload` | Reload panel | 重新加载面板 | Ricarica pannello |
| `off.title` | Rollouts are switched off | 灰度发布已关闭 | I rilasci graduali sono disattivati |
| `off.body` | An operator switches them on under RAG Modes, RAG pipeline settings ({variable}). While off, every workspace uses the active profiles. | 由运维人员在 RAG Modes 的“RAG 流程设置”中开启（{variable}）。关闭时，所有工作区都使用当前生效的配置。 | Un operatore li attiva in RAG Modes, Impostazioni della pipeline RAG ({variable}). Finché sono disattivati, ogni spazio di lavoro usa i profili attivi. |
| `warn.legacy` | The pipeline is set to legacy, so rollouts are ignored and every workspace uses the active profiles. Rollouts need {variable} set to v2. | 流程设置为 legacy，因此灰度发布不生效，所有工作区都使用当前生效的配置。灰度发布需要把 {variable} 设为 v2。 | La pipeline è impostata su legacy, quindi i rilasci graduali vengono ignorati e ogni spazio di lavoro usa i profili attivi. I rilasci richiedono {variable} impostata su v2. |
| `empty.title` | No rollout in progress | 没有进行中的灰度发布 | Nessun rilascio in corso |
| `empty.body` | Start one to try a new profile or rebuild on a few workspaces before everyone gets it. The candidate must already be built. | 开始一次灰度发布，先在少数工作区试用新的配置或重建结果，再推广到所有工作区。候选对象必须已经构建完成。 | Avviane uno per provare un nuovo profilo o una ricostruzione su pochi spazi di lavoro prima che arrivi a tutti. Il candidato deve essere già costruito. |
| `action.new` | New rollout | 新建灰度发布 | Nuovo rilascio |
| `action.closeForm` | Close form | 关闭表单 | Chiudi modulo |
| `form.title` | Start a rollout | 开始灰度发布 | Avvia un rilascio |
| `form.kind` | What to roll out | 发布对象 | Che cosa rilasciare |
| `form.kindBusy` | A rollout of this kind is already in progress. | 这一类已有进行中的灰度发布。 | Un rilascio di questo tipo è già in corso. |
| `kind.embedding_profile` | Embedding profile | Embedding 配置 | Profilo di embedding |
| `kind.chunking_profile` | Chunking profile | 分块配置 | Profilo di chunking |
| `kind.rebuild_run` | Rebuild | 重建 | Ricostruzione |
| `form.candidate` | Candidate ID | 候选 ID | ID del candidato |
| `form.candidateHelp.embedding_profile` | The ID of a profile that is being backfilled, as listed under Embedding profiles. | 正在回填的配置的 ID，见“Embedding 配置”面板中的列表。 | L’ID di un profilo in fase di riempimento, come elencato in Profili di embedding. |
| `form.candidateHelp.chunking_profile` | The ID of a built profile, as listed under Chunking profiles. | 已构建完成的配置的 ID，见“分块配置”面板中的列表。 | L’ID di un profilo costruito, come elencato in Profili di chunking. |
| `form.candidateHelp.rebuild_run` | The ID of a finished rebuild, as listed under Ingestion changes. | 已完成的重建的 ID，见“入库设置变更”面板中的列表。 | L’ID di una ricostruzione terminata, come elencata in Modifiche all’ingestione. |
| `form.mode` | Who gets it first | 先让谁使用 | Chi lo riceve per primo |
| `mode.tenants` | Chosen workspaces | 指定的工作区 | Spazi di lavoro scelti |
| `mode.share` | A share of workspaces | 一定比例的工作区 | Una quota di spazi di lavoro |
| `form.tenants` | Workspace keys | 工作区标识 | Chiavi degli spazi di lavoro |
| `form.tenantsHelp` | One key per line, in lower case: o: or u: followed by the ID, or s:default. | 每行一个标识，使用小写：o: 或 u: 后接 ID，或 s:default。 | Una chiave per riga, in minuscolo: o: oppure u: seguito dall’ID, oppure s:default. |
| `form.share` | Share of workspaces (%) | 工作区比例（%） | Quota di spazi di lavoro (%) |
| `form.shareHelp` | A whole number from 1 to 100. Workspaces are picked by a fixed hash of their key, so a workspace stays on the same side for the whole rollout. | 1 到 100 的整数。工作区按其标识的固定哈希选出，因此在整个发布期间，同一个工作区始终在同一侧。 | Un numero intero da 1 a 100. Gli spazi di lavoro vengono scelti con un hash fisso della loro chiave, quindi uno spazio resta sullo stesso lato per tutto il rilascio. |
| `form.candidateRequired` | Enter the candidate ID. | 请填写候选 ID。 | Inserisci l’ID del candidato. |
| `form.tenantsRequired` | Enter at least one workspace key. | 请至少填写一个工作区标识。 | Inserisci almeno una chiave di spazio di lavoro. |
| `form.tenantInvalid` | Line {line} is not a workspace key. Use lower case: o: or u: followed by the ID, or s:default. | 第 {line} 行不是工作区标识。请使用小写：o: 或 u: 后接 ID，或 s:default。 | La riga {line} non è una chiave di spazio di lavoro. Usa il minuscolo: o: oppure u: seguito dall’ID, oppure s:default. |
| `form.shareInvalid` | Enter a whole number from 1 to 100. | 请填写 1 到 100 的整数。 | Inserisci un numero intero da 1 a 100. |
| `action.start` | Start rollout | 开始灰度发布 | Avvia rilascio |
| `start.running` | Starting… | 正在开始… | Avvio… |
| `confirm.start.title` | Start this rollout? | 要开始这次灰度发布吗？ | Avviare questo rilascio? |
| `confirm.start.bodyTenants` | {candidate} starts answering for the workspaces you listed ({count}) within about 30 seconds. Every other workspace keeps the current one. You can roll it back at any time; nothing is deleted. | 大约 30 秒内，{candidate} 会开始为你列出的工作区（{count} 个）提供回答。其他工作区保持现状。可以随时回滚，不会删除任何内容。 | Entro circa 30 secondi {candidate} inizia a rispondere per gli spazi di lavoro che hai elencato ({count}). Tutti gli altri mantengono quello attuale. Puoi annullare in qualsiasi momento; non viene eliminato nulla. |
| `confirm.start.bodyShare` | {candidate} starts answering for about {percent}% of workspaces within about 30 seconds. Every other workspace keeps the current one. You can roll it back at any time; nothing is deleted. | 大约 30 秒内，{candidate} 会开始为约 {percent}% 的工作区提供回答。其他工作区保持现状。可以随时回滚，不会删除任何内容。 | Entro circa 30 secondi {candidate} inizia a rispondere per circa il {percent}% degli spazi di lavoro. Tutti gli altri mantengono quello attuale. Puoi annullare in qualsiasi momento; non viene eliminato nulla. |
| `confirm.start.keep` | Close without starting | 不开始并关闭 | Chiudi senza avviare |
| `start.done` | Rollout started. | 灰度发布已开始。 | Rilascio avviato. |
| `start.exists` | Not started. A rollout of this kind is already in progress. Promote it or roll it back first. | 未开始。这一类已有进行中的灰度发布，请先全量启用或回滚。 | Non avviato. Un rilascio di questo tipo è già in corso. Prima promuovilo o annullalo. |
| `start.invalid` | Not started. The server did not accept this value: {detail} | 未开始。服务器不接受这个值：{detail} | Non avviato. Il server non ha accettato questo valore: {detail} |
| `start.refused` | Not started. The server gave the reason {code}. | 未开始。服务器给出的原因是 {code}。 | Non avviato. Il server ha indicato il motivo {code}. |
| `card.heading` | {kind}: {candidate} | {kind}：{candidate} | {kind}: {candidate} |
| `card.mode.tenants` | Chosen workspaces | 指定的工作区 | Spazi di lavoro scelti |
| `card.mode.share` | Share of workspaces: {percent}% | 工作区比例：{percent}% | Quota di spazi di lavoro: {percent}% |
| `card.started` | Started: {date} | 开始日期：{date} | Avviato: {date} |
| `card.days` | Days running: {count} | 已运行天数：{count} | Giorni di attività: {count} |
| `card.incumbent` | Current for everyone else: {id} | 其他工作区当前使用：{id} | Attuale per tutti gli altri: {id} |
| `arm.candidate` | Workspaces on the candidate: {count} | 使用候选的工作区：{count} | Spazi di lavoro sul candidato: {count} |
| `arm.incumbent` | Workspaces on the current one: {count} | 保持现状的工作区：{count} | Spazi di lavoro su quello attuale: {count} |
| `note.chunkingExternal` | While this rollout runs, candidate workspaces are searched in pgvector even when an external backend is selected. | 这次发布期间，即使选择了外部后端，使用候选的工作区也在 pgvector 中检索。 | Durante questo rilascio, gli spazi di lavoro sul candidato vengono cercati in pgvector anche se è selezionato un backend esterno. |
| `state.active` | Active | 进行中 | Attivo |
| `state.promoted` | Promoted | 已全量启用 | Promosso |
| `state.rolled_back` | Rolled back | 已回滚 | Annullato |
| `state.cancelled` | Cancelled | 已取消 | Cancellato |
| `compare.title` | Quality per language | 各语言的质量 | Qualità per lingua |
| `table.caption` | Quality per language: {candidate} | 各语言的质量：{candidate} | Qualità per lingua: {candidate} |
| `table.help` | Each language is compared with the same workspaces over an equally long period before the rollout started. Other workspaces are shown so that a change affecting everyone is visible. | 每种语言都与同一批工作区在发布开始之前等长时间段内的表现对比。同时列出其他工作区，便于看出影响所有工作区的变化。 | Ogni lingua viene confrontata con gli stessi spazi di lavoro in un periodo di pari durata prima dell’inizio del rilascio. Gli altri spazi sono mostrati per rendere visibile un cambiamento che riguarda tutti. |
| `col.language` | Language | 语言 | Lingua |
| `col.measure` | Measure | 指标 | Misura |
| `col.candidate` | Candidate now | 候选（当前） | Candidato ora |
| `col.before` | Same workspaces before | 同一批工作区（之前） | Stessi spazi prima |
| `col.others` | Other workspaces now | 其他工作区（当前） | Altri spazi ora |
| `col.result` | Result | 结论 | Esito |
| `measure.refusal_rate` | “Information not available” answers | “信息不可用”的回答 | Risposte «informazione non disponibile» |
| `measure.not_helpful_rate` | Not-helpful votes | “没有帮助”的投票 | Voti «non utile» |
| `measure.judge_score` | Judge score | 评审得分 | Punteggio del giudice |
| `cell.n` | n = {n} | n = {n} | n = {n} |
| `cell.none` | No data | 无数据 | Nessun dato |
| `result.holds` | Holds | 保持 | Stabile |
| `result.worse` | Got worse | 变差 | Peggiorata |
| `result.insufficient` | Not enough data | 数据不足 | Dati insufficienti |
| `result.unmeasured` | Not measured | 未测量 | Non misurata |
| `ready.all` | Every language holds. Promotion also needs the observation period to be over. | 所有语言都保持稳定。全量启用还需要观察期结束。 | Ogni lingua è stabile. Per la promozione deve anche essere terminato il periodo di osservazione. |
| `ready.blocked` | Not ready to promote: at least one language got worse or has too little data. | 尚不能全量启用：至少有一种语言变差或数据不足。 | Non pronto per la promozione: almeno una lingua è peggiorata o ha troppi pochi dati. |
| `ready.noData` | No per-language data yet. It appears once candidate workspaces have answered questions. | 还没有按语言统计的数据。使用候选的工作区回答过问题后会显示。 | Nessun dato per lingua per ora. Compare dopo che gli spazi sul candidato hanno risposto a delle domande. |
| `lang.und` | Undetermined | 未确定 | Non determinata |
| `tenants.title` | Workspaces | 工作区 | Spazi di lavoro |
| `tenants.included` | Included: {count} | 已加入：{count} | Inclusi: {count} |
| `tenants.excluded` | Excluded: {count} | 已排除：{count} | Esclusi: {count} |
| `tenants.showAll` | Show all workspaces | 显示全部工作区 | Mostra tutti gli spazi di lavoro |
| `tenant.key` | Workspace key | 工作区标识 | Chiave dello spazio di lavoro |
| `tenant.keyHelp` | Lower case: o: or u: followed by the ID, or s:default. Workspaces picked by the share are not listed; exclude one by its key. | 使用小写：o: 或 u: 后接 ID，或 s:default。按比例选中的工作区不会列出，可通过标识排除。 | In minuscolo: o: oppure u: seguito dall’ID, oppure s:default. Gli spazi scelti dalla quota non sono elencati; escludine uno con la sua chiave. |
| `tenant.keyInvalid` | That is not a workspace key. Use lower case: o: or u: followed by the ID, or s:default. | 这不是工作区标识。请使用小写：o: 或 u: 后接 ID，或 s:default。 | Non è una chiave di spazio di lavoro. Usa il minuscolo: o: oppure u: seguito dall’ID, oppure s:default. |
| `action.include` | Include workspace | 加入工作区 | Includi spazio di lavoro |
| `action.includeAria` | Include workspace: {tenant} | 加入工作区：{tenant} | Includi spazio di lavoro: {tenant} |
| `action.exclude` | Exclude workspace | 排除工作区 | Escludi spazio di lavoro |
| `action.excludeAria` | Exclude workspace: {tenant} | 排除工作区：{tenant} | Escludi spazio di lavoro: {tenant} |
| `confirm.include.title` | Include {tenant} in this rollout? | 要把 {tenant} 加入这次灰度发布吗？ | Includere {tenant} in questo rilascio? |
| `confirm.include.body` | This workspace is answered by the candidate within about 30 seconds. You can exclude it again; nothing is deleted. | 大约 30 秒内，这个工作区将由候选提供回答。之后可以再排除，不会删除任何内容。 | Entro circa 30 secondi a questo spazio di lavoro risponde il candidato. Puoi escluderlo di nuovo; non viene eliminato nulla. |
| `confirm.exclude.title` | Exclude {tenant} from this rollout? | 要把 {tenant} 从这次灰度发布中排除吗？ | Escludere {tenant} da questo rilascio? |
| `confirm.exclude.body` | This workspace goes back to the current one within about 30 seconds and stays out of the rollout, even under a share. Nothing is deleted; you can include it again. | 大约 30 秒内，这个工作区会回到当前配置，并且不再参与这次发布（按比例发布时也是如此）。不会删除任何内容，之后可以重新加入。 | Entro circa 30 secondi questo spazio di lavoro torna a quello attuale e resta fuori dal rilascio, anche con una quota. Non viene eliminato nulla; puoi includerlo di nuovo. |
| `confirm.tenant.keep` | Keep workspace as it is | 保持工作区现状 | Lascia lo spazio di lavoro com’è |
| `tenant.running` | Saving… | 正在保存… | Salvataggio… |
| `include.done` | {tenant} is included. | {tenant} 已加入。 | {tenant} è incluso. |
| `exclude.done` | {tenant} is excluded and back on the current one. | {tenant} 已排除，并回到当前配置。 | {tenant} è escluso ed è tornato a quello attuale. |
| `action.rollback` | Roll back rollout | 回滚灰度发布 | Annulla rilascio |
| `confirm.rollback.title` | Roll back this rollout? | 要回滚这次灰度发布吗？ | Annullare questo rilascio? |
| `confirm.rollback.body` | Every workspace on the candidate goes back to the current one within about 30 seconds, and the rollout ends. The candidate stays built and nothing is deleted. You can start a new rollout later. | 大约 30 秒内，所有使用候选的工作区都会回到当前配置，这次发布随之结束。候选仍然保留，不会删除任何内容。之后可以重新开始发布。 | Entro circa 30 secondi ogni spazio di lavoro sul candidato torna a quello attuale e il rilascio termina. Il candidato resta costruito e non viene eliminato nulla. Potrai avviare un nuovo rilascio in seguito. |
| `confirm.keepRunning` | Keep rollout running | 继续灰度发布 | Lascia il rilascio in corso |
| `rollback.running` | Rolling back… | 正在回滚… | Annullamento… |
| `rollback.done` | Rollout rolled back. Every workspace is on the current one. | 灰度发布已回滚，所有工作区都在使用当前配置。 | Rilascio annullato. Ogni spazio di lavoro usa quello attuale. |
| `action.promote` | Promote rollout | 全量启用 | Promuovi rilascio |
| `confirm.promote.title` | Promote {candidate} to every workspace? | 要为所有工作区启用 {candidate} 吗？ | Promuovere {candidate} per tutti gli spazi di lavoro? |
| `confirm.promote.body` | {candidate} becomes active for every workspace and the rollout ends. Four things are checked first: the observation period, enough data in every enabled language, no language worse than before, and the usual activation checks. If one fails, nothing changes. | {candidate} 将对所有工作区生效，这次发布随之结束。启用前会检查四项：观察期、每种已启用语言的数据量、没有语言比之前变差，以及常规的启用检查。任何一项未通过，都不会有任何更改。 | {candidate} diventa attivo per ogni spazio di lavoro e il rilascio termina. Prima vengono controllate quattro cose: il periodo di osservazione, dati sufficienti in ogni lingua abilitata, nessuna lingua peggiorata rispetto a prima e i consueti controlli di attivazione. Se uno fallisce, non cambia nulla. |
| `promote.running` | Promoting… | 正在全量启用… | Promozione… |
| `promote.done` | Promoted. {candidate} is now active for every workspace. | 已全量启用。{candidate} 现在对所有工作区生效。 | Promosso. {candidate} è ora attivo per ogni spazio di lavoro. |
| `promote.refused.observation` | Not promoted. The rollout has not run long enough yet. Wait for the observation period to end, then promote again. | 未全量启用。这次发布运行的时间还不够。请等观察期结束后再启用。 | Non promosso. Il rilascio non è attivo da abbastanza tempo. Attendi la fine del periodo di osservazione, poi promuovi di nuovo. |
| `promote.refused.insufficient` | Not promoted. {language} has too few questions on the candidate to judge. Include more workspaces, wait, then promote again. | 未全量启用。{language}在候选上的提问太少，无法判断。请加入更多工作区，等待一段时间后再启用。 | Non promosso. {language} ha troppe poche domande sul candidato per essere valutata. Includi altri spazi di lavoro, attendi, poi promuovi di nuovo. |
| `promote.refused.drop` | Not promoted. {language} got worse on this measure since the rollout started: {measure}. Roll back, or exclude the affected workspaces and look into the cause. | 未全量启用。发布开始以来，{language}在这项指标上变差了：{measure}。请回滚，或排除受影响的工作区并查明原因。 | Non promosso. Dall’inizio del rilascio {language} è peggiorata su questa misura: {measure}. Annulla, oppure escludi gli spazi interessati e cerca la causa. |
| `promote.refused.external` | Not promoted. {backend} is not ready for the candidate on every workspace. Wait for sync to finish (RAG Modes, Vector backends), then promote again. | 未全量启用。{backend} 尚未在所有工作区为候选准备就绪。请等待同步完成（RAG Modes，向量后端），然后再启用。 | Non promosso. {backend} non è pronto per il candidato su ogni spazio di lavoro. Attendi la fine della sincronizzazione (RAG Modes, Backend vettoriali), poi promuovi di nuovo. |
| `promote.refused.other` | Not promoted. Activation was refused with the reason {code}. Nothing changed. | 未全量启用。启用被拒绝，原因是 {code}。没有任何更改。 | Non promosso. L’attivazione è stata rifiutata con il motivo {code}. Non è cambiato nulla. |
| `recent.title` | Recent rollouts | 最近的灰度发布 | Rilasci recenti |
| `recent.col.kind` | What | 发布对象 | Che cosa |
| `recent.col.candidate` | Candidate | 候选 | Candidato |
| `recent.col.state` | State | 状态 | Stato |
| `recent.col.ended` | Ended | 结束日期 | Terminato |
| `error.changed` | This rollout has changed or ended. The list has been reloaded. | 这次灰度发布已发生变化或已结束，列表已重新加载。 | Questo rilascio è cambiato o è terminato. L’elenco è stato ricaricato. |
| `error.outcomeUnknown` | No answer from the server. The rollout may or may not have changed; the list has been reloaded. | 服务器没有响应。灰度发布可能已更改，也可能没有；列表已重新加载。 | Nessuna risposta dal server. Il rilascio potrebbe essere cambiato oppure no; l’elenco è stato ricaricato. |

`{variable}` in `off.body` is `RAG_ROLLOUTS`; in `warn.legacy` it is `RAG_PIPELINE`. In a refusal sentence `{language}` is the
language's name in the UI language, and `{measure}` is the measure's label.

### 12.5 Languages additions (`LANGUAGES_LABELS`, plan 07-52)

Existing keys of 03.2-UI-SPEC 12.2, including `note.removed`, are unchanged.

| Key | en | zh | it |
|-----|----|----|----|
| `error.language_baseline_missing` | Not saved. No baseline is recorded for {language}. Record it with {command}, then save again. | 未保存。{language}还没有记录基线。请先运行 {command} 记录基线，再保存。 | Non salvato. Per {language} non è registrata alcuna baseline. Registrala con {command}, poi salva di nuovo. |
| `blocked.baseline` | No baseline is recorded for this language. Record it with {command} first. | 此语言还没有记录基线。请先运行 {command}。 | Per questa lingua non è registrata alcuna baseline. Registrala prima con {command}. |
| `add.title` | Add {language}? | 要添加{language}吗？ | Aggiungere {language}? |
| `add.col.group` | Documents | 文档 | Documenti |
| `add.col.count` | Count | 数量 | Numero |
| `add.group.und` | Stored without a detected language | 入库时未检测出语言 | Archiviati senza una lingua rilevata |
| `add.group.scanned` | Scanned documents | 扫描件 | Documenti scansionati |
| `add.group.stale` | Processed with earlier settings | 按旧设置处理的文档 | Elaborati con impostazioni precedenti |
| `add.total` | Documents to reprocess | 需要重新处理的文档 | Documenti da rielaborare |
| `add.note` | Only these documents are reprocessed, and only after you start the rebuild. Every other document stays as it is. | 只有这些文档会重新处理，并且要在你开始重建之后才会进行。其他文档保持不变。 | Vengono rielaborati solo questi documenti, e solo dopo che avrai avviato la ricostruzione. Tutti gli altri restano come sono. |
| `save.added` | {language} added. Documents to reprocess: {count}. Start the rebuild under RAG administration, Ingestion changes. | 已添加{language}。需要重新处理的文档：{count}。请在“RAG 管理 → 入库设置变更”中开始重建。 | {language} aggiunta. Documenti da rielaborare: {count}. Avvia la ricostruzione in Amministrazione RAG, Modifiche all’ingestione. |
| `save.addedNone` | {language} added. No stored document needs reprocessing. | 已添加{language}。没有已入库的文档需要重新处理。 | {language} aggiunta. Nessun documento archiviato deve essere rielaborato. |
| `save.removed` | {language} removed from the supported languages. Its documents stay searchable; nothing was deleted or rebuilt. | 已将{language}从支持的语言中移除。它的文档仍可检索，没有删除或重建任何内容。 | {language} rimossa dalle lingue supportate. I suoi documenti restano ricercabili; nulla è stato eliminato o ricostruito. |

`{command}` is `npm run rag:languages -- baseline <code>` with the language's code in place of `<code>`.

---

## 13. Color

DaisyUI theme tokens are the contract; hex values are the DaisyUI 4.4 defaults, for reference only, and are never
hard-coded. No surface of this phase uses the brand orange (`myrag-primary`).

| Role | Token | Reference (dark / light) | Usage |
|------|-------|--------------------------|-------|
| Dominant (60%) | `base-100` | ≈ #1D232A / #FFFFFF | Tab card behind the section and the panels; inputs; dialog boxes |
| Secondary (30%) | `base-200`, `base-300` | ≈ #191E24, #15191E / #F2F2F2, #E5E6E6 | Group cards and panel cards; row dividers; table borders; the left rule of provider blocks and rollout cards |
| Text | `base-content`, `/70` for secondary | ≈ #A6ADBB / #1F2937 | All text; muted lines use `/70`, never lower |
| Accent (10%) | `primary` (DaisyUI) | theme primary | See the reserved list below |
| Info | `info` | theme info | "Running" and "Active" badges; switched-off, expert-review-off and loaded-configuration alerts |
| Success | `success` | theme success | "Finished" badge; "Holds" badge |
| Warning | `warning` | theme warning | Index-compatibility alert; sign-in alert; pipeline-is-legacy alert; refused-promotion alert; "Not enough data" badge |
| Destructive | `error` | theme error | No destructive action exists in this phase. The token marks failure only: failed load and unavailable alerts, field errors, the "Failed" and "Got worse" badges, and a count of succeeded attacks above 0 |

Accent reserved for: the checked state of setting toggles and of the two sync switches (`toggle-primary`, the page's
existing pattern); "Start red-team run"; "Promote rollout" on a card; "Start rollout" in the form; the confirm button of
each dialog of 12.1; and focus outlines. Nothing else is `primary`: not headings, not jump buttons, not "Test connection",
"Reload status", "Refresh status", "New rollout", "Include workspace", "Exclude workspace", "Roll back rollout", "Show
setting" or "Open {panel}" (all outline, ghost or link), not the "Changed" badge, and not radios.

Success, info, warning and error colours describe a state the server names or a failed check. A rate, a latency, a
count of attacks, a share and a changed value are never coloured; the one exception is a succeeded-attack count above 0,
which is `text-error` with an icon.

---

## 14. Decisions made in this contract

No question was asked (owner's standing rule). Each row is the recommended option, adopted as the contract (source:
recommended default); the owner may override any of them.

| # | Question | Decision and reason |
|---|----------|---------------------|
| 1 | Where does the generated section go? | In the RAG Modes tab, in place of the seven settings cards it replaces. Other panels' copy already sends operators to "RAG Modes" for these switches, and D-14 calls it a section, not a tab |
| 2 | What happens to the 33 managed inputs inside RAG administration panels? | They stay where two approved contracts put them, with their localized help and combination warnings. The generated section shows a read-only row with the saved value and "Show setting". D-14 says the hand-built panels stay; an `id` still occurs once; `ingestion.js` is not in plan 07-20's files |
| 3 | What if a hand-written control for a managed variable appears later? | The hand-written control wins: the section renders a hosted row instead of a second control. A plan that lands after 07-20 can never create a duplicate `id` |
| 4 | Open or collapsed groups? | Open, with jump buttons. The browser's find reaches every env name |
| 5 | What is the section's signature? | The setting row with its default line and "Changed" badge. The phase ships release defaults; the row shows where a deployment departs from them |
| 6 | Does an unmet requirement disable a control? | Yes for bool, enum, number and string (plan 07-20). No for URL and secret: a provider must be configurable and testable before retrieval is switched to it, and the opposite order would select a backend that has no address |
| 7 | Are manifest labels localized? | No. They are English data, like env names; the section's own text is `en`, `zh` and `it`. Same choice as the static settings cards before it (05.1.1 decision 3) |
| 8 | How is a secret removed? | Not in the UI (D-14: a secret changes only when a new value is typed). One sentence says to delete its line in `.env.local` |
| 9 | Is a typed secret kept after the save? | No. The field is emptied and the key is dropped from the page's config object, so it is not posted again with later saves |
| 10 | How is a test result worded? | From its code, in the UI language. The server's fixed English message is the fallback for a code the table lacks. Results show a time and are not kept |
| 11 | One Test button or one per probe? | One per provider. A provider with two probes (Voyage AI) shows two labelled result lines |
| 12 | Where do index-compatibility warnings show? | In the Vector backends card, above the selector they concern, with a count on that group's jump button so they are visible from the top of the section |
| 13 | Is a sync switch a destructive action? | No: nothing is deleted. Both directions get a confirmation, because turning it on sends content (vectors and tokenized search text) to a vendor and turning it off makes the selected backend fall back |
| 14 | Does the sync dialog name what is sent? | Yes, field by field, and what is not. A-11 lists tokenized text as content; the operator decides with that fact in front of them |
| 15 | Is the backend flow a wizard? | No. Four numbered sentences; the order is a real sequence, the state of each step is already shown |
| 16 | What stays of the Prompt-injection defense card? | The detector summary, in a card retitled "Prompt-injection detectors" directly under the section. It is a hand-built panel in D-14's list and `injection-defense.js` is unchanged |
| 17 | Where do the two new panels go? | Appended to RAG administration: Red-team runs after the review panels it feeds, then Rollouts. No earlier order changes |
| 18 | Does the red-team panel poll? | Yes, every 5 seconds, only while a run is running and the tab is visible. A run takes minutes and is started here |
| 19 | Matrix or long table for attack results? | One row per technique and language, as plan 07-48 states, with a total row. The count stands next to every rate |
| 20 | Are attack successes shown in detail? | No. Counts only; each success is a case in the Review queue, where a person decides |
| 21 | Is "Promote rollout" disabled until the table is green? | No. The server decides and a refusal changes nothing; a disabled button would hide the reason. The ready line says what the table shows |
| 22 | How is the baseline of the comparison named? | "Same workspaces before". The comparison follows the same workspaces (plan 07-49); "Other workspaces now" is shown beside it and never decides |
| 23 | "Traffic share" or "share of workspaces"? | "Share of workspaces". A workspace is wholly on one side (plan 07-47); "traffic" would promise a per-request split |
| 24 | Are promote and roll back destructive? | No. Neither deletes; both get a confirmation with primary colour and default focus on "Keep rollout running" (04-UI-SPEC 6.6 precedent) |
| 25 | Does the panel start rollouts? | Yes. The plan's objective and the route include start; the form validates keys in the browser and the server refuses a second rollout of a kind |
| 26 | How is the candidate chosen? | By typing its ID, with help that names the panel listing it. Three list calls to three other routes would tie the panel to three response shapes |
| 27 | How does the operator learn about a missing language baseline? | From the save refusal with the exact command (required), and, when the list reports it, from a blocked row before any dialog (section 15 item 11) |
| 28 | What does a removal say after the save? | "Its documents stay searchable; nothing was deleted or rebuilt." The existing unsaved note stays as 03.2 wrote it |
| 29 | Shared helpers | `rag-ui.js` when it is on the tree at plan start, otherwise private helpers under the file's prefix. No existing panel is refactored |
| 30 | Is static markup added to `index.html` localized? | No. The sentence added to the tab intro, the skeleton headings before a script runs and the retitled detector card are English, like all static text of the page; scripts replace the skeleton headings and descriptions with the locale's text on mount |

---

## 15. Plan changes needed

The plans were not edited. These points need the planner's or orchestrator's decision before or during execution. Items
1, 2, 5 and 8 block a plan as written.

1. **Plan 07-20, tests outside `files_modified` (blocking).** Removing the 88 RAG Modes inputs fails tests in
   `tests/ui/config-phase4-switches.test.ts`, `config-query-layer-card.test.ts`, `config-injection-panel.test.ts` (the
   "Config UI wiring" block asserts `id="RAG_INJECTION_CHECK"`, the Lakera help sentence and the key field inside the
   card), `config-chunking-panel.test.ts` (`data-refusal-pointer` after the refusal switch) and, where they name
   `RAG_PARSER` or `VOYAGE_API_KEY`, `config-ingestion-panel.test.ts` and `config-ingestion-switches.test.ts`. The plan's
   own verification runs `tests/ui`. These files must join the plan, and their assertions on labels, names, input types,
   autofill and `aria-describedby` must move to the generated-section test.
2. **Plan 07-20, truth 4 (blocking contradiction).** "Each managed variable has exactly one input, in the generated
   section" cannot hold together with "the hand-built panels … stay unchanged" for the 33 inputs of
   `#rag-ingestion-settings` and `#rag-phase032-settings`. This contract keeps them (decision 2). The plan's tests should
   read: "every managed" means one row per managed variable (a control or a hosted row); "exactly once" means one control
   per `id` on the page.
3. **Plan 07-20, two small edits inside its files (addition).** `saveConfig()` dispatches `rag-config-saved`;
   `populateFields()` skips fields inside `#rag-pipeline-settings` (6.2.1). Also check that
   `#open-ingestion-settings-link` and `[data-refusal-pointer]` are looked up null-safely by `ingestion.js` and
   `refusal-calibration.js` once the static pointers are gone (the refusal lookup is; the ingestion one is not verified).
4. **Plan 07-18, help text (recommended).** Add an optional `help` string to the metadata and move the existing help
   lines of the 88 inputs into it, word for word. Without it the generated rows lose guidance that matters, for example
   that the evaluation endpoint returns document content and that the Lakera check sends chunk text to a third party.
   The row renders `help` when present and nothing otherwise, so the contract holds either way.
5. **Plan 07-18, bool type (blocking for correctness).** `bool` must mean the values `true` and `false`. A switch whose
   values are `on` and `off` must be `enum` with those options, or the toggle writes the wrong value (finding 8).
   `check-config` should refuse a `bool` whose default is not `true` or `false`.
6. **Plan 07-20, requirement behaviour (reading).** "An entry whose requires is unmet is disabled" applies to bool, enum,
   number and string. URL and secret entries stay editable with the hint (decision 6). The test should assert `disabled`
   for the first set only.
7. **Plans 07-19 and 07-20, provider mapping (addition).** No plan maps the manifest's provider ids to the probe ids.
   6.2.4 fixes the map as a constant in `rag-pipeline.js`; a test should assert that every probe id it names is in
   `PROVIDER_IDS`, and plan 07-19 should keep the codes `not_configured`, `unauthorized`, `timeout`, `unreachable` and
   `collection_missing` stable.
8. **Plan 07-48, missing reads (blocking for three states).** The panel needs, from the config server: the latest or
   running run after a page reload (`GET /api/red-team/runs`, answering "none" without an error), the names of the run
   configurations under `eval/config/runs/`, a progress count (done and total) in the status, the technique labels from
   `config/rag/red-team-techniques.json` (the browser cannot read that file), and the id of the running run in the 409
   answer. Without them "idle shows the last run's summary", the run-configuration choice and resumed polling cannot be
   built. All fit inside the plan's files.
9. **Plan 07-49, start form and list fields (addition).** Task 3's behaviour list has no start form although the
   objective and the route have start; this contract includes it (6.4.5). The list answer must carry, per active
   rollout: included and excluded keys, both arm sizes, and per language and measure the three values with sample sizes
   and the verdict. Recommended: the policy's observation days and minimum samples, so `card.days` can read "day 3 of 7";
   without them the card shows the days running and the server explains a refusal.
10. **Plan 07-49, refusal transport (reading).** The panel treats a promote answer as refused when the body says
    `ok: false` or the status is 409, and reads the code from the body. The route should use one of the two consistently.
11. **Plan 07-52, dialog labels and the list (addition).** The impact dialog belongs to `ingest-impact.js` (Phase 3.2),
    which is not in the plan's files. Either that dialog accepts a title and labelled rows from its caller, or the file
    joins the plan; otherwise the three groups appear as codes. Recommended: the language list reports a missing baseline
    per language, so the row is blocked before the operator confirms a dialog and is then refused.
12. **Orchestrator, order of later UI plans (note).** A plan of a held phase that adds hand-written inputs for managed
    variables to RAG Modes after 07-20 (for example the settings card of 05.1.1-02) will not break the page (decision 3),
    but the setting then shows as a hosted row. Such plans should add the manifest metadata and no input.

---

## UI Considerations

Applicable state considerations resolved: 46 covered, 10 backstop, 0 unresolved.

| Category | Element(s) | Status | Resolution / Reason |
|----------|------------|--------|---------------------|
| empty | Manifest with no managed entry | ✅ covered | `load.empty` with "Reload settings" |
| empty | Setting without a stored value | ✅ covered | The control shows the default's state or the default as placeholder; an enum with an empty default shows `enum.unset` |
| empty | Secret not stored | ✅ covered | `secret.unset` and `secret.placeholderUnset` |
| empty | No index-compatibility warning | ✅ covered | No alert; `compat.ok` |
| empty | No index state for a backend | ✅ covered | `sync.noState` instead of the table |
| empty | Provider without a probe | ✅ covered | `test.none`; no button |
| empty | No red-team run yet | ✅ covered | `empty.title` and `empty.body` under the start control |
| empty | Finished run without a success | ✅ covered | `result.none` above the table |
| empty | No rollout, none recent | ✅ covered | `empty.title` and `empty.body`; "New rollout" above |
| empty | Rollout without per-language data | ✅ covered | `ready.noData`; no table |
| empty | Comparison cell without data | ✅ covered | `cell.none`; the verdict is the server's |
| empty | Rollout form, untouched | ✅ covered | Pressing Start rollout marks the missing fields and sends nothing |
| empty | Language addition with nothing to reprocess | ✅ covered | No dialog; `save.addedNone` |
| loading | Manifest | ✅ covered | Spinner with `load.loading` in the content host |
| loading | Index compatibility and sync status | ✅ covered | Spinner with `sync.loading`; setting rows usable meanwhile |
| loading | Test connection | ✅ covered | Spinner with `test.running` on the button; other blocks usable; 15-second client timeout |
| loading | Sync switch | ✅ covered | Switch disabled with `sync.turningOn` or `sync.turningOff`; 30-second timeout with `sync.unknown` |
| loading | Starting a run; a running run | ✅ covered | Spinner on the confirm button; then badge, progress and polling every 5 seconds |
| loading | Rollouts list and refresh | ✅ covered | Spinner with `list.loading`; refresh keeps content at 60% opacity with `aria-busy` |
| loading | Start, include, exclude, promote, roll back | ✅ covered | Spinner and in-flight text in the dialog's confirm button; both dialog buttons disabled |
| error | Manifest cannot be loaded | ✅ covered | `load.failed` with "Reload settings"; names `.env.local` as the way to edit meanwhile |
| error | 401 and 403 on the admin-backed parts of the settings section | ✅ covered | Sign-in alert with `admin.note`; setting rows stay usable |
| error | Main app stopped or admin check unavailable | ✅ covered | `admin.unavailable` with "Reload status"; `error.unavailable` for a red-team start; `list.unavailable` for rollouts |
| error | Test fails with a known or an unknown code | ✅ covered | `test.fail.<code>`, or `test.fail.other` with the code in `font-mono` |
| error | Sync switch refused or unanswered | ✅ covered | `sync.refused` or `sync.unknown`; the switch shows the reloaded state |
| error | Run fails | ✅ covered | `run.failed` with the code; start enabled again |
| error | Start while a run is running; unknown run configuration | ✅ covered | `error.busy` and the running run loads; `error.config` at the select |
| error | Run results gone; polling fails three times | ✅ covered | `error.gone` and back to the empty state; `poll.stalled` with "Refresh status" |
| error | Rollouts switched off (404) | ✅ covered | `off.title` and `off.body`; no control |
| error | Rollout start refused | ✅ covered | `start.exists`, `start.invalid` or `start.refused` at the form, which keeps its values |
| error | Invalid workspace key | ✅ covered | `tenant.keyInvalid` or `form.tenantInvalid` before any request |
| error | Promote refused | ✅ covered | The sentence for the refusal in the card and in the status region; nothing changed |
| error | Rollout changed or ended meanwhile (404) | ✅ covered | `error.changed`; the list reloads |
| error | No answer to a change | ✅ covered | `error.outcomeUnknown`; the view reloads |
| error | Language added without a baseline | ✅ covered | `error.language_baseline_missing` with the command; nothing saved |
| error | Unknown setting type, group, provider, warning code, technique, kind, state or measure | ✅ covered | A read-only row or the code in `font-mono` inside a sentence or cell; nothing throws |
| populated | Settings section at typical volume (about 130 rows in 10 groups) | ✅ covered | Open group cards, jump buttons, "Changed" counts |
| populated | Backends card with warnings, two targets and state | ✅ covered | Alert, steps, rows, one block per target, provider blocks |
| populated | Finished run | ✅ covered | Counts, table with a total row, review cases line |
| populated | Rollout card | ✅ covered | Meta lines, comparison, workspaces, the two actions |
| partial | Admin session missing while the manifest loads | ✅ covered | Rows work; the admin-backed parts show the sign-in alert |
| partial | Warning without counts in its detail | ✅ covered | `compat.backend_not_ready` alone; `compat.backend_not_ready.counts` is left out |
| partial | Run without a known total | ✅ covered | Spinner with `progress.unknown` instead of the progress element |
| partial | Run whose review cases were skipped | ✅ covered | `meta.casesSkipped`; the panel also showed `review.off` before the run |
| partial | Language without a judge score, or with too few samples | ✅ covered | The row is absent or shows `result.unmeasured`; `result.insufficient` blocks the ready line |
| zero-one-many | Counts in labels and sentences | ✅ covered | Every count is "label: number"; one sentence per language; no plural form in en, zh or it |
| overflow | 130 setting rows on one page | 🧪 backstop | Open cards with jump buttons; verify with the full manifest that every jump button moves focus to its group and that the page stays responsive while typing |
| overflow | Included and excluded lists with hundreds of keys | 🧪 backstop | 20 shown, then "Show all workspaces"; verify with 500 keys that the card stays usable and keys break at 360px |
| overflow | State table with many embedding profiles; attack table with many techniques | 🧪 backstop | Tables scroll inside focusable regions and are not paged; verify with 20 profiles and with 30 techniques in 5 languages at 360px, 768px and 1024px that the page never scrolls sideways |
| overflow | Comparison table on narrow screens | 🧪 backstop | Columns hide at 1024px and 768px; verify that Language, Measure, Candidate now and Result stay visible at 360px |
| long-text | 80-character manifest labels and 60-character env names | 🧪 backstop | Labels wrap, env names break anywhere; verify at 360px and at 200% zoom that the control stays fully visible |
| long-text | 128-character candidate ids and full tenant keys | 🧪 backstop | `font-mono break-all` in card headings, lists, dialogs and status messages; verify at 360px |
| long-text | zh and it strings in buttons, badges and dialogs | 🧪 backstop | Button rows wrap; dialog buttons stack when they do not fit; verify in zh and it at 360px in the section and both panels |
| error | Markup and script in manifest labels and help, technique labels, codes, candidate ids and tenant keys | 🧪 backstop | `textContent` only; the tests inject `<img src=x onerror=alert(1)>` and a `<script>` tag into each and assert that no element is created and that the three new scripts contain no `innerHTML` |
| partial | A secret value anywhere outside its password field | 🧪 backstop | The tests type a distinctive value, save, and assert that neither it nor any five-character part of it is in the document's text, in any attribute, in `configManager.config` after the save or in a captured console call |
| partial | A control for a managed variable existing twice | 🧪 backstop | Hosted detection; verify over the loaded page that every managed variable has exactly one row in the section and that no `id` occurs twice |

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none. No app component is added or changed; no `npx shadcn add` is run | not required |
| Third-party | none declared | not applicable; no registry is used and no package is installed. DaisyUI 4.4.24, the Tailwind Play CDN and Bootstrap Icons 1.11.3 are already loaded by the Config UI page and are not changed |

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [x] Dimension 6 Registry Safety: PASS
- [x] Dimension 7 Inventory Provenance: PASS

**Approval:** approved 2026-11-25 (gsd-ui-checker: 7/7 PASS, no blocking issues; UI-consideration probe: 8 proposed categories all already resolved in this section)
