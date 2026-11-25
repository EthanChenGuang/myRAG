# Requirements additions — Phase 4.1.1

Proposed for `.planning/REQUIREMENTS.md`. The orchestrator merges these; this file does not edit REQUIREMENTS.md. Revised 2026-11-25: TERM-06, TERM-07 and TERM-10 are reworded, TERM-12 is new, and the FBK-07 amendment gains one field. TERM-01 to TERM-11 and the QRY and FBK-07 amendments of 2026-11-24 are already in REQUIREMENTS.md; the differences are listed in `04.1.1-PLAN-INDEX.md`, "Wording changes needed outside this phase".

## Section "Terminology (TERM)" under "v1 Requirements"

- [ ] **TERM-01**: Domain terminology lives in Postgres in two layers: a deployment-wide shared layer and a per-tenant workspace layer that can add entries and suppress shared ones; single-tenant deployments use the shared layer only; the tables are service-role only (RLS on, no browser access), and a tenant's effective dictionary never contains another tenant's entries (two-tenant tests)
- [ ] **TERM-02**: Every dictionary change increments its layer's version in the same transaction as an append-only audit row (actor, action, before/after, version); writes carry the expected version and fail on a stale one; the effective version used by a request is recorded in its trace and, when the dictionary is on, in its `retrievalConfigHash`
- [ ] **TERM-03**: Admins (AGENTS.md §12 admin auth, workspace scope verified server-side) list, create, edit, delete and suppress entries, read versions and audit, and preview a query's expansion through Zod-validated admin routes; the body can never name an actor or tenant
- [ ] **TERM-04**: Every write and import is validated before it reaches SQL: conflicting mappings, chains, cycles, overlapping equivalence sets, one-character Han variants, stopword-only or tokenless variants, languages the deployment does not enable, malformed translation pairs and limit violations are rejected with row-level issues; cross-layer overrides are reported
- [ ] **TERM-05**: Admins import a dictionary from CSV with a dry-run report (create/update/unchanged/delete, issues) and an atomic apply that re-checks the version, and export it as formula-safe CSV; files are limited to 1 MB and 5,000 rows
- [ ] **TERM-06**: Under the effective v2 pipeline (explicitly set or the Phase 4.1 default) with `RAG_TERMINOLOGY` on, matched entries in the standalone query (Han substring longest-match with ≥ 2 characters, Latin token-boundary phrases, identifier forms) expand it one hop into a separate lexical RRF list with its own weight, hard caps and a small bounded reservation in the rerank input, leaving the original dense and lexical lists unchanged; the stage runs after the query transforms and before the semantic cache and embedding; a dictionary failure degrades the request instead of failing it; switched off, candidates and the config hash are identical to today's; voice runs the expansion within its stage budget; no pool size, cap or weight is assumed, they are read at run time
- [ ] **TERM-07**: With `RAG_TERMINOLOGY_DENSE` on, one dense-only query variant with canonical terms substituted is added (never in voice): without the Phase 6 query layer after translated variants and within `MAX_QUERY_VARIANTS`; with it, first in the multi-query group, counted toward its LLM-variant limit, and, together with the extra lexical search, toward the per-request search cap, never displacing the original, condensed, translated or sub-question variants
- [ ] **TERM-08**: The query stage exposes the matched entries (surface form, canonical, kind, language) and the dictionary version for the Phase 6 query transforms, and a glossary helper gives the same matches to rewrite and HyDE prompts built before the stage runs
- [ ] **TERM-09**: With `RAG_TERMINOLOGY_MINING` on, missed requests (empty, refused, degraded without candidates; never eval) are recorded per tenant with a PII-masked query, kept 30 days (interim source until Phase 5.1.1's retrieval log replaces it); `npm run rag:terms:mine` proposes candidate terms (support ≥ 3, absent or rare in that tenant's corpus, not already in the dictionary) for expert review; candidates are never applied automatically and are accepted only by creating an entry through the validated path
- [ ] **TERM-10**: The golden set holds colloquial-term items in every fixture language (zh, en and it in CI) whose wording does not occur in the corpus, identifier-alias items and no-answer controls containing dictionary terms, all built from synthetic placeholder content; the eval compares dictionary off and on and the phase is complete only if the colloquial-term slice improves and no other slice, language or category drops beyond the noise band and no-answer refusals are unchanged; all three switches stay off until real (`production`/`human`) colloquial items pass the gate
- [ ] **TERM-11**: Admins maintain the dictionary in a Config UI Terminology panel (layer and workspace, entries including translation pairs, validation issues, import/export, preview, versions/audit, mined candidates), designed from a UI-SPEC
- [ ] **TERM-12**: The dictionary stores per-language translation pairs for XLG-05 as entries of kind `translation` with required, different source and target languages from the enabled language registry (never `any`), the required target-language term as canonical and the source-language terms as variants, one-way only; they are validated, versioned, audited, imported and exported like every entry and never used for same-language expansion; a stable tenant-scoped read API, `getTerminologyLexicon(scope, options)` exported from `@/lib/rag`, returns the effective terms (and, on request, the translation pairs) with the effective version and a content hash for the LANG-07 tokenizer dictionary and the XLG-05 glossary; its shape is locked by a contract test, and no code outside the terminology module reads the dictionary tables (CI boundary rule)

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
| TERM-12 | Phase 4.1.1 | Pending |

## Amendments to existing requirements

| Requirement | Proposed change | Reason |
|-------------|-----------------|--------|
| **QRY-01** (Phase 6) | Already merged (2026-11-24). Add: "The glossary comes from Phase 4.1.1's `terminologyGlossary` helper, because the terminology stage runs after the query transforms." | The stage now runs after Phase 6's parallel group (CONTEXT D-15, D-20). |
| **QRY-02** (Phase 6) | Already merged (2026-11-24). Replace "count toward the multi-query variant cap" with "take the first place of the multi-query group and count toward its LLM-variant limit; the extra terminology lexical search counts toward the per-request search cap, and neither displaces the original, condensed, translated or sub-question variants (Phase 4.1.1 D-31)". | Makes the accounting against Phase 6 D-08 exact. |
| **QRY-03** (Phase 6) | Already merged (2026-11-24). Add the same `terminologyGlossary` source as QRY-01. | Same reason as QRY-01. |
| **XLG-05** | Add: "Translation pairs are entries of kind `translation` in the TERM dictionary (TERM-12), read through `getTerminologyLexicon` with `includeTranslations`." | Names the encoding and the read path XLG-05's implementer uses. |
| **LANG-07** | Add: "The dictionary is read through `getTerminologyLexicon` (TERM-12); its `version` and `entries_sha256` decide when `LEXICAL_VERSION` is bumped and a relex runs." | Names the stable interface and the relex trigger. |
| **EVAL-14** | No text change; note in the traceability table that Phase 4.1.1 adds `colloquial` items of the dictionary kind (synthetic, report-only). | Keeps the EVAL-14 gate rule (real items gate once they exist) explicit for the new items. |
| **FBK-07** (Phase 5.1.1) | Already merged (2026-11-24). Add: "A `DictionaryCandidate` with relation `translation` carries `canonical_language` (the target language); without it the Phase 4.1.1 import reports `invalid_translation`." | A translation pair needs both languages (TERM-12); the import never guesses one (CONTEXT D-25a). |

## Out of scope (add to "Out of Scope")

| Feature | Reason |
|---------|--------|
| Index-time synonyms (Postgres thesaurus/synonym dictionaries, canonical terms in `lexical_text`) | Hosted Supabase gives no access to dictionary files, the lexical index bypasses the text-search parser by design, and index-time synonyms would turn every dictionary edit into a corpus-wide relex; query-time expansion covers the same recall (Phase 4.1.1 D-14) |
| Automatic application of mined terms | Experts approve every entry (TERM-09) |
