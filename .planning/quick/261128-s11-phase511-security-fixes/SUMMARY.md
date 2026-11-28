---
quick_id: 261128-s11
slug: phase511-security-fixes
branch: exec/quick-511-sec
base: origin/main (e6afe8a2)
source: 05.1.1-SECURITY.md (origin/verify/05.1.1-sec, f1aab3f1)
status: complete
---

# Quick: Phase 5.1.1 security audit fixes (T-07-77, mining reasons, private temp files, labelling static gate)

Scope: exactly the four items assigned from `05.1.1-SECURITY.md` (T-07-77 and follow-ups 1, 2, 3 under "Recommended fix").
The owner items O-1 to O-8 were not touched, and neither was `07-SECURITY.md`. The audit's own `status: draft` and the
owner sign-offs stay with the owner.

## Commits (RED first, then fix)
| # | Commit | What |
| --- | --- | --- |
| 1 | 33cde14e | RED: `tests/api/feedback-loop-export-route.test.ts` asserts that `[Feedback Loop] export` (all three kinds) and `[Review] chunks` (golden) carry `admin: <verified admin id>`, with keys `admin, count, export, tenant` only and no tenant key or chunk text. It failed on the missing `admin` field. |
| 2 | ad6250fd | RED: `tests/rag/feedback-loop/mining.test.ts`: rows with reason `claim_unsupported`, `calc_mismatch` or `calc_unverified` must be counted. It failed with `MiningError('unexpected_result')`. The existing per-reason `toEqual` now lists the three new zero counts. |
| 3 | 0b96c10a | Fix T-07-77: `src/app/api/rag/admin/feedback-loop/export/route.ts` uses `checkAdmin` / `adminDenied` and passes `guard.userId` to `buildExport(admin, kind, tenantKey, adminId)`. `buildExport` refuses an `adminId` that is not a UUID. `exportDictionary`, `exportTraining` and `exportGolden` take `adminId`. Both log lines carry `admin` (the id only). `tests/rag/feedback-loop/exports.test.ts` passes the fixture admin id. |
| 4 | 02a19e98 | Fix mining reasons drift: `MiningReasonCounts` (Pydantic, `rag-sidecar/src/rag_sidecar/contracts/feedback_loop.py`) and the `MiningReason` literal gain the three reasons. `npm run gen:schemas` regenerated `MiningRunResult.schema.json`, `contracts.generated.ts` and `samples.json`. `MINING_REASONS` in `mining.ts` matches. `tests/rag-db/mining-end-to-end.test.mts` adds a case that mines the three reasons through the real 0984 SQL. With the old `mining.ts` it failed with `unexpected_result`; with the fix it passes. The case needed three more fixture words, because the question list had run out. |
| 5 | ba5c0c07 | RED: `eval/tests/test_private_tmp_writes.py` (12 cases, run against `write_golden`, `review_queue._write_text` and `feedback_exports._write_atomic`): the written file is 0600 under umask 022; a symlinked `.tmp` sibling is refused and the file it points to is untouched; a symlinked target is refused; a stale regular `.tmp` is replaced. All 12 failed on assertions. |
| 6 | 9d6d9c30 | Fix: `golden_io.write_private_atomic(path, data)` refuses a symlinked target or `.tmp` and unlinks a stale regular `.tmp`. It then creates the `.tmp` with `O_CREAT, O_EXCL, O_NOFOLLOW, O_CLOEXEC` at mode 0600, followed by `fchmod 0600`, checks the target again, and calls `os.replace`. It raises `UnsafeWriteTarget` (a `ValueError`). All three writers use it, and the `pull` and `export` CLIs print the refusal and exit with `EXIT_PRIVATE`. |
| 7 | 7157375e | RED: `tests/ui/review-labelling-panel.test.ts` moves the sink check into `expectNoHtmlSinks` and adds probes (`outerHTML`, `insertAdjacentHTML`, `innerHTML` appended to the panel source) that the gate must reject. The panel has no `outerHTML` today, so the gate's RED is shown by the `outerHTML` probe, which the old gate let through. |
| 8 | 4fd0b4b6 | Fix: the labelling gate uses the same `/innerHTML\|insertAdjacentHTML\|outerHTML/` check as the admin panel gate. |

## Behaviour changes
- With the switches off, nothing changes: the export route answers 404 before reading anything while `RAG_DOMAIN_EXPERT_REVIEW` is off, as before (its guard runs first and still answers 401/403/503 exactly as before). Mining is still disabled unless the expert review switch is on and the retrieval log is in `masked_query` mode. The eval writers are operator CLIs.
- When an export runs, the two log lines add `admin` (the verified admin id; no text).
- A `MiningRunResult` now has three more `by_reason` counts. A run whose answer records carry claim or calc reasons completes. Before, it wrote the items and then failed with 503 or exit 1.
- Golden, queue and export files written by these tools are created with mode 0600, and a symlinked target or `.tmp` is refused. `write_golden` is shared, so every golden file it writes (draft writer, harness runner, live rerank probe) is now 0600 too.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `node scripts/ci/check-rag-boundary.mjs`, `scripts/check-config.mjs`, `scripts/ci/check-language-literals.mjs`, `scripts/ci/check-settings-classification.mjs`, `scripts/ci/check-zod-isolation.mjs`: all exit 0.
- `npm run gen:schemas`: no diff after commit 4.
- vitest: 168 files, made up of every test file importing `feedback-loop/exports`, `feedback-loop/mining`, the export route or `rag-eval/contracts.generated`, plus the changed tests. Result: 2894 passed, 1 skipped.
- eval pytest: full suite, 2873 passed. `write_golden` is shared code. `eval/fixtures/parse/` was unchanged afterwards.
- rag-sidecar pytest: `tests/test_feedback_loop_contracts.py` and `tests/test_calc_contracts.py`, 117 passed.
- rag-db, foreground: `mining-end-to-end`, `review-items-mining`, `purge-grants`, `search-path-empty`, `definer-search-path-pglite` (68/68), then `schema-equality` and `hybrid-grants` (55/55). The grants, search-path and schema-equality files iterate both deployment modes. `mining-end-to-end` is multi-tenant by design (two org tenants). No SQL was changed.
- `ruff` on the touched eval modules: no new findings (the same 4 pre-existing ones in `review_queue.py`).
- Install: `npm ci --ignore-scripts --onnxruntime-node-install-cuda=skip`, `uv sync --locked` (eval all extras; sidecar chunking and preflight). No package was added or re-locked.

## Deviations
- Item 4 had no failing state on today's panel source (it has no `outerHTML`). The RED is a mutation probe that the old gate let through.
- `buildExport` also checks that `adminId` is a UUID. This is a small hardening beyond the audit text.

## Deferred / follow-ups
- `07-SECURITY.md` re-disposition (audit follow-up 6: T-07-93 and T-07-119 to "N/A, surface absent"; T-07-76, T-07-95 and T-07-117 restated under the expert model). This belongs to train 43 and was not done here.
- Audit follow-ups 4 and 5 and the owner items O-1 to O-8 were not in scope.
- Medium: `REVIEW_REASONS` in `src/lib/rag/feedback-loop/review-access.ts` and the `ReviewItem.reasons` contract (`ReviewItemReason` and `CheckReviewReason`) still lack `calc_mismatch` and `calc_unverified`, although 0984 writes them to `rag_review_items.reasons`. Whether the review routes then drop or refuse such items was not checked here. This is the same kind of drift as item 2, on the review-read side.
- Low: the `MiningReason` literal in the sidecar is no longer referenced by any model; it is kept in step with `MiningReasonCounts`.

## Operator actions
None.
