---
quick_id: 261127-bhd
alias: quick-311
status: complete
branch: exec/quick-311-binding-hardening
base: origin/ci/merge-train-39 (c6f1b3f7)
source: origin/verify/03.1.1 (aae0e6ed) 03.1.1-VERIFICATION.md and 03.1.1-SECURITY.md
requirements: [EMB-10, EMB-09]
threats: [T-3.1.1-15b]
---

# Summary: Phase 3.1.1 verification gaps (code items)

This closes the seven listed items from the 03.1.1 verification and security reports. While making the gap 6 sweep, I found one more defect and fixed it (item 6b). No default changed, no production system was touched and no migration was added. The only SQL edits are header comments.

## Items and commits

| # | Report item | Change | Commits |
|---|---|---|---|
| 1 | EMB-10 gap 1 | `run-binding-compare.mts --base-url <app>`: a real-deployment mode, in the new `eval/harness/binding-compare-live.mts`. Details below. Plan 15 Task 3's command was corrected and marked "corrected by quick-311". | 967b0db5 |
| 2 | T-3.1.1-15b | The 0440 header now has a CREATE INDEX CONCURRENTLY procedure for large `chunk_embeddings` tables: build the indexes outside the transaction, then check `indisvalid`. Comments only, mirrored in the folded copies in both setup files. | 19467e55 |
| 3 | I-1 | v2 startup logs one `[RAG Config]` warning when `RAG_DOMAIN_EMBEDDINGS` is effective and `RAG_INGEST_PIPELINE` is legacy (also when unset). It includes the count of chunks missing binding vectors, taken from the existing admin completeness count (`getBindingCompleteness`, the same one the embedding-bindings admin route returns), bounded by 3 s. The count reads `unknown` on any failure. It is a warning only; readiness is unchanged. | f96df8ec (RED), 63b84e6d |
| 4 | I-2 | `record-binding-evidence` accepts only a `BindingComparison` with `population: real`. A hand-written `BindingActivationEvidence` is refused with exit 2 before any write. Details below. | 42afd221 (RED), 2fd32028 |
| 5 | I-3 | The headers of all three 0425 files (and their folded copies) and the AGENTS.md migration note now say: after re-running 0425, re-run 0440 and then 0442. | 19467e55 |
| 6 | gap 6 | `--leg-weight-domain <w>` (fixture only) and the sweep at 0.25, 0.5, 0.75 and 1.0. Report in `eval/reports/phase-03.1.1/domain-leg-weight-sweep.{md,json}`. | 813432f0, 78581669 |
| 6b | found during 6 | The eval route (`toRetrievalOverrides`), `evalRetrievalOverrides` and `applyEvalOverrides` each dropped `leg_weights.domain`, so any eval domain-weight override ran at 1.0. All three now carry it, for the eval profile only. | 7c9a4b56 (RED), 49b3323d, d76922d4 (test typing) |
| 7 | gap 2 | New file `03.1.1-15-LIVE.md`. Task 2 cites the 0440, 0441 and 0442 sections of `.planning/LIVE-MIGRATION-LOG-2026-11-25.md`. Task 1 is `not_done` (needs real Voyage calls by the owner). Task 3 is `not_done`, with contract_legal and financial_report "pending real items (Phase 5.1.1)". It contains no measured value. A key-shaped-string grep (`sk-`, `pa-`, `eyJ`, `Bearer`, 32+ hex, 40+ base64, `AKIA`, `xox`) found no match. | 199f86f8 |

Plan: 17ddc886. This SUMMARY is the last commit.

## Behaviour changes

- **Evidence (I-2).** `BindingComparison` gains `population: "fixture" | "real"`, default `fixture`, so older files still parse and are then refused. `rag_eval.binding_compare` sets `real` only when all three hold: `--live-deployment` was passed, the run was not on the fixture embedder, and the doc-type slice holds only production or human items (at least one). `recordBindingEvidence` re-checks this itself and always derives `real_n` from `provenance_counts`. The raw-evidence branch is gone. The SQL gate (0441) is unchanged and still requires 30 real items.
- **Live mode (EMB-10).** With `--base-url`, no fixture database, fixture env, fixture embedder, eval-only floor or random eval secret is ever set up: the branch returns before any of them. The steps:
  1. Read the real registry: exactly one active global profile; the candidates come from `--candidates`.
  2. Print each candidate's `npm run rag:reembed -- --profile <id> --dry-run` cost. Without `--confirm-cost`, stop with exit 4.
  3. For each candidate: `rag:embedding bind` (deployment-wide), `bind-status backfilling`, a scoped `rag:reembed --profile <id>` on the real project, then `bind-status available`.
  4. Run the baseline, control (`domain_control_leg`) and candidate (`embedding_bindings`) arms through `runEval({ baseUrl })`. `--org`/`--user` scope a multi-tenant server.
  5. **Refuse** any arm with a trace whose `effective_config.embedding_model` is not the active global model, or whose server runs anything other than `RAG_PIPELINE=v2`, `RAG_EMBEDDING_PROFILES=on` and `RAG_DOMAIN_EMBEDDINGS=on`. This is the runtime guard behind "the global profile is never a fake".
  6. Run `binding_compare_cli --live-deployment` (never `--fixture-embedder`).

  `RAG_EVAL_SECRET` (32+ characters) must come from the environment or `.env.local`; only its presence is checked. `corpus_sha256` is the hash of the origin plus the baseline effective-config hash, and a note in the comparison says so.
- **Startup (I-1).** There is one new warning line, only under v2 with domain bindings effective and the legacy ingest pipeline.
- **Eval overrides (6b).** Only the eval profile can now send a domain weight. Chat, embed and voice params are unchanged (tested).

## Sweep result and recommendation (gap 6)

Fixture embedder, fixture database and synthetic items only:

| Doc type | 0.25 | 0.5 | 0.75 | 1.0 |
|---|---|---|---|---|
| contract_legal, Δ recall@10 vs baseline (law-2 and 4-large the same) | +0.06 | −0.14 | −0.22 | −0.22 |
| contract_legal, Δ MRR vs baseline | −0.168 | −0.206 | −0.220 | −0.238 |
| contract_legal, other-slice regressions | 13 | 14 | 14 | 15 |
| financial_report, Δ on the doc-type slice | 0 | 0 | 0 | 0 |
| financial_report, other-slice regressions | 12 | 13 | 13 | 13 |

No weight and no candidate passes the gate, and no candidate beats the control. **Recommended `leg_weights.domain`: 0.25** as the starting point of the live sweep, also trying lower values such as 0.1, because the trend still improves at the lowest weight tested. The shipped default stays unset (1.0) until a real-population comparison supports a change. The first sweep was invalid because of 6b: every weight gave the same result. It was discarded and rerun after the fix; it was never committed.

## Tests that failed before the fix

- `tests/rag-db/embedding-binding-cli.test.mts`: the lifecycle test (a real-population comparison recorded) and "a hand-written BindingActivationEvidence is refused" failed (2 of 11).
- `eval/tests/test_binding_compare.py`: both population tests failed.
- `tests/rag/v2/domain-legacy-ingest-startup.test.ts`: 2 of 3 failed.
- `tests/rag/eval-route-binding-overrides.test.ts` ("carries leg_weights.domain") and `tests/rag/v2/leg-weights-domain.test.ts` (evalRetrievalOverrides, then the effective params) failed.
- `tests/rag-db/binding-compare-evidence.test.mts` was updated: a fixture comparison is now refused at record time (`eval_missing` on activation), and the forged case uses population `real` with 3 human items, which the gate refuses as `eval_insufficient_real_items`.

## Gates run

| Gate | Result |
|---|---|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | exit 0, 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `node scripts/check-config.mjs` | ok, 274 variables |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 2653 files |
| `node scripts/ci/check-language-literals.mjs`, `check-settings-classification.mjs`, `check-zod-isolation.mjs` | ok |
| `npm run gen:schemas` | the contract change regenerated `BindingComparison.schema.json`, `contracts.generated.ts` and `samples.json`, committed in 2fd32028; a rerun leaves no diff |
| `node --import tsx --test` on the binding tests in `tests/rag-db` (schema, gate, reembed-scope, binding-cli, ingest-binding-targets, binding-leg-two-tenant, binding-compare-evidence, schema-equality, search-path-empty, finetune-binding; each runs both deployment modes), `tests/rag-e2e/domain-embeddings-off-parity.test.mts` and `tests/binding-compare-live.test.mts` | 222 tests, 220 pass, 0 fail |
| `npx vitest run` (full: the contracts changed) | 16127 pass, 1 fail. The failure was the new leg-weights RED test, picked up mid-run before its fix; rerun alone it passes 6/6 |
| `uv run pytest -q` in `eval/` (full) | 2788 pass |
| `uv run --project rag-sidecar pytest -q rag-sidecar/tests -k "contract or schema"` | 1499 pass |
| Fixture harness end to end | 8 sweep runs, exit 0 |

Not run: the `npm run test-rag` smoke tiers. This task changes no retrieval default; it adds only eval-only override plumbing and checks with every switch off.

## Deviations

- Item 6b is extra: I fixed it because without it the sweep the task asked for measures nothing.
- I-1's count is in the startup warning only. The admin route already returns per-binding completeness counts, so I added no new route field.
- Live mode binds deployment-wide only; there is no `--tenant`. A tenant-scoped live comparison is deferred.
- The I-2 check is in TypeScript (`recordBindingEvidence`). The SQL gate does not read `population`, because a gate change would need a new 044x migration, which was out of scope. The trust boundary is still the service-role CLI.

## Operator actions

- Plan 15 Task 1: real Voyage calls for law-2 and finance-2, recorded in `03.1.1-15-LIVE.md`.
- Plan 15 Task 3: once Phase 5.1.1 supplies at least 30 real items per doc type, run the corrected `--base-url` command, starting the domain-weight sweep at 0.25.
- Re-run `/gsd-secure-phase 03.1.1` to close T-3.1.1-15 (LIVE.md now exists) and T-3.1.1-15b.

## For STATE

EMB-10's real-database mode exists (live run still pending). I-1, I-2, I-3 and T-3.1.1-15b are closed in code and docs. Decision: `leg_weights.domain` stays at its default; 0.25 is the recommended start for the live sweep.
