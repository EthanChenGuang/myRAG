### Phase 06.1: Embedding fine-tuning pipeline: synthetic queries, hard negatives, MNRL training, re-embed and switch (INSERTED)

**Goal**: An operator can fine-tune an open multilingual embedding model on the knowledge base of tenants that consented, prove it beats the base and the production model on held-out documents and on the domain golden set, and switch production to it (or back) through the existing embedding-profile gate or a Phase 3.1.1 binding, without ever mixing vectors of two models or letting a model trained on one tenant's data serve another tenant without that consent
**Depends on**: Phase 6, Phase 3.1.1 (model candidates and per-doc-type selection), Phase 5.1.1 (real test set and mined pairs); reuses Phase 3 profiles, re-embed and the EMB-05 gate
**Requirements**: FT-01, FT-02, FT-03, FT-04, FT-05, FT-06, FT-07, FT-08, FT-09, FT-10
**Success Criteria** (what must be TRUE):
  1. With `RAG_FINETUNE=off` (default) nothing changes: the slot profiles exist unbound and unsearched, the fine-tune commands refuse, and the fixture eval equals the Phase 6 baseline on every metric and slice.
  2. `python -m rag_eval.finetune export` refuses any tenant without recorded `deployment` consent, reads only the listed tenants' current ready chunks, assigns a document-level 80/10/10 split (golden test-evidence documents forced to test), and a two-tenant test shows no row of tenant B in a bundle for tenant A.
  3. On the fixture corpus with a fake LLM, generation writes about three queries per chunk in zh/en/it (plus a cross-language share) within a required budget and resumes from its cache; the filters drop verbatim copies (character n-gram containment), near-duplicates, golden overlaps and unanswerable queries, and report every drop by reason and language; expert-confirmed mined pairs from Phase 5.1.1 are imported, filtered and clustered so near-identical queries never straddle train and test.
  4. Hard negatives are mined per tenant with the production model's stored vectors (or a sentence-transformers model) using a relative margin of 0.05 and the neighbour/duplicate guards; train pairs never take a negative from a dev or test document; the sampled false-negative upper bound must be ≤ 0.15 or mining fails; the NumPy miner matches `mine_hard_negatives` on a tiny model.
  5. A test-free training kit trains with `CachedMultipleNegativesRankingLoss` and `NO_DUPLICATES` batching from pinned configs on a GPU host (CPU tests use fakes and a tiny in-test model); offline evaluation reports Recall@10, MRR@10 and nDCG@10 per language and source for base, fine-tuned and production models with paired intervals, and a card that fails the offline rule cannot be registered.
  6. A registered model binds to a free fine-tune slot (`ft-a-1024`/`ft-b-1024`, halfvec + partial HNSW), is served from an OpenAI-compatible endpoint whose identity is proven by a probe check, is re-embedded with `npm run rag:reembed`, and is activated and rolled back only through the unchanged EMB-05 gate; binding a non-empty, active or rollback-target slot is refused, and a changed endpoint model fails loudly before any vector is written (PGlite lifecycle test in both modes, with a two-tenant canary).
  7. A tenant-private model (one tenant's data, `private` consent) is served only through Phase 3.1.1 bindings for that tenant: a binding for another tenant, a deployment-wide binding or a global activation of the scoped slot is refused (two-tenant PGlite test).
  8. Revoking a tenant's consent taints every model version trained on it in the same transaction, nulls the evidence of its bound non-active slot (activation then refuses), deactivates its bindings and reports an active tainted model with the rollback steps; `prune` removes text-bearing bundle files after 30 days or for a revoked tenant; no report or log contains chunk or query text.
**Live verification**: Record real consent; run generation and judging with a real key under an approved budget; mine with the production model and pass the FN audit; train on a GPU box or hosted GPU from the training image; deploy an OpenAI-compatible endpoint and pass `ft-check`; re-embed the real corpus (HNSW build time); run the EMB-05 comparison on the real golden set (production/human items) including cross-lingual and general slices; activate or record the gate's refusal; rollback drill; measure slot embed p50/p95 against the 200 ms budget; record all costs.
**Plans**: 20 plans in 10 waves — see `phases/06.1-embedding-fine-tuning-pipeline-synthetic-queries-hard-negati/06.1-PLAN-INDEX.md`

Plans:
- [ ] 06.1-01-PLAN.md — W1: Pydantic fine-tune contracts, `eval/config/finetune.json`, optional extras (package-approval checkpoint, autonomous: false)
- [ ] 06.1-02-PLAN.md — W2: generated JSON Schema and Zod for the fine-tune contracts
- [ ] 06.1-03-PLAN.md — W1: consent and model registry (0651) with revocation taint, two-tenant tests
- [ ] 06.1-04-PLAN.md — W1: `RAG_FINETUNE` and slot endpoint settings in the five config locations and the eval pin
- [ ] 06.1-05-PLAN.md — W2: fine-tune slots `ft-a-1024`/`ft-b-1024` with HNSW, bind/clear/release, taint and evidence triggers (0652)
- [ ] 06.1-06-PLAN.md — W2: consent-checked tenant export, document-level split, golden decontamination
- [ ] 06.1-07-PLAN.md — W3: synthetic query generation (structured, cached, budgeted)
- [ ] 06.1-08-PLAN.md — W4: filters (verbatim n-gram, near-duplicate, golden, answerability) and report
- [ ] 06.1-09-PLAN.md — W5: Phase 5.1.1 `TrainingPair` import, clustering and strictest split
- [ ] 06.1-10-PLAN.md — W3: production chunk and query vectors through `@/lib/rag` (0653), `npm run rag:finetune`
- [ ] 06.1-11-PLAN.md — W6: hard-negative mining (vectors / sentence-transformers), guards, FN audit
- [ ] 06.1-12-PLAN.md — W7: training kit, trainer (CachedMNRL), probes, training image and lock
- [ ] 06.1-13-PLAN.md — W7: offline evaluation vs base and production, model card, prune
- [ ] 06.1-14-PLAN.md — W3: OpenAI-compatible slot provider and probe check
- [ ] 06.1-15-PLAN.md — W4: `rag:embedding ft-*` operator commands
- [ ] 06.1-16-PLAN.md — W8: fixture pipeline end to end with leakage invariants
- [ ] 06.1-17-PLAN.md — W5: PGlite lifecycle (bind → re-embed → gate → activate → rollback), two-tenant canary, switch-off parity
- [ ] 06.1-20-PLAN.md — W6: scoped slots and the fine-tune binding guard on Phase 3.1.1 bindings (0654)
- [ ] 06.1-18-PLAN.md — W9: fold migrations, baseline parity report, AGENTS.md, gates
- [ ] 06.1-19-PLAN.md — W10: live verification checkpoints (autonomous: false)
**UI hint**: fields only (Config UI Embedding profiles card); no new screen
