---
quick_id: 261127-pbr
branch: exec/quick-packing-budget-routes
base: origin/exec/05.2.1-20 (2ae169ac)
status: complete
follows: 05.2.1-20 (Deferred, items 1 and 2)
---

# Summary: packing budget in the product routes, framing counted in packing

05.2.1-20 left two follow-ups. Both are fixed. The chat, embed and voice-rag routes now pass the raw-token packing budget. Packing now counts the assembly framing, so the built context stays within the document budget and finalize no longer refuses it by a few tokens. The two budget-overflow runs end with 0 `answer_error`, down from 3.

## Commits
| Step | Commit |
|---|---|
| 1 RED: routes pass `packingBudget`; off parity for embed and voice | `72899770` |
| 1 fix: chat, embed, voice-rag | `f2e430b4` |
| 2 RED: rendered context within the budget (legacy and v2); `packAndBuild` stub with today's single pass | `6d3144a7` |
| 2 fix: `fitRendered`, legacy `packAndBuild`, v2 assemble stage | `a317392f` |
| SUMMARY | this commit |

## 1. Routes pass `plan.packingBudget`
- `src/app/api/chat/route.ts`: `documentTokenBudgetOption` uses `promptBudgetPlan.packingBudget`. The replan at the question-last check still uses `documentBudget` as its target, which is correct because targets are in scaled tokens.
- `src/app/api/embed/chat/route.ts`: `documentTokenBudget: budgetPlan.packingBudget`.
- `src/app/api/internal/voice-rag/route.ts`: `VoiceBudget` gains `packingBudget`. With a window, it is the planner's. Without a window it is `floor(voice_document_budget / factorFor(null).factor)`, so both paths use one unit. The trace's `documents` count stays the scaled value. `factorFor` is now exported from `@/lib/rag`.
- All three changes apply only with `RAG_PROMPT_BUDGET` on. When it is off, no plan exists and no `documentTokenBudget` is sent.

## 2. Framing counted in packing (the 05.2.1-04 code)
- I chose to measure with the real assembly instead of adding a fixed overhead per block. The framing varies too much for a constant: section markers, `\n\n` separators, the grouped `(N relevant chunks)` header, citation label headers, version lines, context tagging, the identifier suggestion line, and the truncated first block's rendering.
- `fitRendered(budget, attempt, renderedOf, { start })` in `src/lib/rag/context/pack.ts` packs, then counts the rendered context with the same cl100k counter. While the count exceeds the budget, it repacks with the budget lowered by the overshoot, up to 4 attempts. Two attempts is the usual case.
- Legacy: `packAndBuild` wraps `packFiltered` + `buildContext` and is used in `src/lib/rag/pipeline.ts`. `packing.documentBudget` reports the caller's budget.
- v2: the assemble stage body is now `assembleWithin(packBudget)` in `src/lib/rag/v2/stages/context.ts`. At a lowered budget, the parent selection is redone from the same pool (`parentPool`, kept in step with the injection-check reselection). The measured text is the context the request actually gets: rendered with the citation labeler when one is set, plus the suggestion line. The target is the caller's `documentTokenBudget`, and packing starts at `min(profile, caller)`. `budget_tokens` and `packing.documentBudget` are unchanged.
- When `documentTokenBudget` is absent, both paths run exactly the code they ran before: one selection and one render, with no extra measurement render.
- The framing floor is about 40 tokens for one labelled block (header, section markers, label, one body token). A budget below that cannot be met. In that case the first block stays at its smallest truncation, and finalize still decides. A test pins this.

## Behaviour changes (only with `RAG_PROMPT_BUDGET` on)
- Retrieval gets about `documentBudget / factor` raw tokens instead of `documentBudget`. With the default factor of 1.25, that is 3000 → 2400.
- The built document part now re-estimates to at most the planned budget. A lowest-ranked block that only fit by the per-block estimate is dropped. In the v2 run the first pass overshoots, so a large parent block is dropped (`en-context-overflow-001`: 1,211 documents, 7 dropped). Before, the same item was refused. Later smaller blocks still fill the space, because selection skips and does not stop.
- Off: chat, embed, voice and eval requests and outputs are byte-identical. Strict "information not available", webSearch with Exa, `source_images`, `{{context}}`, voice and embed are untouched.

## Tests that failed before the fix
- `tests/rag/context/prompt-budget-routes.test.ts` (chat): 2 failed, e.g. `expected 3000 to be 2400` and `expected 2677 to be 2141`.
- `tests/rag/context/prompt-budget-embed-route.test.ts`: 2 failed (`expected 4368 to be 3494`, `expected 500 to be 400`).
- `tests/rag/context/prompt-budget-voice-route.test.ts`: 3 failed (`expected 822 to be 657`, `expected 2000 to be 1600` twice).
- Off parity: chat already had a test (unset equals explicit false, no `documentTokenBudget`). New tests were added for embed (same retrieval options and model request, unset vs `false`) and voice (byte-identical body, same retrieval input). They pass before and after, as intended.
- `tests/rag/context/pack.test.ts` `packAndBuild`: 9 failed, e.g. `expected 170 to be less than or equal to 154` and `expected [ 'p1', 'q1' ] to deeply equal [ 'p1' ]`.
- `tests/rag/v2/document-budget.test.ts`: 3 failed (`expected [ 'k1', 'k2', 'k3' ] to deeply equal [ 'k1', 'k2' ]`, `expected 244 to be ≤ 226`, `expected 258 to be ≤ 226`).
- After RED, two test budgets turned out to be below the framing floor: 38 labelled in the legacy test and 40 labelled in the v2 test, both impossible to meet. In the fix commit they were raised to 60 and 70, and a test was added for the infeasible case. The old v2 test "packs to the smaller of the option and the profile budget" used a budget of two blocks plus 5 by the estimate. It now uses three blocks plus 5 and expects two kept, which is the framing-aware result.

## Verification runs (fixture)
| Run | Exit | answer_error | fake_window_exceeded / question_not_last | Watched items |
|---|---|---|---|---|
| `--run-config eval/config/runs/budget-overflow-legacy.json --out eval/out/quick-pb-legacy` | 0 | 0 of 413 items | 0 / 0 | `zh-duplicate-flood-002`: ok, documents 2,194, 7 dropped (was `prompt_budget_exceeded`) |
| `--run-config eval/config/runs/budget-overflow-v2.json --out eval/out/quick-pb-v2` | 0 | 0 of 413 items | 0 / 0 | `en-context-overflow-001`: ok, 1,211, 7 dropped; `-002`: ok, 1,213, 7 dropped (both were `prompt_budget_exceeded`) |

## Note for the orchestrator: plan 05.2.1-23
05.2.1-23-PLAN.md line 110 already requires "budget-overflow-legacy and budget-overflow-v2 pass with overflow_error_rate 0". That gate no longer needs to be read as "expected to fail". 05.2.1-20's SUMMARY said plan 23 should expect the finalize refusals "until it is fixed", and that is now fixed. The plan needs no change, but any orchestrator note that relaxes it should be dropped once this branch is merged. No other plan file was edited.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: no errors
- `check-rag-boundary`, `check-config`, `check-language-literals`, `check-settings-classification`: exit 0
- vitest, targeted: the 5 changed test files, 60/60.
- vitest, full run (`pipeline.ts` and v2 context are core): 16,093 passed, 90 skipped, 1 failed. The failure was the timing benchmark `tests/rag/scope/score.test.ts` "p99 under 5 ms", which ran under load while the smoke runs were going. Rerun alone, 17/17 pass. It does not touch the changed code.
- `npm run test-rag -- --out eval/out/quick-packing-budget`: exit 0, gate PASS. The absolute gate's report-mode FAIL is the known pre-existing `false_refusal_rate language:en` (0.3133 vs 0.25), the same as in 05.2.1-20.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/quick-packing-budget-ingest`: exit 0, gate PASS, absolute gate PASS (enforce)
- Both budget-overflow runs above: exit 0
- Not run: rag-db (no SQL), workflows check, UI checks, `gen:schemas` (no contract change)

## Deviations
- Voice without a window also converts the fixed voice budget to raw tokens, for a consistent unit. This was not named in the task, which only said the route should use `packingBudget`.
- The voice agent's own packing (`packVoiceChunks`) is unchanged. Voice has no finalize step, and each voice unit is already estimated as the agent renders it.

## Operator actions
None. No migration, no live call, no Supabase or Vercel change.
