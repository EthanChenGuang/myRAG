---
quick_id: 261128-qdb
slug: deferred-batch
branch: exec/quick-deferred-batch
base: origin/exec/quick-63-gaps (f5df689a) + merge of origin/exec/quick-44-t09 (51ac6b52)
date: 2026-11-28
source: deferred items collected from plan SUMMARYs and verification reports (orchestrator batch)
status: complete
key-files:
  modified:
    - src/lib/rag/feedback-loop/review-access.ts
    - rag-sidecar/src/rag_sidecar/contracts/feedback_loop.py
    - src/lib/rag-eval/contracts.generated.ts
    - rag-sidecar/schemas/ReviewItem.schema.json
    - rag-sidecar/schemas/ReviewItemListResponse.schema.json
    - tests/rag-db/lexical-stats-static.test.mts
    - tests/rag-db/lexical-cluster-df.test.mts
    - tests/rag-db/vector-sync-access-groups-drift.test.mts
    - scripts/config-ui/rag-panels/purge.js
    - scripts/config-ui/rag-panels/monitor.js
    - AGENTS.md
    - README_RAG_PIPELINE.md
---

# Quick 261128-qdb: deferred batch (review reasons, lexical scan, 0742 drift, docs, Config UI labels, 6.1 slot comparison)

Seven deferred items, nothing else. No SQL file changed, no migration number taken, no package added, no switch added, no default changed. 6.3 G8 hardening (W2–W8) was not touched.

## Branch

`git checkout -B exec/quick-deferred-batch origin/exec/quick-63-gaps` (HEAD f5df689a), then `git merge --no-ff origin/exec/quick-44-t09` (51ac6b52), merge commit f43f35a5. Six files conflicted; resolution:

- `eval/config/monitor-alerts.json`, `rag-sidecar/.../contracts/monitor.py`, `src/lib/rag/monitor/rule-registry.ts`: kept both new rules, Phase 6.3 `stale_index_drop_rate` and Phase 7 `language_drop` (15 rules; the defaults factory already held both). `config_hash` regenerated from `default_monitor_alerts()` through `write_config_atomically` (only the hash changed). `eval/tests/test_config_files.py` takes both sides' assertions with the count 15.
- `AGENTS.md` 4.4: kept the 6.3 re-run wording (0932 → 0936 → 0938) and the 4.4 LEX-05 external-backends line.
- `tests/rag/agents-guide.test.ts`: kept both describe blocks.

## Commits

| Item | RED (fails on old code) | Fix |
|---|---|---|
| 1 Review read side: `calc_mismatch`, `calc_unverified` | 4b247176 | 5ff66075 |
| 2 Lexical static scan covers 0938, 0746, 1014; cluster-df policy check | 5e235b89 | 1f3cc369 |
| 3 AGENTS.md 4.4: re-run 1014 after 0902 or 0905 | 49ebc6ae | 114db7a3 |
| 4 IW-2 (Phase 7) 0742 drift detection | — (new detector test) | f840bf1f |
| 5 IW-3 (Phase 7) language-quality is API only | 49ebc6ae | 114db7a3 |
| 6 Config UI labels (purge stores, monitor rules) | 443e8957 | a7a5e502 |
| 7 6.1 IW-2 slot comparison route (documented) | 90238f55 | 9fc42caf |

## What changed

1. **Review reasons.** `ReviewItem.reasons` (Pydantic, `feedback_loop.py`) now admits a new `CalcReviewReason = Literal["calc_mismatch", "calc_unverified"]` next to the mining and check reasons; `npm run gen:schemas` regenerated the Zod schema and the two JSON schemas. `REVIEW_REASONS` in `review-access.ts` (the `?reason=` list filter) lists both. Before, an item mined by 0984 with a calc reason failed `ReviewItemSchema` and could not be filtered by it.
2. **Lexical scan.** `lexical-stats-static.test.mts` reads 0938, 0746 and 1014 next to 0900–0919. The 0746 purge bodies guard with `rag_ingest_assert_tenant_key` (0425), which the scan now accepts as the tenant guard beside `rag_assert_tenant_key`; every other check (empty search_path, qualified built-ins, client-role grants, no `hybrid_search_chunks` redefinition) passes unchanged on the three files. In `lexical-cluster-df.test.mts` the "no policy" check went through `count()`, which prefixes `public.`, so it queried `public.pg_policies` — a relation that does not exist — and the `.catch(async () => 0)` turned the error into a pass. It now reads `pg_catalog.pg_policies` through `policyCount()` with no catch, and first asserts that the same query sees the policies on `public.documents`, so a broken query fails instead of reading zero.
3. **AGENTS.md 4.4.** "after re-running 0902 or 0905, re-run 1014 (it redefines `rag_lexstats_compact_tenant` and `rag_lexstats_compact_all` with the tenant guard, T-04.4-09)".
4. **0742 drift.** New `tests/rag-db/vector-sync-access-groups-drift.test.mts` with `vectorSyncAccessGroupsDrift(db)`: from pg_catalog it names every object that lost the 0742 effect (an UPDATE trigger function whose body no longer compares `o.access_groups`, a read function that no longer returns `access_groups`, or a missing `rag_validate_chunks_for_groups`). Per mode: a full apply reads `[]`; re-running 0702 reports both trigger functions; re-running 0705 reports both read functions; each time re-running 0742 clears it; a database from the setup file alone (0701–0707 folded by 07-31, 0742 not) reports drift. Chose a test over a readiness check: a readiness check means redefining `rag_access_readiness` in a new migration in a crowded number range for a drift only an operator re-run can cause; the test runs in CI against the real files.
5. **Language-quality route.** AGENTS.md (Phase 7 per-language bullet) and README_RAG_PIPELINE.md ("Cells") say `/api/rag/admin/language-quality` is offered as an API only; no Config UI panel or app page calls it.
6. **Config UI labels.** Purge receipts: `store.lexical_stats` and `store.golden_items` in en/zh/it (were shown as raw keys). Monitor: `rule.stale_index_drop_rate` and `rule.source_reconcile_{paused,overdue,failed,incomplete}` in en/zh/it, mapped in `MONITOR_RULE_KEYS`. `purgeStoreLabel` and `monitorRuleLabel` are now also exported for tests (`tests/ui/config-deferred-labels.test.ts`).
7. **6.1 slot comparison.** Not ported. A slot arm in `run-profile-compare.mts` serves only after a consent grant, a registered model card, a binding, a fake slot endpoint and a passing probe; the lifecycle harness (`tests/helpers/finetune-lifecycle.mts`, about 400 lines: `startHarness`, `grantRegisterBind`, `runProfileComparison`) already builds exactly that and `tests/rag-db/finetune-release-lifecycle.test.mts` runs the comparison. Porting it would duplicate the harness and its fake endpoints inside the eval script. AGENTS.md 6.1 now says `run-profile-compare.mts` has no slot arm and names the lifecycle harness route. `RAG_FINETUNE` in `seedHarnessEnv` was left off for the same reason (turning it on without a bound slot changes nothing but the refusals).

Behaviour with every switch off: unchanged. The only runtime differences are the two accepted review reasons, the five monitor rule labels and two purge store labels.

## Design skills

| Skill | Outcome |
|---|---|
| frontend-design | n/a: copy-only change to existing label tables; no new interface or layout |
| Impeccable | n/a: no visual change beyond label text |
| web-design-guidelines | pass: reviewed the touched lines of `scripts/config-ui/rag-panels/purge.js` and `monitor.js` against `references/command.md` (curly apostrophe in the Italian copy, no straight quotes, no `...`, labels rendered through the existing label paths); no findings |

## Gates run

- Install: `npm ci --ignore-scripts --onnxruntime-node-install-cuda=skip`, `uv sync --locked --extra chunking --extra preflight` (rag-sidecar), `uv sync --locked --all-extras` (eval), `python3 scripts/ci/fill-tiktoken-cache.py`.
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`, `node scripts/ci/check-zod-isolation.mjs`: all exit 0.
- `npm run gen:schemas`: no diff after the contract commit.
- Full `npx vitest run` (the generated contracts changed): 971 files passed, 4 skipped; 18066 tests passed, 177 skipped.
- rag-db, foreground, each file runs both modes: `lexical-stats-static` (8/8), `lexical-cluster-df` (34/34), `vector-sync-access-groups-drift` (8/8), `review-items-access-sets` + `review-chunks-live-access` (with the first and last: 48/48). No SQL changed, so the grants, search-path and schema-equality files were not run.
- rag-sidecar pytest: `tests/test_feedback_loop_contracts.py` 95 passed; `-k monitor` 31 passed, 1 skipped (after the merge).
- eval pytest, full suite: 2943 passed. `eval/fixtures/parse/` unchanged.
- `node scripts/ci/check-frontend-design-summary.mjs .planning/quick/261128-qdb-deferred-batch`: PASS.
- Not run: `test-rag` (no retrieval, ingest, generation or golden-set change), `check-workflows.py` (no workflow change).

Failing before this batch: `lexical-cluster-df` test 15 ("0746 applies twice ...") failed in both modes on the base branch; 0747 (06.3 G6) redefines both purge bodies, and the test re-applied only 0746. It now re-runs 0747 afterwards, which is the documented re-run rule.

## Deferred

- `_GoldenExportLine` (eval `review_queue.py`) and `GoldenExportLineSchema` (`src/lib/rag/feedback-loop/exports.ts`) still list only the mining reasons: a golden-labelled item carrying a check or calc reason would fail export validation. Same drift as item 1 on the export side; not in this batch.
- The monitor panel shows `language_drop` (Phase 7) as a raw rule id; it has no `rule.*` label.
- A production readiness check for the 0742 effect (for example in `rag_access_readiness`) would need a new migration; the drift test covers CI only.

## Operator actions

None.
