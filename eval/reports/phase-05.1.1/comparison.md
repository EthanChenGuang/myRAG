# Phase 05.1.1 comparison

Result: PASS

Noise band: max(3 x baseline spread, 0.02) on Recall@5, Recall@10 and MRR over the overall, every language and every category slice. Paired differences are against the committed baseline of the run's fixture mode.

## Notes

- Fixture corpus only: the harness runs the eval profile, which never writes a retrieval log row (D-05), and no route, stream or UI control is exercised; the switched-on runs prove that the Phase 5.1.1 switches leave retrieval and stage latency unchanged. Live log writes, refusal and embed feedback, source-open signals and expert routes are covered by the vitest and node:test suites and by the operator's live verification.
- Every switch compared here defaults to off in src/lib/env.ts; the on runs set them for the app under test only.
- Phase 5.1.1 (D-28 step 10): off sets every Phase 5.1.1 switch to its default and must equal the fixture baselines the Phase 5.1 closing comparison (eval/reports/phase-05.1/comparison.json, all-off) was gated on, paired differences all zero; the characterization command holds the off-state chat, embed, voice, strict, webSearch, source_images and feedback-loop stream tests.
- on sets RAG_RETRIEVAL_LOG=masked_query and RAG_REFUSAL_FEEDBACK, RAG_EMBED_FEEDBACK, RAG_SOURCE_OPEN_SIGNAL and RAG_DOMAIN_EXPERT_REVIEW to true. RAG_EMBED_FEEDBACK_SECRET is not set: a schema-2 spec refuses any credential-like name, and the embed token is never minted on the harness path.
- latency_budget: every stage p95 with a chat budget in eval/config/latency-budgets.json and the retrieval total p95 stay within budget; on runs also stay within the latency noise band of their off run (p95 at most off p95 x 1.5 + 5 ms per stage).

## Runs

### off-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_DOMAIN_EXPERT_REVIEW=false, RAG_EMBED_FEEDBACK=false, RAG_REFUSAL_FEEDBACK=false, RAG_RETRIEVAL_LOG=off, RAG_RETRIEVAL_LOG_RETENTION_DAYS=30, RAG_SOURCE_OPEN_SIGNAL=false. Harness flags: none.

Injection (all_off, report_only): 18 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 6 |
| language:en | 1.0000 | 1.0000 | 6 |
| language:it | 1.0000 | 1.0000 | 6 |
| language:zh | 1.0000 | 1.0000 | 6 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 2 |
| overall | 1.0000 | 1.0000 | 18 |

Recall@5 0.5664, Recall@10 0.5664, MRR 0.5396, correct refusal 0.6800, false refusal 0.3357, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| paired_all_zero | PASS | - |
| characterization | PASS | - |
| latency_budget | PASS | - |

### off-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_DOMAIN_EXPERT_REVIEW=false, RAG_EMBED_FEEDBACK=false, RAG_REFUSAL_FEEDBACK=false, RAG_RETRIEVAL_LOG=off, RAG_RETRIEVAL_LOG_RETENTION_DAYS=30, RAG_SOURCE_OPEN_SIGNAL=false. Harness flags: none.

Injection (all_off, report_only): 18 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 6 |
| language:en | 1.0000 | 1.0000 | 6 |
| language:it | 1.0000 | 1.0000 | 6 |
| language:zh | 1.0000 | 1.0000 | 6 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 2 |
| overall | 1.0000 | 1.0000 | 18 |

Recall@5 0.7119, Recall@10 0.7232, MRR 0.6177, correct refusal 0.5333, false refusal 0.1921, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| paired_all_zero | PASS | - |
| characterization | PASS | - |
| latency_budget | PASS | - |

### on-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_DOMAIN_EXPERT_REVIEW=true, RAG_EMBED_FEEDBACK=true, RAG_REFUSAL_FEEDBACK=true, RAG_RETRIEVAL_LOG=masked_query, RAG_RETRIEVAL_LOG_RETENTION_DAYS=30, RAG_SOURCE_OPEN_SIGNAL=true. Harness flags: none.

Injection (all_off, report_only): 18 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 6 |
| language:en | 1.0000 | 1.0000 | 6 |
| language:it | 1.0000 | 1.0000 | 6 |
| language:zh | 1.0000 | 1.0000 | 6 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 2 |
| overall | 1.0000 | 1.0000 | 18 |

Recall@5 0.5664, Recall@10 0.5664, MRR 0.5396, correct refusal 0.6800, false refusal 0.3357, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| retrieval_unchanged | PASS | - |
| no_slice_drop | PASS | - |
| latency_budget | PASS | - |

### on-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_DOMAIN_EXPERT_REVIEW=true, RAG_EMBED_FEEDBACK=true, RAG_REFUSAL_FEEDBACK=true, RAG_RETRIEVAL_LOG=masked_query, RAG_RETRIEVAL_LOG_RETENTION_DAYS=30, RAG_SOURCE_OPEN_SIGNAL=true. Harness flags: none.

Injection (all_off, report_only): 18 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 6 |
| language:en | 1.0000 | 1.0000 | 6 |
| language:it | 1.0000 | 1.0000 | 6 |
| language:zh | 1.0000 | 1.0000 | 6 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 2 |
| overall | 1.0000 | 1.0000 | 18 |

Recall@5 0.7119, Recall@10 0.7232, MRR 0.6177, correct refusal 0.5333, false refusal 0.1921, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| retrieval_unchanged | PASS | - |
| no_slice_drop | PASS | - |
| latency_budget | PASS | - |
