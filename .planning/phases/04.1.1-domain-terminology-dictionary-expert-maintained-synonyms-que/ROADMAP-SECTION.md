### Phase 04.1.1: Domain terminology dictionary: expert-maintained synonyms, query expansion, index-time synonyms, log mining (INSERTED)

**Goal**: When users ask in their own words (informal terms, abbreviations, loosely typed codes and identifiers) in any enabled language, retrieval still finds the chunks that use the documents' own terms, through a dictionary that domain experts maintain per deployment and per tenant, that is versioned and audited, that never lets expansion outweigh the original query, that grows from reviewed candidates mined from missed queries, and that later phases read through one stable, tenant-scoped interface (tokenizer dictionary, translation glossary)
**Depends on**: Phase 4.1 (after its last plan, 04.1-12); Phase 3.2's registry-derived language type and language settings module on trunk (plans 04.1.1-01 and 04.1.1-09 stop and report without them). Phase 6 is executing in parallel: each plan that touches one of its seams (stage order, variant cap, semantic-cache key, prompts) implements the branch that matches trunk and waits for nothing.
**Requirements**: TERM-01, TERM-02, TERM-03, TERM-04, TERM-05, TERM-06, TERM-07, TERM-08, TERM-09, TERM-10, TERM-11, TERM-12
**Success Criteria** (what must be TRUE):
  1. On a local Postgres with pgvector seeded with the fixture corpus, synthetic documents and a synthetic dictionary, a colloquial question in each fixture language whose wording does not occur in the corpus retrieves the gold chunk under the effective v2 pipeline with `RAG_TERMINOLOGY` on, through a separate down-weighted lexical RRF list built from the standalone query after the query transforms and before the semantic cache and embedding; the original dense and lexical lists are unchanged, expansion is one hop and capped, and with the switch off candidates and `retrievalConfigHash` are identical to a database without a dictionary.
  2. With full original lists, an expansion-only hit reaches the rerank input at every cap the contract allows (including Phase 4.2's lower floor) through a bounded reservation, and never ahead of an original hit; no pool size, cap or weight is assumed.
  3. Dictionary entries live in a shared layer and per-tenant workspace layers in service-role-only tables; a tenant's effective dictionary, previews, read-API results, mined candidates and corpus document frequencies never include another tenant's data (two-tenant tests in both deployment modes); anon and authenticated cannot read the tables or execute any `rag_term_*` function, and CI fails if code outside the terminology module reads them.
  4. Every change bumps its layer version with an append-only audit row and fails on a stale expected version; the version a request used appears in its trace, its config hash and its semantic-cache key.
  5. Admins create, edit, delete, suppress, import (dry run, then atomic apply) and export (formula-safe CSV) entries, translation pairs included, and preview a query's expansion through Zod-validated admin routes; conflicts, chains, cycles, one-character Han variants, stopword-only variants, languages the deployment does not enable and malformed translation pairs are rejected with row-level issues; a Config UI Terminology panel built from a UI-SPEC covers all of it.
  6. Translation pairs are stored with their source and target languages, never expand queries, and are returned with the effective terms by `getTerminologyLexicon(scope, options)` from `@/lib/rag`, whose version and content hash Phase 4.2 and Phase 6.2 use; a contract test locks its shape.
  7. With `RAG_TERMINOLOGY_MINING` on, missed requests are recorded masked per tenant for 30 days, and `npm run rag:terms:mine` proposes candidate terms that admins accept (through the normal create path) or dismiss; nothing is applied automatically.
  8. The eval compares dictionary off and on: the colloquial-term slice improves on Recall@k and MRR, no other slice, language or category drops beyond the noise band, no-answer items containing dictionary terms are still refused, and the terminology stage stays within its chat and voice latency budgets; the three switches stay off (synthetic items are report-only per EVAL-14).
  9. Index-time synonyms are not built; the decision and its reasons (Supabase dictionary files, parser bypass, relex cost) are recorded, and the matched entries are exposed for the Phase 6 rewrite and HyDE prompts, both as stage output and through an earlier glossary helper.
**Live verification**: Apply 0471–0473 to the real Supabase project and confirm the anon key is refused on every terminology table and RPC; a domain expert imports a small real-domain CSV, enters one translation pair and checks previews; measure terminology and search p95 for chat and voice on staging; run the miner in dry-run mode on a short opt-in window.
**Plans**: 18 plans in 9 waves (04.1.1-01..04.1.1-18) — see `phases/04.1.1-domain-terminology-dictionary-expert-maintained-synonyms-que/04.1.1-PLAN-INDEX.md`
**UI hint**: yes (plan 13 requires `/gsd-ui-phase 04.1.1` first)

Plans:
- [ ] 04.1.1-01-PLAN.md — Terminology Pydantic contracts (translation pairs, read contract, stage name) and generated Zod (wave 1)
- [ ] 04.1.1-02-PLAN.md — Three switches in the five config places and the manifest; `terminology` stage and its budgets; run-config allowlist (wave 1)
- [ ] 04.1.1-03-PLAN.md — 0471 tables, RLS, append-only audit, translation-pair checks, `rag_term_effective` with a two-tenant test (wave 1)
- [ ] 04.1.1-04-PLAN.md — 0472 actor-checked, versioned, audited writers, suppression and atomic import (wave 2)
- [ ] 04.1.1-05-PLAN.md — TRACER: seeded dictionary → terminology stage on the standalone query → `term:0` list → RRF; caps, per-tenant cache (wave 2)
- [ ] 04.1.1-06-PLAN.md — Multi-script and identifier matching with property tests; validator with language and translation-pair rules (wave 3)
- [ ] 04.1.1-07-PLAN.md — Dense terminology variant counted against the variant and search caps (never voice); glossary helper for Phase 6 prompts (wave 3)
- [ ] 04.1.1-16-PLAN.md — Config-hash block and semantic-cache key, off-identity, multi-tenant end-to-end retrieval case (wave 3)
- [ ] 04.1.1-17-PLAN.md — Stable read API `getTerminologyLexicon`, contract lock, boundary rule, two-tenant test (wave 3)
- [ ] 04.1.1-08-PLAN.md — 0473 miss log (self-expiring), candidates, tenant df, decisions; opt-in masked miss recording (wave 4)
- [ ] 04.1.1-09-PLAN.md — Admin service and CRUD/versions/audit routes, translation pairs and enabled languages; two-tenant route matrix (wave 4)
- [ ] 04.1.1-10-PLAN.md — Synthetic documents and fixture dictionary, colloquial-term golden items, run configs, zero-diff re-baselines (wave 4)
- [ ] 04.1.1-18-PLAN.md — Bounded rerank-input reservation for expansion-only hits, proven with full lists at several caps (wave 4)
- [ ] 04.1.1-11-PLAN.md — CSV import/export with translation columns and dry run, expansion preview (wave 5)
- [ ] 04.1.1-12-PLAN.md — Miner CLI and candidate review routes; two-tenant mining matrix (wave 6)
- [ ] 04.1.1-13-PLAN.md — Config UI Terminology panel after UI-SPEC, translation pairs included (wave 7, autonomous: false)
- [ ] 04.1.1-14-PLAN.md — CLOSING: fold migrations, default-identity gates, on/off comparison, AGENTS.md (wave 8)
- [ ] 04.1.1-15-PLAN.md — Live verification (wave 9, autonomous: false)
