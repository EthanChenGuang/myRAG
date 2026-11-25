# Requirements additions proposed by Phase 6.1

## New section (insert after "### Embeddings (EMB)")

### Embedding fine-tuning (FT)

- [ ] **FT-01**: Fine-tuning is opt-in per tenant: an operator records `private` (models serving only that tenant) or `deployment` (shared models too) consent with an evidence reference (`rag_finetune_consent`); export, vector export, model registration and fine-tune bindings refuse any tenant whose consent does not cover the purpose; a tenant-private model is served only through Phase 3.1.1 bindings of that tenant, a shared model needs every trained tenant's `deployment` consent and an explicit tenant list; revoking consent taints every model version trained on that tenant in the same transaction, removes the evidence of its bound non-active slot so activation refuses, deactivates its bindings, and reports an active tainted model with rollback steps; master switch `RAG_FINETUNE=off` (off = today's behaviour)
- [ ] **FT-02**: The corpus export reads only the listed tenants' current, ready chunks with the service key, assigns a document-level split (sha256 of tenant and content hash or document id, 80/10/10; never pair-level), forces every document with gold evidence of a golden `test` item into the test split, and writes a bundle whose manifest and reports carry ids, hashes and counts only
- [ ] **FT-03**: An LLM writes about three queries per chunk (keyword, question, colloquial) in the chunk's language (zh/en/it), plus a configurable cross-language share, as Pydantic-validated tool output, cached by chunk content hash and prompt version, with a required budget and a dry-run cost projection
- [ ] **FT-04**: Queries are filtered in order: shape and language; verbatim copy (normalized character 5-gram containment ≥ 0.6 or longest common substring ≥ 0.7 of the query); near-duplicates (character 3-gram Jaccard ≥ 0.8); overlap with any golden question; an LLM answerability judge (round-trip filtering optional, off by default); every drop is reported by reason and language
- [ ] **FT-05**: Expert-confirmed failed-query pairs exported by Phase 5.1.1 (its `TrainingPair` contract, masked queries, chunk ids only) are imported for the bundle's tenants only with text resolved from the tenant's bundle; `held_out` pairs never train; the expert-rejected hard negatives are used first; pairs pass the rule filters and decontamination, are up-weighted, are clustered so near-identical queries share the strictest split, and are reported as a separate "real" slice
- [ ] **FT-06**: Hard negatives are mined per tenant with the production model (stored chunk vectors plus query vectors computed through `@/lib/rag`) or a sentence-transformers model (`mine_hard_negatives`), with a relative margin (default 0.05), rank range, neighbour-chunk and duplicate-content guards, negatives for train pairs from train documents only, and an LLM-audited false-negative rate whose 95% upper bound must not exceed 0.15
- [ ] **FT-07**: Training is reproducible on an operator GPU box or a hosted GPU container from a test-free kit, a pinned training image and lock: sentence-transformers `CachedMultipleNegativesRankingLoss` by default (GISTEmbed and Matryoshka optional), `NO_DUPLICATES` batching, pinned base model revision, seed and recorded library versions; CPU tests use fakes and a tiny in-test model
- [ ] **FT-08**: Offline evaluation on the held-out documents reports Recall@10, MRR@10 and nDCG@10 per language, language pair and source for the base, fine-tuned and production models with paired intervals; a model registers only if it beats production by the noise band, regresses no language slice beyond it, and beats the base; activation still goes only through the EMB-05 gate on the domain golden set (real items once they exist, EVAL-14) including the cross-lingual and general slices
- [ ] **FT-09**: A fine-tuned model is served from an OpenAI-compatible endpoint through one of two fixed 1024-dimension halfvec slot profiles with their own partial HNSW indexes; binding refuses an active, rollback-target or non-empty slot; a probe check proves the endpoint serves exactly the registered weights and prompts before any vector is written; the slot is filled by `npm run rag:reembed` and activated and rolled back by the existing pointer flip, or scoped and served through Phase 3.1.1 bindings, so one index never holds two models' vectors
- [ ] **FT-10**: A model registry (`embedding_model_versions`) records each version's base model and revision, tenant keys, dataset and config hashes, offline metrics, prompts, probe vectors, artifact location (no credentials) and status (`registered`, `bound`, `retired`, `tainted`); text-bearing bundle files are pruned after 30 days or when a tenant revokes consent; reports and logs never contain chunk or query text

## Traceability rows (append)

| Requirement | Phase | Status |
|-------------|-------|--------|
| FT-01 | Phase 6.1 | Pending |
| FT-02 | Phase 6.1 | Pending |
| FT-03 | Phase 6.1 | Pending |
| FT-04 | Phase 6.1 | Pending |
| FT-05 | Phase 6.1 | Pending |
| FT-06 | Phase 6.1 | Pending |
| FT-07 | Phase 6.1 | Pending |
| FT-08 | Phase 6.1 | Pending |
| FT-09 | Phase 6.1 | Pending |
| FT-10 | Phase 6.1 | Pending |

## Existing requirements: amendments proposed

- **Out of Scope, "Self-hosted GPU for Qwen3-Embedding-8B"**: keep, and add a clarifying note: "A fine-tuned model (FT-09) is served from an OpenAI-compatible endpoint the operator runs or rents; this does not reintroduce self-hosting of Qwen3-Embedding-8B." Reason: FT-09 needs some endpoint, and a reader could read the row as forbidding it.
- **Out of Scope, "Per-tenant provider choice"**: amend to "Per-tenant choice of embedding *provider or global profile*". Reason: Phase 3.1.1 already adds per-tenant, per-doc-type bindings, and FT-01/FT-09 serve tenant-private fine-tuned models through them; the global active profile stays deployment-wide.
- **EMB-05**: no change in wording; note in traceability that Phase 6.1 reuses it unchanged (it adds triggers, not new gate logic).

## Cross-phase interface requests

- **Phase 5.1.1**: 06.1 consumes 5.1.1's `TrainingPair` (5.1.1 CONTEXT D-17) unchanged; 06.1's own pair model is named `FinetunePair` so the generated Zod file has one `TrainingPairSchema`. 5.1.1-14's hand-off rule (stop and report on a contract difference) and 06.1-09's mirror rule agree.
- **Phase 3.1.1**: 06.1-14 registers the slot providers through 3.1.1's model catalog and `getEmbeddingProviderFor`; 06.1-20 scopes slots (`doc_types`) and adds a guard trigger on `embedding_profile_bindings` for `ft-*` profiles. 3.1.1's scoped-profile trigger (no global activation of a scoped profile) is relied on.
- **Phase 7** (`0705/0706_activation_gate_external`) may redefine `rag_activate_embedding_profile`; 06.1 relies only on the existing `eval_missing` refusal, which its triggers trigger by nulling `eval_evidence`, so the two do not conflict as long as Phase 7 keeps that refusal.

## Migration numbers claimed

0651_finetune_registry.sql, 0652_finetune_slots.sql, 0653_finetune_export.sql, 0654_finetune_binding_guard.sql (common files, both modes). Other new phases: 3.1.1 uses 0440–0442, 4.1.1 uses 0471–0473, 5.1.1 uses 0531–0535; no clash.
