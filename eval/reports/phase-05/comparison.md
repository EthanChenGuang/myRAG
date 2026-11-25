# Phase 05 comparison

Result: PASS

Noise band: max(3 x baseline spread, 0.02) on Recall@5, Recall@10 and MRR over the overall, every language and every category slice. Paired differences are against the committed baseline of the run's fixture mode.

## Notes

- Fixture corpus only: answers come from the deterministic fake citation generator and groundedness from the fake sidecar; the live Anthropic, Vectara and HHEM checks are operator actions.
- Every switch compared here defaults to off in src/lib/env.ts; the on runs set them for the app under test only.

## Runs

### off-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_ANSWER_FEEDBACK=false, RAG_CITATIONS=false, RAG_CLAUDE_CITATIONS=false, RAG_GROUNDEDNESS=false, RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK=false, RAG_GROUNDEDNESS_VECTARA_OPT_IN=false. Harness flags: none.

Recall@5 0.5116, Recall@10 0.5116, MRR 0.5174, correct refusal 0.6667, false refusal 0.3953, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| paired_all_zero | PASS | - |
| characterization | PASS | - |

### off-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_ANSWER_FEEDBACK=false, RAG_CITATIONS=false, RAG_CLAUDE_CITATIONS=false, RAG_GROUNDEDNESS=false, RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK=false, RAG_GROUNDEDNESS_VECTARA_OPT_IN=false. Harness flags: none.

Recall@5 0.7094, Recall@10 0.7094, MRR 0.6610, correct refusal 0.5000, false refusal 0.2222, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| paired_all_zero | PASS | - |
| characterization | PASS | - |

### on-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_ANSWER_FEEDBACK=false, RAG_CITATIONS=true, RAG_CLAUDE_CITATIONS=false, RAG_GROUNDEDNESS=true, RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK=false, RAG_GROUNDEDNESS_VECTARA_OPT_IN=false. Harness flags: --citations --groundedness.

Recall@5 0.5116, Recall@10 0.5116, MRR 0.5174, correct refusal 0.6667, false refusal 0.3953, invalid citation rate 0.0000, citation coverage 0.9740.

| Check | Result | Detail |
|---|---|---|
| retrieval_unchanged | PASS | - |
| no_slice_drop | PASS | - |
| citation_validity | PASS | - |
| strict_refusal | PASS | - |

### on-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_ANSWER_FEEDBACK=false, RAG_CITATIONS=true, RAG_CLAUDE_CITATIONS=false, RAG_GROUNDEDNESS=true, RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK=false, RAG_GROUNDEDNESS_VECTARA_OPT_IN=false. Harness flags: --citations --groundedness.

Recall@5 0.7094, Recall@10 0.7094, MRR 0.6610, correct refusal 0.5000, false refusal 0.2222, invalid citation rate 0.0000, citation coverage 0.9851.

| Check | Result | Detail |
|---|---|---|
| retrieval_unchanged | PASS | - |
| no_slice_drop | PASS | - |
| citation_validity | PASS | - |
| strict_refusal | PASS | - |
