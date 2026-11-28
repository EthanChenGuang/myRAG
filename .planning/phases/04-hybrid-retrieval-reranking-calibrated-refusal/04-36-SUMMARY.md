---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 36
subsystem: config-ui
tags: [config-ui, chunking-profiles, refusal-calibration, validator, chk-04, chk-05, rnk-05, d-17, d-21]
status: complete
requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-34 admin routes (chunking-profiles list/create/validate/report/build/activate/rollback, refusal-calibration), 04-04 chunking-profile-cases.json, 03-43 rag-fetch.js and the forwarded admin_session cookie, 04-UI-SPEC.md"
provides:
  - "scripts/config-ui/rag-panels/chunking-validate.js: browser copy of the ChunkingProfile rules, parity-tested against the Pydantic case table"
  - "scripts/config-ui/rag-panels/chunking-profiles.js: Chunking profiles panel (profiles, new-profile form, build loop, activate/rollback dialogs, sweep report)"
  - "scripts/config-ui/rag-panels/refusal-calibration.js: read-only Refusal calibration panel and the RAG Modes pointer"
  - "index.html: two section skeletons in RAG administration, three script tags, a pointer line under the Threshold refusal switch"
affects: [04-40, 04-43, config-ui]
tech-stack:
  added: []
  patterns:
    - "Panel scripts: pure view-model builders exported through module.exports for vitest, window.* globals for the page, DOM via createElement/textContent only"
    - "Messages as segments ({text}|{code}|{mono}|{time}) so commands, ids and dates render as code/span/time elements, never parsed markup"
    - "Top-level names prefixed Chunking/CHUNKING_/Refusal/REFUSAL_ or unique function names (shared classic-script scope)"
    - "A fake DOM in the test (innerHTML throws, created tags recorded) proves server strings stay text"
key-files:
  created:
    - scripts/config-ui/rag-panels/chunking-validate.js
    - scripts/config-ui/rag-panels/chunking-profiles.js
    - scripts/config-ui/rag-panels/refusal-calibration.js
    - tests/ui/config-chunking-panel.test.ts
  modified:
    - scripts/config-ui/index.html
decisions:
  - "The browser validator takes an optional context and skips a rule whose context value is missing (same as Pydantic); the panel passes none, so child_exceeds_embedding_input and top_k_parent_over_budget come only from the debounced POST /validate (UI-SPEC 14 row 1)"
  - "The build loop posts steps while more === true; a gap does not stop it; it stops on more false, Pause, a non-OK answer (499 = paused), a throw or 70 s client timeout, or three steps in a row without progress (UI-SPEC 14 row 2)"
  - "The Refusal calibration panel is the last section of RAG administration; the RAG Modes tab gets only a pointer line and an Open refusal calibration button next to the unchanged #RAG_REFUSAL_THRESHOLD switch (UI-SPEC 14 row 3)"
  - "Whether a passing decision is recorded is shown from GET /report (committed decision per doc type) plus the help line; the database answer arrives as the 409 gate reason, shown as a sentence (UI-SPEC 14 row 4)"
  - "Panels bind their init to every [data-tab=rag-administration] link at DOMContentLoaded (scripts load in <head>), guarded against double binding"
metrics:
  duration: "about 40 min"
  completed: 2026-11-25
actuals:
  tokens: 69400
  tasks: 3
  commits: 9
plan_head_before: fbf8d79ac9d0d27e7fc56035ab22c64b90d77bff
plan_head_after: 7be22e263b134947b10c3ae431a7b38b689269d2
---

# Phase 4 Plan 36: Config UI chunking profiles and refusal calibration panels Summary

**Admins can create, build (in resumable 45 s steps), compare, activate and roll back chunking profiles per document type from the Config UI, with a browser validator that matches the Pydantic rules row by row, and read every refusal threshold cell with its point estimate, 95% upper bound and the route's warnings in zh, en and it.**

## Tasks

| Task | Name | Commits |
|------|------|---------|
| 1 | JS chunking validator with the Pydantic parity test | fd0fbcde (RED), f9d7a2e9 (GREEN) |
| 2 | Chunking profiles panel with build, activate, rollback and the report view | abc89d60 (RED), 9c04cc3f (GREEN) |
| 3 | Refusal calibration status panel | f5e0ca1b (RED), 3e3bacde (GREEN) |
| Design pass | Impeccable and web-design-guidelines fixes | a88bcffa, c7671819 |
| Gate fix | Typed test fixture so tsc passes | 7be22e26 |

RED evidence (semantic): each RED commit shipped a stub module with the planned exports, so every target test loaded and failed on its assertion (Task 1: 11 of 13 failed on expected-vs-received findings; Task 2: 31 failed, two of them as a TypeError on the empty group list the stub returns; Task 3: 14 failed). No RED failure was a load or syntax error.

## What was built

- **Validator** (`chunking-validate.js`): same codes and order as `chunking_profile_findings` and `validate.ts`; context `maxChildTokens`/`topK`/`contextBudget` (snake_case accepted); sizes that are not whole numbers of 1 or more answer `invalid_shape`; presets 128/512, 256/1024, 256/2048 expand with structure parents, custom keeps typed values. No imports; runs as a classic script.
- **Chunking profiles** (`chunking-profiles.js`): Profiles and Sweep report sub-tabs (roving tabindex, arrow/Home/End). Six doc-type blocks in fixed order with the active pointer, since-date, committed sweep decision line, Roll back profile, gate-refusal alert, coverage warning (`missing_from_active` count, legacy-chunks sentence, Build missing documents; `null` shows the could-not-count line), and a table with sizes, status badge, documents built and exactly one next-step button. Legacy rows never show sizes/mode/preset. New-profile form: preset radios, readonly preset sizes, structure/fixed, suggested `p{child}-{parent}-{doc_type}` id, local findings as typed, server check 400 ms after the last change, Create disabled on any hard error. Build region with `<progress>`, counts, gap line, Pause build; outcomes completed/repaired/none/incomplete (gaps by reason with the dry-run command)/failed/stalled/paused and every section 8 error. Activate and Roll back behind a native `<dialog>` with default focus on Keep current profile; 409 shows `gate.<reason>` as an alert in the type's block. Sweep report: fixture notice, decisions table, slice select (overall, doc types, languages, question kinds), comparison with Recall@k, MRR, false/correct refusal rate cells (point estimate, 95% upper bound, n, neutral mark), judge correctness or its skipped notice, context tokens, latency p50/p95, regressions in a `details`, English notes marked `lang="en"`.
- **Refusal calibration** (`refusal-calibration.js`): summary (pipeline, threshold refusal, reranker, score type), model matrix per use and question language, versions line, notes for legacy pipeline / refusal off / saved-but-not-restarted switches (reads only `#RAG_REFUSAL_THRESHOLD` and `#RAG_RERANKER`), one alert per warning in route order (languages named via `Intl.ListFormat`, missing tier/model/language list, stale count without raw keys, unknown codes shown as the route message in English), thresholds table with status/fixture/stale badges, threshold, dev and holdout rate cells, legend. One `GET`, one Refresh status button, no input.
- **index.html**: script tags after `ingestion.js` in the order validate, profiles, refusal; the two `section` skeletons (heading, description, alert host, content host, polite status region); updated tab intro sentence; pointer line under the refusal switch (the switch and its id unchanged).

## Behaviour changes

- Two new sections in the Config UI's RAG administration tab and a pointer line on the RAG Modes tab. They call only `/api/rag/admin/chunking-profiles*` and `/api/rag/admin/refusal-calibration` through `ragFetch`. Without an admin session they show the shared sign-in message with the app address; the RAG Modes tab still works without a session.
- No env variable, route, migration or package added. Existing Config UI behaviour unchanged.

## Deviations from Plan

### UI-SPEC overrides (section 14 rows 1-4), applied as instructed
1. Validator context: the plan filled it from the list route, which returns none. The validator skips context rules; the panel relies on POST /validate for them. The parity test runs every case-table row with the full context, and a second test proves the skip.
2. Build loop: runs while `more === true`; a gap does not stop it (plan said "until ready or a gap").
3. Refusal panel lives in RAG administration with a pointer next to the switch (plan: next to the switch).
4. Passing decision: shown from GET /report and learned from the 409 reason (plan: "shows whether a passing decision is recorded").

### Auto-fixed / design-driven
1. **[Rule 1 - Bug] Page-wide horizontal overflow.** Found in the design pass render: a wide table inside a `.grid` item made every grid item as wide as the table. Fix: the two new sections are `min-w-0`, so tables scroll inside their focusable region. Commit a88bcffa.
2. **[Rule 2 - Accessibility] Warning-coloured text** (`text-warning`) fails 4.5:1 in the light theme. Warning finding lines, the Missing line and the build gap line use body text with a warning icon instead. Commit a88bcffa. (UI-SPEC sections 6.3/6.4 named `text-warning`.)
3. Badges with multi-word labels overflowed DaisyUI's fixed-height pill; they are now `h-auto whitespace-nowrap`, and id/model/status columns have a minimum width. Commands in prose wrap at word boundaries (`break-words`) instead of mid-token. Commits a88bcffa, c7671819.
4. The Sizes cell's second line is two lines (preset, then parent mode) rather than one joined line, to avoid locale-specific joining punctuation.
5. Extra label keys beyond the UI-SPEC tables: `action.continueAria`, `action.buildMissingAria`, `build.region`, `report.decisionsCaption`, `report.comparison`, `cell.noItems` (accessible names and captions the spec's structure required).
6. Panel init binds at DOMContentLoaded as well as at load, because the scripts load in `<head>` (see Deferred).
7. The plan's helper `refusalMessage` is exported under that name from `chunking-profiles.js`, but the global function is `chunkingRefusalMessage` (naming rule).
8. Test file uses a small fake DOM (no jsdom in the repo; no package installed).

## Design skills

| Skill | Outcome | What it found and changed |
|-------|---------|---------------------------|
| frontend-design | pass | Direction was fixed by the approved 04-UI-SPEC (Operate mode, DaisyUI tokens, one signature element: the rate cell with point estimate, 95% upper bound bar and n, neutral colour). Built within it: no stat tiles, no cards per profile, no stepper, inline form, dialogs only for activate/rollback, no colour judgement on rates. |
| Impeccable (craft-floor, mode-operate, polish references; rendered with headless Chrome against a local harness, no network launcher) | pass | Found: page-wide overflow from wide tables in grid items; badge text spilling out of fixed-height pills; ids and model ids broken into one-character columns; commands split mid-token; warning-coloured text unreadable on the light theme. Changed: `min-w-0` sections, `h-auto whitespace-nowrap` badges, minimum widths on id/model/status columns, `break-words` for commands, body-text warning lines with a warning icon. Re-rendered at 1280 px (dark and light) and 375 px to confirm. |
| web-design-guidelines (pinned references/command.md, all three scripts, the test-visible index.html skeletons and pointer) | all findings resolved | Found and fixed: form controls without `name` (added), number inputs without `autocomplete="off"` (added), straight quotes and apostrophes in copy (curly), identifiers and commands without `translate="no"` (added), dialog without `overscroll-behavior: contain` (`overscroll-contain`), headings without balanced wrapping (`text-balance` on block and dialog titles), flex text bodies without `min-w-0` (added), scroll target without scroll margin (`scroll-mt-4`). Recorded as intentional per the approved UI-SPEC, not defects: sentence-case labels instead of Title Case (copy contract section 12), Create profile disabled while a hard error is shown with the reason referenced by `aria-describedby` (section 6.4), sub-tab state not mirrored in the URL (the page's top-level tab owns the hash, same as the sibling RAG panels), `autofocus` on Keep current profile (section 6.6 default focus). Dialog backdrop close button has an accessible name (`aria-label` "Keep current profile") and `tabindex="-1"`. |

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors (after 7be22e26).
- `npx vitest run`: 234 files, 3574 passed, 1 skipped. Targeted `tests/ui/`: 8 files, 117 passed (new file: 64).
- `node --import tsx --test tests/*.test.mts`: 166 pass.
- `node --import tsx --test tests/rag-db/*.test.mts`: 871 pass, 6 fail, 2 cancelled: `queued process-document identity` (5), `ingestion dead letter` (1) and the optional real-PostgreSQL ledger test, the same pre-existing set 04-34 reported on base 2dcccafe. This plan touches no file they import.
- `node scripts/ci/check-rag-boundary.mjs`: ok, 1067 files; its node test 38 pass.
- `node scripts/check-config.mjs`: ok, 125 variables. `python3 scripts/ci/check-workflows.py`: OK.
- ESLint on the three scripts and the test file: 0 errors (test warnings are the usual unused names in type signatures).
- `node --check` on the three scripts: ok.
- Python, contracts, retrieval and ingest not touched: sidecar/eval pytest, `gen:schemas` and `test-rag` gates do not apply.
- `node scripts/ci/check-frontend-design-summary.mjs <phase dir>`: fails phase-wide because 40 earlier summaries in this phase have no Design skills section (the gate checks every summary once a UI-SPEC is in the phase dir); this summary's own section satisfies the gate's rules.
- Acceptance greps: Task 1 `chunking-profile-cases.json` in the test: 2 (EXPECT ≥1). Task 2 `chunking-profiles.js` in index.html: 1; `/api/rag/admin/chunking-profiles` in the panel: 2; `missing_from_active`: 1. Task 3 `refusal-calibration.js` in index.html: 1; `95%` in the panel: 12.
- Human check (plan Task 2) not run: needs the live app with an admin session; covered by the fake-DOM flow tests (form, build loop with gaps, activate 409 no_evidence).

## Threat Flags

None beyond the plan's threat model. T-04-77: only `ragFetch` (no `fetch(`), no Authorization header, no storage, no password field (tests assert). T-04-78: no `innerHTML`/`insertAdjacentHTML` (static test plus a fake DOM whose `innerHTML` throws); markup in a profile id, a report profile id, a report note, a model id and a warning message renders as text; `activated_by`, `run_id`, `config_hash`, `decided_by`, `report_hash`, cell keys and per-cell versions are never rendered.

## Known Stubs

None.

## Deferred Items

- The Ingestion panel passes the literal `{appUrl}` to the shared sign-in label (`ingestion.js`, `mapIngestionError`), so its message shows the placeholder. Out of scope per the brief; the new panels fill the address.
- The Ingestion panel binds its tab-link listeners while its script runs in `<head>`, before the links exist, so a click on RAG administration does not start it (only a page loaded with that tab active does). Document types and Embedding profiles bind at DOMContentLoaded but only to the first link, so the mobile drawer link does not start them (UI-SPEC finding 14). The new panels bind every link at DOMContentLoaded. Fixing the older panels is a separate change.
- Phase-wide frontend-design SUMMARY gate fails on the 40 earlier summaries (see Gates).
- Pre-existing rag-db failures listed above.

## Self-Check: PASSED
