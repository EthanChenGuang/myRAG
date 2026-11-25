# Requirements additions — Phase 4.1.1

Proposed for `.planning/REQUIREMENTS.md`. The orchestrator merges these; this file does not edit REQUIREMENTS.md.

## New section under "v1 Requirements"

### Terminology (TERM)

- [ ] **TERM-01**: Domain terminology lives in Postgres in two layers: a deployment-wide shared layer and a per-tenant workspace layer that can add entries and suppress shared ones; single-tenant deployments use the shared layer only; the tables are service-role only (RLS on, no browser access), and a tenant's effective dictionary never contains another tenant's entries (two-tenant tests)
- [ ] **TERM-02**: Every dictionary change increments its layer's version in the same transaction as an append-only audit row (actor, action, before/after, version); writes carry the expected version and fail on a stale one; the effective version used by a request is recorded in its trace and, when the dictionary is on, in its `retrievalConfigHash`
- [ ] **TERM-03**: Admins (AGENTS.md §12 admin auth, workspace scope verified server-side) list, create, edit, delete and suppress entries, read versions and audit, and preview a query's expansion through Zod-validated admin routes; the body can never name an actor or tenant
- [ ] **TERM-04**: Every write and import is validated before it reaches SQL: conflicting mappings, chains, cycles, overlapping equivalence sets, one-character Han variants, stopword-only or tokenless variants and limit violations are rejected with row-level issues; cross-layer overrides are reported
- [ ] **TERM-05**: Admins import a dictionary from CSV with a dry-run report (create/update/unchanged/delete, issues) and an atomic apply that re-checks the version, and export it as formula-safe CSV; files are limited to 1 MB and 5,000 rows
- [ ] **TERM-06**: Under `RAG_PIPELINE=v2` with `RAG_TERMINOLOGY` on, matched entries (Han substring longest-match with ≥ 2 characters, Latin token-boundary phrases, identifier forms) expand the query one hop into a separate lexical RRF list with its own weight and hard caps, leaving the original dense and lexical lists unchanged; a dictionary failure degrades the request instead of failing it; switched off, candidates and the config hash are identical to today's; voice runs the expansion within its stage budget
- [ ] **TERM-07**: With `RAG_TERMINOLOGY_DENSE` on, one dense-only query variant with canonical terms substituted is added after translated variants (never in voice), within `MAX_QUERY_VARIANTS`
- [ ] **TERM-08**: The query stage exposes the matched entries (surface form, canonical, kind, language) and the dictionary version for the Phase 6 query transforms
- [ ] **TERM-09**: With `RAG_TERMINOLOGY_MINING` on, missed requests (empty, refused, degraded without candidates; never eval) are recorded per tenant with a PII-masked query, kept 30 days (interim source until Phase 5.1.1's retrieval log replaces it); `npm run rag:terms:mine` proposes candidate terms (support ≥ 3, absent or rare in that tenant's corpus, not already in the dictionary) for expert review; candidates are never applied automatically and are accepted only by creating an entry through the validated path
- [ ] **TERM-10**: The golden set holds colloquial-term items in zh, en and it whose wording does not occur in the corpus, identifier-alias items and no-answer controls containing dictionary terms; the eval compares dictionary off and on and the phase is complete only if the colloquial-term slice improves and no other slice, language or category drops beyond the noise band and no-answer refusals are unchanged; all three switches stay off until real (`production`/`human`) colloquial items pass the gate
- [ ] **TERM-11**: Admins maintain the dictionary in a Config UI Terminology panel (layer and workspace, entries, validation issues, import/export, preview, versions/audit, mined candidates), designed from a UI-SPEC

## Traceability rows

| Requirement | Phase | Status |
|-------------|-------|--------|
| TERM-01 | Phase 4.1.1 | Pending |
| TERM-02 | Phase 4.1.1 | Pending |
| TERM-03 | Phase 4.1.1 | Pending |
| TERM-04 | Phase 4.1.1 | Pending |
| TERM-05 | Phase 4.1.1 | Pending |
| TERM-06 | Phase 4.1.1 | Pending |
| TERM-07 | Phase 4.1.1 | Pending |
| TERM-08 | Phase 4.1.1 | Pending |
| TERM-09 | Phase 4.1.1 | Pending |
| TERM-10 | Phase 4.1.1 | Pending |
| TERM-11 | Phase 4.1.1 | Pending |

## Amendments to existing requirements

| Requirement | Proposed change | Reason |
|-------------|-----------------|--------|
| **QRY-01** (Phase 6) | Append: "When the terminology dictionary is on, the rewrite prompt receives the matched dictionary entries (surface form → canonical, kind) as a glossary and keeps canonical terms verbatim in the rewritten query; the original query is still retrieved." | The rewriter otherwise re-paraphrases domain terms the expert dictionary already resolved, and can drop canonical terms the lexical leg needs (TERM-08). |
| **QRY-03** (Phase 6) | Append: "HyDE receives the same glossary so the hypothetical document uses the canonical terms." | HyDE text written in the user's colloquial vocabulary embeds away from the documents' terms. |
| **QRY-02** (Phase 6) | Append: "Dictionary-derived variants (TERM-07) count toward the multi-query variant cap; multi-query does not re-generate a variant equal to the terminology variant." | Avoids duplicate embedding calls and double-counting in RRF. |
| **EVAL-14** | No text change; note in the traceability table that Phase 4.1.1 adds `colloquial` items of the dictionary kind (synthetic, report-only). | Keeps the EVAL-14 gate rule (real items gate once they exist) explicit for the new items. |
| **FBK-07** (Phase 5.1.1, planned in parallel) | Append: "Dictionary candidates (`DictionaryCandidate` JSONL, relation synonym/abbreviation/translation/misspelling) are imported through Phase 4.1.1's import dry run and apply (TERM-05), never written to the dictionary tables directly; once `rag_retrieval_log` exists, the Phase 4.1.1 term miner reads its missed retrievals instead of `rag_term_misses`, and `RAG_TERMINOLOGY_MINING` recording is retired." | Avoids two query logs with different retention and privacy rules; 4.1.1's miss log is the interim source because 4.1.1 ships first (CONTEXT D-25a). |

## Out of scope (add to "Out of Scope")

| Feature | Reason |
|---------|--------|
| Index-time synonyms (Postgres thesaurus/synonym dictionaries, canonical terms in `lexical_text`) | Hosted Supabase gives no access to dictionary files, the lexical index bypasses the text-search parser by design, and index-time synonyms would turn every dictionary edit into a corpus-wide relex; query-time expansion covers the same recall (Phase 4.1.1 D-14) |
| Automatic application of mined terms | Experts approve every entry (TERM-09) |
