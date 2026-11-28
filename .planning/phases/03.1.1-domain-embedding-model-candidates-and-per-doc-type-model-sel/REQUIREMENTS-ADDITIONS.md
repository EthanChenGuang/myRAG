# Requirements additions proposed by Phase 3.1.1

New lines for the v1 "Embeddings" block of `.planning/REQUIREMENTS.md` (after EMB-05), and traceability rows.

## New requirements

- [ ] **EMB-06**: One model catalog holds, for every embedding model the app may use, provider, model id, supported dimensions, whether a dimension parameter may be sent, maximum input tokens, tokens per request, input types and list price, taken from the vendor's official documentation with the date read; Voyage `voyage-law-2` and `voyage-finance-2` (1024 dimensions, 16K and 32K input tokens) are available as embedding profiles served by the existing Voyage key, and every model check (startup, ingest, query) compares against the profile's own model
- [ ] **EMB-07**: A document type can be bound, deployment-wide or for one tenant (the tenant binding wins), to a profile scoped to that type; a scoped profile never becomes the global active profile, holds vectors only for its doc types, is filled by a re-embed run limited to its doc types and tenant scope, and while its binding is staged or active ingestion also writes it for new and replaced documents of that type and tenant (a failure records gaps and does not fail the document); the chunk stays in the global profile (additive), so removing a binding needs no re-embed
- [ ] **EMB-08**: In the v2 pipeline each active, non-stale binding in the request's tenant adds one dense leg, embedded with its profile in parallel with the global query embedding and fused with RRF under its own weight; the leg is restricted to its doc type and to the request's filters and tenant, its scores are never compared with the global profile's (similarity floor and refusal calibration ignore them), it has a timeout and a cap on legs per query, and a failing leg degrades the search stage instead of failing the request; voice and the legacy pipeline are unchanged; behind `RAG_DOMAIN_EMBEDDINGS` (default off)
- [ ] **EMB-09**: A binding is activated only through a gate that refuses unless every current chunk of its doc type in scope has a vector of the profile with its model and dimensions, a completed scoped re-embed run exists, and evidence recorded after the newest vector names the current global profile and the current binding as baselines, passed the comparison, holds at least 30 real (production or human) items of that doc type with no language sub-slice regressing, and shows no other slice regressing; rollback restores the previous binding when still complete, deactivation returns to global-only at any time, a binding whose evidence names an older global profile is skipped at query time until re-proven, and all of it is operable from the CLI and the admin Config UI by admins only
- [ ] **EMB-10**: A reproducible comparison per doc type runs, on one fixture or real database and one golden file, a baseline arm (global profile), a control arm (global profile plus a doc-type-filtered extra leg, no new vectors) and one arm per candidate profile, and reports Recall@k, MRR and refusal rates per doc type, language and cross-lingual pair with corpus, golden, noise, parameter and catalog hashes and the re-embed run ids; a candidate is recommended only if it beats both baseline and control on its doc type beyond the noise band without any regression elsewhere; the output is a validated contract that the gate consumes; public leaderboards are never used as evidence

## Traceability rows

| Requirement | Phase | Status |
|-------------|-------|--------|
| EMB-06 | Phase 3.1.1 | Pending |
| EMB-07 | Phase 3.1.1 | Pending |
| EMB-08 | Phase 3.1.1 | Pending |
| EMB-09 | Phase 3.1.1 | Pending |
| EMB-10 | Phase 3.1.1 | Pending |

## Existing requirements touched (no move proposed)

- **EMB-04** (re-embed job): unchanged in meaning; plan 03.1.1-06 replaces the 0315 selection functions to add the doc-type scope and proves unscoped behaviour is identical. No amendment needed.
- **EMB-05** (activation gate): unchanged; the global gate function is not edited. Bindings have their own gate (EMB-09).
- **CHK-04** (child size must fit the active embedding profile's maximum input): proposed amendment for Phase 4 to read the maximum input from the EMB-06 catalog and, for a doc type with an active binding, to use the smaller of the global and the binding profile's maximum (`voyage-law-2` accepts 16K tokens). Reason: otherwise a child size valid for the global model could exceed the bound model's input limit.
- **RET-05** (Phase 7 external backends): note for Phase 7 that the outbox must also sync binding profiles' vectors with the same doc-type scope; no text change proposed now.

## Deferred (v2 list)

- **EMB-V2-01**: Cohere `embed-v4.0` and Google `gemini-embedding-2` provider adapters as further candidates through the EMB-06 catalog and EMB-10 comparison.
- **EMB-V2-02**: "Replace" bindings (the global leg excludes the bound doc type) and query-time routing of binding legs.
</content>
</invoke>
