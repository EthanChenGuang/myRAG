### Phase 04.1.1: Domain terminology dictionary: expert-maintained synonyms, query expansion, index-time synonyms, log mining (INSERTED)

**Goal**: When users ask in their own words (colloquial terms, abbreviations, product or part aliases) in Chinese, English or Italian, retrieval still finds the chunks that use the domain's terms, through a dictionary that domain experts maintain per deployment and per tenant, that is versioned and audited, that never lets expansion outweigh the original query, and that grows from reviewed candidates mined from missed queries
**Depends on**: Phase 4.1
**Requirements**: TERM-01, TERM-02, TERM-03, TERM-04, TERM-05, TERM-06, TERM-07, TERM-08, TERM-09, TERM-10, TERM-11
**Success Criteria** (what must be TRUE):
  1. On a local Postgres with pgvector seeded with the fixture corpus and a synthetic dictionary, a colloquial zh/en/it question whose wording does not occur in the corpus retrieves the gold chunk under v2 with `RAG_TERMINOLOGY` on, through a separate down-weighted lexical RRF list; the original dense and lexical lists are unchanged, expansion is one hop and capped, and with the switch off candidates and `retrievalConfigHash` are identical to a database without a dictionary.
  2. Dictionary entries live in a shared layer and per-tenant workspace layers in service-role-only tables; a tenant's effective dictionary, previews, mined candidates and corpus document frequencies never include another tenant's data (two-tenant tests in both deployment modes); anon and authenticated cannot read the tables or execute any `rag_term_*` function.
  3. Every change bumps its layer version with an append-only audit row and fails on a stale expected version; the version a request used appears in its trace and config hash.
  4. Admins create, edit, delete, suppress, import (dry run, then atomic apply) and export (formula-safe CSV) entries and preview a query's expansion through Zod-validated admin routes; conflicts, chains, cycles, one-character Han variants and stopword-only variants are rejected with row-level issues; a Config UI Terminology panel built from a UI-SPEC covers all of it.
  5. With `RAG_TERMINOLOGY_MINING` on, missed requests are recorded masked per tenant for 30 days, and `npm run rag:terms:mine` proposes candidate terms that admins accept (through the normal create path) or dismiss; nothing is applied automatically.
  6. The eval compares dictionary off and on: the colloquial-term slice improves on Recall@k and MRR, no other slice, language or category drops beyond the noise band, no-answer items containing dictionary terms are still refused, and the terminology stage stays within its chat and voice latency budgets; the three switches stay off (synthetic items are report-only per EVAL-14).
  7. Index-time synonyms are not built; the decision and its reasons (Supabase dictionary files, parser bypass, relex cost) are recorded, and the matched entries are exposed for the Phase 6 rewrite and HyDE prompts.
**Live verification**: Apply 0471–0473 to the real Supabase project and confirm the anon key is refused on every terminology table and RPC; a domain expert imports a small real-domain CSV and checks previews; measure terminology and search p95 for chat and voice on staging; run the miner in dry-run mode on a short opt-in window.
**Plans**: 16 plans in 9 waves (04.1.1-01..04.1.1-16) — see `phases/04.1.1-domain-terminology-dictionary-expert-maintained-synonyms-que/04.1.1-PLAN-INDEX.md`
**UI hint**: yes (plan 13 requires `/gsd-ui-phase 04.1.1` first)

Plans:
- [ ] 04.1.1-01-PLAN.md — Terminology Pydantic contracts and generated Zod (wave 1)
- [ ] 04.1.1-02-PLAN.md — Three switches in the five config places and the manifest; `terminology` stage; run-config allowlist (wave 1)
- [ ] 04.1.1-03-PLAN.md — 0471 tables, RLS, append-only audit, `rag_term_effective` with a two-tenant test (wave 1)
- [ ] 04.1.1-04-PLAN.md — 0472 actor-checked, versioned, audited writers, suppression and atomic import (wave 2)
- [ ] 04.1.1-05-PLAN.md — TRACER: seeded dictionary → terminology stage → `term:0` list → RRF; caps, per-tenant cache (wave 2)
- [ ] 04.1.1-06-PLAN.md — zh/en/it/identifier matching with property tests; conflict/chain/cycle validator (wave 3)
- [ ] 04.1.1-07-PLAN.md — Dense terminology variant (never voice), Phase 6 hint, stage latency budgets (wave 3)
- [ ] 04.1.1-08-PLAN.md — 0473 miss log (self-expiring), candidates, tenant df, decisions; opt-in masked miss recording (wave 4)
- [ ] 04.1.1-09-PLAN.md — Admin service and CRUD/versions/audit routes; two-tenant route matrix (wave 4)
- [ ] 04.1.1-10-PLAN.md — Fixture dictionary and seeding, colloquial-term golden items, run configs, zero-diff re-baseline (wave 4)
- [ ] 04.1.1-11-PLAN.md — CSV import/export with dry run, expansion preview (wave 5)
- [ ] 04.1.1-12-PLAN.md — Miner CLI and candidate review routes; two-tenant mining matrix (wave 6)
- [ ] 04.1.1-13-PLAN.md — Config UI Terminology panel after UI-SPEC (wave 7, autonomous: false)
- [ ] 04.1.1-14-PLAN.md — CLOSING: fold migrations, default-identity gates, on/off comparison, AGENTS.md (wave 8)
- [ ] 04.1.1-15-PLAN.md — Live verification (wave 9, autonomous: false)
- [ ] 04.1.1-16-PLAN.md — Config-hash block, off-identity and multi-tenant end-to-end retrieval case (wave 3)
