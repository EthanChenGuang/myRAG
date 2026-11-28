---
quick_id: 261128-qnu
slug: phase52-nyquist-ui
branch: exec/quick-52-nyquist-ui
base: origin/exec/quick-52-fixes (6d8953d8)
date: 2026-11-28
source: origin/verify/05.2-audits (c367467a) 05.2-VALIDATION.md, 05.2-UI-REVIEW.md
status: complete
key-files:
  modified:
    - src/lib/rag/generation/sentences-record.ts
    - src/lib/rag/generation/answer-collector.ts
    - src/app/api/internal/rag/run/route.ts
    - src/lib/answers/sentence-reason.ts
    - src/lib/answers/read.ts
    - src/lib/chat/answer-metadata.ts
    - rag-sidecar/src/rag_sidecar/contracts/answer_checks.py
    - scripts/gen-zod.mjs
    - src/lib/rag-eval/contracts.generated.ts
    - scripts/config-ui/rag-panels/security-events.js
    - scripts/config-ui/index.html
    - src/components/ui/sentence-mark.tsx
    - src/components/ui/answer-notices.tsx
    - tailwind.config.ts
---

# Quick 261128-qnu: Phase 5.2 Nyquist gaps and UI review fixes

This task closes the remaining Nyquist gap (G3) and adds the G1/G2 store-seam test from `05.2-VALIDATION.md`. It also fixes all six UI review findings from `05.2-UI-REVIEW.md`. G1 and G2 themselves (the model refusal being cached and logged as an answer) were already fixed on `exec/quick-52-fixes`.

- No switch was added and no default changed.
- No SQL and no package changed.
- With every switch off, chat, embed, voice and eval output is unchanged. G3 only touches sentence records, and those exist only while `RAG_CITATION_PER_SENTENCE` or `RAG_CLAIM_CHECK` is on.

## Commits

| Item | RED (fails on the old code) | Fix |
|---|---|---|
| A1 G3: `not_checked` sentences had `reason: null`, and Zod did not enforce the rule | a49220be (4 of 4 failed on assertions) | 4b6b1a6f |
| A2 G1/G2 store-seam test | — (new coverage of fixed behaviour; see below) | 39f8c69f |
| A3 `05.2-VALIDATION.md`: gaps moved to the automated map, `nyquist_compliant: true` | — | b432f9de |
| B1 HIGH: Events table at 360px | dda49c2d | f5fab7c4, 2fc1244a, plus the follow-up "Events time sets no title attribute" |
| B2/B3 MEDIUM: hex focus ring and dark notice colours | b1fa333f | c4345a76 |
| B5/B6 LOW: number input width, dark warning banner | b1fa333f | ebce0ca2 |
| B4 LOW: UI-SPEC §4 exceptions (plus §10 and §13.1 kept in step) | — | 0dc54910, plus the datetime wording follow-up |
| UI re-audit (`05.2-UI-REVIEW.md`) | — | "docs: 05.2 UI re-audit after fixes (21/24)" |
| `.planning/ui-reviews/.gitignore` (keeps captures out of git) | — | chore commit |

## Behaviour changes

**G3, chat path.** `buildSentenceRecords` takes `claimCheck`. Each `not_checked` record now carries a reason:

- `claim_check_not_run` while `RAG_CLAIM_CHECK` is on; the claim step then overwrites it for the factual sentences it labels.
- `claim_check_off` while the check is off.

The answer collector passes `turn.config.claimCheck`. The eval route (`internal/rag/run`) now uses the same option instead of patching the reason afterwards; its output is unchanged.

**G3, contract.**
- `AnswerSentence` exports its `not_checked → reason` validator rule as JSON Schema `if`/`then`.
- `scripts/gen-zod.mjs` turns an object's `if`/`then` (no `else`) into a `.superRefine` through json-schema-to-zod's `parserOverride`. Before this, the library dropped `if`/`then` on object schemas.
- The generated Zod schema now rejects a `not_checked` sentence without a string reason.
- `gen:schemas` diff, as expected: four schema JSON files (`AnswerSentence`, `AnswerChecks`, `AnswerRecord`, `RagTrace`) and the `AnswerSentence` occurrences in `contracts.generated.ts`. `samples.json` and `texts.generated.ts` are unchanged.

**G3, records stored before this fix.** Message metadata and `rag_answer_records.checks` rows may hold `reason: null`. They read back as `claim_check_off` through `withLegacySentenceReasons` / `withLegacyChecksSentenceReasons` in `pickAnswerMetadata` and `toAnswerRecord`. Without this, the new Zod rule would have dropped their marks and checks.

**B1, Events table below 768px.**
- Two visible columns: Time and Check.
- Result is stacked under the check badge, above the document and uploader lines. The Result column is `max-md:hidden`.
- Time shows a compact date line and time line through `Intl.DateTimeFormat`, with the year only outside the current year. The full value stays in the `datetime` attribute.
- The panel sets no `title`, as the Config UI XSS test requires.
- Measured at 360px: table scrollWidth equals clientWidth (231px), and there is no page overflow at 360 or 1440. Desktop keeps 6 columns and the full time.

**B2, mark focus ring.** It uses `focus-visible:ring-chat-accent-ink`. Contrast: 4.9:1 on the light canvas, 7.2:1 on the dark surface, 8.2:1 on the dark canvas (measured with Playwright).

**B3, dark neutral notice.** It uses `dark:bg-chat-surface dark:ring-chat-hairline`.

`tailwind.config.ts` gains `chat.surface`, `chat.hairline` and `chat.accent-ink` as aliases of the existing `chat-shell.css` variables. No new CSS variable was added.

**B5.** The uploader-alert threshold and window inputs are `md:max-w-40`: 160px on desktop, full width at 360px.

**B6.** A new dark-theme rule keeps `.card .alert-warning` text, its heading and its link in the warning content colour. Before, the card heading and body overrides turned that text white on amber.

**B4.** UI-SPEC §4 now lists `gap-3`, `pl-8`, `px-2.5`/`py-1.5` and `gap-y-1` as inherited exceptions. §10 describes the stacked Events layout. §13.1 names the chat tokens.

## Tests added

- `tests/rag/generation/sentences-record-reason.test.ts` (5 tests) covers:
  - the reason with the claim check off and on;
  - the `buildSentenceRecords` default;
  - the generated Zod schema enforcing the rule;
  - legacy `reason: null` records loading from metadata and stored checks.
  The legacy test fails with the read normalizer reverted.
- `tests/rag/generation/sentinel-cache-store.test.ts` (3 tests).
  - It references the existing route tests instead of repeating them: `tests/rag/chat-cache-hit.test.ts` (G1) and `tests/rag/embed-cache.test.ts` (G2 and the log outcome). A guard test fails if those route tests are removed.
  - It adds the seam between them and the backend: a sentinel split across tokens goes through the real answer chain, then `refusedByModel()`, then `scheduleCacheStore`, then the pgvector backend.
  - The resulting row has `p_is_refusal: true`, the refusal TTL, no sources and `groundedness not_checked/refusal`. A plain answer is the positive control.
- `tests/ui/config-security-events-panel.test.ts`: "Events below 768px …" (Result stacked, Result column hidden, compact time, no `title`).
- `tests/ui/p52-ui-review-fixes.test.ts` (4 tests): token classes instead of hex, input cap, dark warning rule. All 4 failed before the fixes.
- Existing fixtures that encoded `reason: null` now use `claim_check_off`: `tests/rag/generation/sentences-record.test.ts`, `answer-checks-record.test.ts` and `tests/lib/answer-metadata.test.ts`.

## Gates run

| Gate | Result |
|---|---|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors; 0 legacy diagnostics ignored |
| `npm run gen:schemas` | the regenerated output equals the committed files; the change itself is the expected `AnswerSentence` diff above |
| `node --test scripts/tests/gen-zod.node-test.mjs` | 9 pass |
| sidecar contract pytest (`uv run --extra chunking pytest -q -k contract tests/`) | 1496 passed, 1 skipped; also `test_phase52_contracts`, `test_phase52_eval_contracts`, `test_answer_contracts`, `test_contract_export`, `test_golden_contract`: 287 passed |
| `npx vitest run tests/ui` | 100 files, 2089 passed (rerun after the no-`title` fix). The first run failed 1 test in `config-ui-xss.test.ts` ("… create no element, link or title"), because the new time element had a `title` |
| related vitest: every test importing a changed module, plus `tests/rag/generation`, `chat-cache-hit` and `embed-cache` | 190 files, 3326 passed, 1 skipped |
| `node scripts/ci/check-frontend-design-summary.mjs` on the 05.2 phase directory and on this quick directory | PASS |
| `check-config`, `check-rag-boundary`, `check-language-literals`, `check-settings-classification`, `check-zod-isolation` | all exit 0 |
| `npm run test-rag -- --out eval/out/quick-52-nyquist-ui` | gate PASS (7 skipped), exit 0. The report-only absolute gate reads `false_refusal_rate language:en 0.3133 > 0.25` on the legacy strict default. That is the same value quick 261128-q52 measured before this task (0.3133; main 0.3143), so it was already there. It does not change the exit code |

Not run, because nothing here touches them: PGlite `tests/rag-db/*` (no SQL), eval pytest (no eval Python change), the full vitest suite (no `env.ts`, test setup or core RAG types changed), and the ingest fixture mode of test-rag.

## Design skills

| Skill | Outcome |
|---|---|
| frontend-design | n/a: no new interface. The fixes follow the existing direction in UI-SPEC §1 and only restyle existing elements |
| Impeccable | pass. Critique of the 360px Events rows: hierarchy is badge, then Result (text-sm), then document and uploader (text-xs /70); no sideways scroll. Colour: tokens only, non-text contrast at least 3:1 in both themes. Dark banner contrast restored. One LOW item stays open from the re-audit: long source badges at 360px |
| web-design-guidelines | pass, all findings resolved on every touched file. `security-events.js`: `Intl.DateTimeFormat`, `datetime` kept, `tabular-nums`. `sentence-mark.tsx`: `focus-visible` ring replaces the outline, `touch-manipulation`, tap highlight set. `answer-notices.tsx`: no change to semantics. `index.html`: inputs keep label, `name`, `inputmode` and `autocomplete="off"`. `tailwind.config.ts`: config only |

Screenshots were taken with Playwright into `.planning/ui-reviews/05.2-20261128-002609-fixes/` (16 PNGs, gitignored).
- The Config UI was served by `scripts/config-server.js`, with `ragFetch` mocked.
- The chat views come from an SSR harness compiled with the project Tailwind config.

`/gsd-ui-review 5.2` re-audit (gsd-ui-auditor): **21/24**, up from 18/24.

| Pillar | Score |
|---|---|
| Copywriting | 3 |
| Visuals | 3 |
| Color | 4 |
| Typography | 4 |
| Spacing | 4 |
| Experience Design | 3 |

The remaining items are LOW:
- long source badges at 360px;
- confirm the zh/it badge texts in the real chat once;
- the number of tab stops on uncited marks.

## Deviations

- The 05.2 audit files (`05.2-VALIDATION.md`, `05.2-UI-REVIEW.md`, `05.2-UI-SPEC.md` sign-off) came from `origin/verify/05.2-audits` by path checkout, so they could be edited here. No branch was merged.
- B1: the first layout put Time on one line (`whitespace-nowrap`). The 360px screenshot showed it still pushed Check past the region by 47px, so the compact time is now two short lines.
- B1: the first version gave `<time>` a `title` holding the full value. The Config UI XSS test forbids `title` on panel output, so it was removed. The full value stays in the `datetime` attribute.
- G3: a read normalizer for stored `reason: null` records was added. It was not in the brief, but without it the new Zod rule would hide marks and checks already saved in metadata or answer rows.
- The groundedness badge and the citation chip still use `ring-[#FF6417]/60` and `#2A2A2A`. They were outside the listed findings and were left as they are.
- No PLAN.md, matching the previous quick task (261128-q52).

## Decisions for STATE

- A `not_checked` sentence always carries a reason: `claim_check_off` or `claim_check_not_run` before any check runs. The rule is enforced in Pydantic and in the generated Zod schema.
- gen-zod supports an object `if`/`then` without `else` as a Zod refinement. Pydantic model validators that can be written this way should be exported as `if`/`then` instead of hand-written Zod.
- Chat colour tokens in Tailwind are `chat.surface`, `chat.hairline` and `chat.accent-ink`, aliases of the `chat-shell.css` variables. New chat UI uses them instead of hex values.

## Requirement IDs

GEN-09 and GEN-10 (sentence reason), GEN-15 / D-16 (sentinel refusal in the cache: test coverage), plus UI-SPEC §4, §10 and §13.1 for the phase's UI requirements.

## Operator actions

None new. `05.2-LIVE.md` from quick 261128-q52 still applies.
