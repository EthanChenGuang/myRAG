### Phase 03.1.1: Domain embedding model candidates and per-doc-type model selection (INSERTED)
**Goal**: Domain embedding models (Voyage `voyage-law-2`, `voyage-finance-2`) can serve the document types they fit, per deployment or per tenant, as an extra gated and rollback-able retrieval leg, and a model is bound to a doc type only when our own zh/en/it test set shows it beats both the current model and a same-model control on that type without any slice getting worse
**Depends on**: Phase 3.1 (and Phase 3 complete incl. 03-48 live items; 03.1-49; Phase 4 v2 search on trunk and 04-29)
**Requirements**: EMB-06, EMB-07, EMB-08, EMB-09, EMB-10
**Success Criteria** (what must be TRUE):
  1. One catalog holds the official facts of every embedding model (dimensions, input limits, input types, price); `voyage-law-2` and `voyage-finance-2` are embedding profiles served by the existing Voyage key, requests to them carry no dimension parameter, and a same-dimension model swap still fails at startup and per request.
  2. A doc type can be bound (deployment-wide or for one tenant, the tenant binding winning) to a profile scoped to that type; a scoped profile can never become the global profile or hold a vector outside its types; its re-embed fills only its doc types and tenant scope; activation is refused while any in-scope chunk lacks a vector or the evidence is missing, stale, names the wrong baseline, has fewer than 30 real items, or shows a language or other-slice regression; rollback and deactivation are pointer flips; two-tenant tests show no influence across tenants.
  3. With `RAG_DOMAIN_EMBEDDINGS` on, new documents of a bound type are also written to the binding profile (a failure records gaps, never fails the document), and v2 retrieval adds one dense leg per active binding, fused by RRF, with its scores kept out of the similarity floor and refusal calibration; a slow or failing leg degrades the search stage only; voice and the legacy pipeline are unchanged.
  4. `run-binding-compare.mts` reproduces, from recorded hashes, a per-doc-type comparison of baseline, control (filtered extra leg on the current model) and each candidate, per language and cross-lingual pair; its output is the evidence the gate reads; on the fixture embedder the comparison runs end to end and its evidence is refused by the gate for lack of real items.
  5. With the switch off, or on with no binding, the prechunked, ingest and v2 smoke runs equal the baseline item by item (paired differences all zero), no domain-model request is made, and a fresh install from the setup files equals a migrated database.
**Live verification**: Call `voyage-law-2` and `voyage-finance-2` with a real Voyage key and confirm the catalog facts; apply migrations 0440–0442 and build the three HNSW indexes on the real Supabase project; for contract/legal and financial reports, run the comparison on the real golden set (needs ≥ 30 production or human items per type from Phase 5.1.1) after approving the dry-run cost, and activate a binding only if the gate passes and the PO approves; a no-gain verdict or too few real items leaves the binding inactive and still completes the phase.
**Plans**: 16 plans (03.1.1-01..03.1.1-16) — see `phases/03.1.1-domain-embedding-model-candidates-and-per-doc-type-model-sel/03.1.1-PLAN-INDEX.md`

Plans:
**Wave 1**
- [ ] 03.1.1-01-PLAN.md — Model catalog, model-aware Voyage provider and registry lookup, per-model prices (wave 1)
- [ ] 03.1.1-02-PLAN.md — Binding evidence, comparison and eval-override contracts in Pydantic with generated Zod (wave 1)
- [ ] 03.1.1-03-PLAN.md — `RAG_DOMAIN_EMBEDDINGS`, `_MAX_LEGS`, `_TIMEOUT_MS` in every config location (wave 1)
- [ ] 03.1.1-04-PLAN.md — Migration 0440: profile scope, bindings table, guard, scoped profiles and HNSW indexes (wave 1)
- [ ] 03.1.1-11-PLAN.md — Synthetic zh/en/it legal and financial fixture pack with golden items (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*
- [ ] 03.1.1-05-PLAN.md — Migration 0441: binding lifecycle, activation gate, rollback and deactivate (wave 2)
- [ ] 03.1.1-16-PLAN.md — Every provider lookup uses the profile's model (split from 01) (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*
- [ ] 03.1.1-06-PLAN.md — Migration 0442: re-embed scoped to doc types and tied to a backfilling binding (wave 3)
- [ ] 03.1.1-07-PLAN.md — Cached tenant-aware binding read, binding operations and CLI (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*
- [ ] 03.1.1-08-PLAN.md — Ingest and rechunk write binding profiles for bound doc types (wave 4)
- [ ] 03.1.1-09-PLAN.md — Binding legs in v2 search with RRF, score separation, degrade and two-tenant proof (wave 4)
- [ ] 03.1.1-13-PLAN.md — Admin routes and Config UI bindings panel (UI-SPEC via /gsd-ui-phase first) (wave 4)

**Wave 5** *(blocked on Wave 4 completion)*
- [ ] 03.1.1-10-PLAN.md — Eval route overrides for bindings and the control leg (wave 5)

**Wave 6** *(blocked on Wave 5 completion)*
- [ ] 03.1.1-12-PLAN.md — Reproducible per-doc-type comparison harness, decision rule and domain baseline (wave 6)

**Wave 7** *(blocked on Wave 6 completion)*
- [ ] 03.1.1-14-PLAN.md — Off parity, fold migrations, fixture comparison record, AGENTS.md (wave 7)

**Wave 8** *(blocked on Wave 7 completion)*
- [ ] 03.1.1-15-PLAN.md — Live verification as human checkpoints (wave 8)
</content>
</invoke>
