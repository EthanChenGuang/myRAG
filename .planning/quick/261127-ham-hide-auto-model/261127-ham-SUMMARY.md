---
quick_id: 261127-ham
status: complete
branch: exec/quick-hide-auto-model
base: origin/ci/merge-train-39 (c6f1b3f7)
gap: Phase 6.2 verification G3
key-files:
  created:
    - src/lib/chat/auto-model.ts
    - tests/lib/auto-model-selection.test.ts
  modified:
    - src/lib/rag/deps.ts
    - src/lib/rag/index.ts
    - src/app/api/config/models/route.ts
    - src/components/providers/model-provider.tsx
    - src/app/api/chat/route.ts
    - src/app/api/embed/chat/route.ts
    - tests/rag/** (10 route fixtures, one-line change each)
---

# Summary: the Auto model entry stays hidden until model routing is effective

The `{ id: 'auto', displayName: 'Auto' }` entry was added by **06.2-02** (commit `c65dd44c`), not 06.2-07. 06.2-07 is the Glossary view and does not touch model lists.
06.2-02's SUMMARY already flagged the risk: "selecting Auto sends the id `auto` to the provider, which fails. Merge 06.2-29/35 first, or remove the row."
This task hides the entry. It does not delete it. The five model locations (AGENTS.md §7) are unchanged.

## What changed
- `src/lib/chat/auto-model.ts` (new, pure) holds the one shared rule:
  - `isAutoModelSelectable(routing, models)` is true only when the effective `RAG_MODEL_ROUTING` is `auto` and both `RAG_ROUTING_FAST_MODEL` and `RAG_ROUTING_QUALITY_MODEL` are non-empty, are not `auto`, and appear in the OpenRouter list.
  - `withoutUnselectableAuto` removes only the Auto entry and keeps the order of the rest.
  - `defaultModelId` returns the list's `isDefault` entry, otherwise the first entry that is not `auto`, otherwise the caller's fallback.
  - `resolveStoredAutoModel` maps `auto` to the default model. It logs `[Model Selection] Auto is not resolvable yet, using the default model` once per process per surface and never throws.
- `currentModelRouting()` (`src/lib/rag/deps.ts`, exported from `@/lib/rag`):
  - It reads the effective mode through `loadRagConfig`, so `auto` counts only with `RAG_PIPELINE=v2` and `RAG_QUERY_LAYER=true`.
  - It returns the raw routing ids.
  - It is needed because `readRagEnvInput()` does not pass the three routing variables yet. Before this change, `modelRouting.mode` was always `off` at runtime.
- `GET /api/config/models?for=chat`:
  - With this parameter, all three lists drop Auto unless it is selectable. A failure to read the routing config hides Auto.
  - Without the parameter (Config UI read and save), the stored lists come back unfiltered, so saving in the Config UI never deletes the entry.
- `model-provider.tsx` (chat selector) asks with `for=chat`. Its client-side env fallback always hides Auto, because the browser cannot see `RAG_MODEL_ROUTING`. A saved `auto` in localStorage is no longer in the list, so the existing code switches it to the default model.
- Server fallback for a stored or sent `auto`:
  - The chat route resolves `settings.model` to the default model of `NEXT_PUBLIC_OPENROUTER_MODELS` (fallback `openai/gpt-4o-mini`, the route's old default).
  - The embed route resolves `auto` to `defaultEmbedModel()`.
  - Both log once and return no error.

## Decisions
- A stored Auto falls back to the **default model** (the list's `isDefault` entry), as the task asked. That holds even while Auto is visible, because no router exists yet. D-19's "Auto resolves to the quality model" belongs to 06.2-29/35. Their `resolveRequestedModel` replaces `resolveStoredAutoModel` at the same call sites.
- The filter is opt-in (`for=chat`) instead of on by default, so the Config UI's read-modify-write keeps the Auto entry.

## Tests that failed before the fix (RED `5a345301`, 6 assertion failures)
- Routing off: the list has no Auto entry (pure helper and `GET ?for=chat`).
- Routing on but a routing id empty, `auto` or not listed: no Auto entry.
- Hiding keeps the other entries in order.
- The default model is the `isDefault` entry and never `auto`.
- A stored `auto` resolves to the default model and logs once.
- Already passing on the old code, as intended: routing on with both ids configured shows Auto; the Config UI read keeps Auto; an explicit model passes through.
- Added in GREEN: `currentModelRouting` against the real config. Defaults give `off`; `RAG_MODEL_ROUTING=auto` without the query layer gives `off`; v2, the query layer and `auto` give `auto` with the raw ids.

## Side effect found by the full suite (commit `7be8c2ed`)
- Ten chat and embed route tests picked "the first non-GPT, non-Claude model id" from the env list. Since 06.2-02 that id is `auto`, so they were sending `auto` to a mocked provider.
- With this fix the route resolves it to the default model, and three assertions on `modelId` and the output-guard text failed.
- The fixture pick now skips `auto` (one line in each file). This was a test-fixture bug, not a behaviour regression.

## Gates run
| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `node scripts/check-config.mjs` | ok |
| `node scripts/ci/check-rag-boundary.mjs`, `check-language-literals.mjs`, `check-settings-classification.mjs` | ok |
| `npx vitest run tests/rag/model-context-length.test.ts tests/ui/config-model-list.test.ts tests/lib/auto-model-selection.test.ts` + importers of the changed modules (40 files) | 485 passed |
| Full `npx vitest run` (deps.ts and index.ts changed) | 851 files passed, 2 files / 3 tests failed (the fixture issue above) |
| The 10 fixed route test files after the fix | 108 passed |

Not run (area not touched): rag-db, node:test, workflows, Python, gen:schemas, test-rag.

## Design skills
| Skill | Outcome | Notes |
|-------|---------|-------|
| web-design-guidelines | pass (no findings) | `src/components/providers/model-provider.tsx` is a context provider with no markup. The changed lines are a fetch URL and a list filter. No visual change: the selector shows one row fewer. |
| frontend-design | n/a | No new or reshaped UI. |
| Impeccable | n/a | No rendered surface changed. |

## Operator actions
None. Do not turn on `RAG_MODEL_ROUTING=auto` with the query layer before 06.2-29/35 land: Auto would then show, and it would still resolve to the default model.

## Deferred
- 06.2-29/35: replace `resolveStoredAutoModel` with `resolveRequestedModel` and the router. Add the three routing variables to `readRagEnvInput()` so `loadRagConfig(...).modelRouting` is live everywhere.
