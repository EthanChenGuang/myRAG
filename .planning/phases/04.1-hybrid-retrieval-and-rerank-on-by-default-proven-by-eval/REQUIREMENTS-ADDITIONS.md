# Phase 4.1 — Requirement additions and amendments

**Status 2026-11-25:** `.planning/REQUIREMENTS.md` already carries DFLT-01 to DFLT-07, their traceability rows and the ADM-02 amendment in the wording of 2026-11-24. The plan revision of 2026-11-25 rewords DFLT-01, DFLT-04 and DFLT-05 below (LANG-01, the ingest dual write, no literal baseline number, RNK-07). REQUIREMENTS.md still has the earlier wording; `04.1-PLAN-INDEX.md` lists the change under "Wording changes needed outside this phase".

## New section (insert after "Rerank & Context (RNK)")

### Retrieval Defaults (DFLT)

- [ ] **DFLT-01**: With the supported languages configured (LANG-01) and no retrieval variable set, every entry point runs the v2 pipeline with hybrid search, `RAG_RERANKER=auto`, threshold refusal on and the eval-chosen fallback floor; the `.env.local` templates leave `RAG_PIPELINE` empty so the default stays implicit; and `RAG_PIPELINE=legacy` restores the previous behaviour exactly (zero paired differences against the legacy baselines, legacy characterization unchanged)
- [ ] **DFLT-02**: `RAG_RERANKER=auto` reranks with Cohere when `COHERE_API_KEY` is set and with an eval-chosen local fallback (local BM25 or fused order) otherwise; a missing key under `auto` never marks a request degraded, and Voyage is used only when named
- [ ] **DFLT-03**: While no calibrated rerank cell applies, v2 refuses with the legacy relevance rule (`RAG_REFUSAL_FLOOR=legacy_rule`) or the similarity floor, whichever the pre-registered rule picks; strict mode's "information not available" stays correct and false refusals do not rise beyond the noise band
- [ ] **DFLT-04**: When `RAG_PIPELINE` is unset, one resolver decides which pipeline serves: if the database lacks a Phase 4 function (`hybrid_search_chunks` on retrieval, `rag_list_chunking_profiles` on the ingest dual write) the process serves the legacy pipeline with one error log, and if the supported languages are not configured it serves legacy with Phase 3.2's startup log and Config UI banner (LANG-01); an explicit `RAG_PIPELINE=v2` keeps failing loudly in both cases (`backend_error`, `languages_not_configured`)
- [ ] **DFLT-05**: The new defaults are adopted only after a gate pre-registered in `eval/config/defaults-gate.json` passes on both fixture modes against the baselines in force (slices within the noise band; ingest overall Recall@10 at least the floor the gate tool derives from the ingest baseline in force when the criteria are committed, recorded with the baseline's sha256; refusal rates; categories with n of at least 8; latency budgets), with and without fixture cells; refusal is judged on the single-threshold behaviour (RNK-07 adds per-mode thresholds, and with its targets unset the result is the same); the decision is recorded with its numbers and is re-run on the real golden dev split once it reaches the live minimums
- [ ] **DFLT-06**: The new switch and value are mirrored in every config location and the eval pin; CI keeps two legacy smoke tiers with zero paired differences next to the default tiers; AGENTS.md and the deployment guide state the defaults, the vendor data flow under `auto`, the upgrade steps and the switch back
- [ ] **DFLT-07**: Real Cohere and Voyage rerankers are measured once on the fixture dev split within a 600-request cap (quality against the local paths, p95 latency for 75 candidates against the chat and voice budgets), report-only, and the decision record takes an entry point off hosted rerank when it fails

## Traceability rows (add)

| Requirement | Phase | Status |
|-------------|-------|--------|
| DFLT-01 | Phase 4.1 | Pending |
| DFLT-02 | Phase 4.1 | Pending |
| DFLT-03 | Phase 4.1 | Pending |
| DFLT-04 | Phase 4.1 | Pending |
| DFLT-05 | Phase 4.1 | Pending |
| DFLT-06 | Phase 4.1 | Pending |
| DFLT-07 | Phase 4.1 | Pending |

## Amendments to existing requirements and plans

- **ADM-02** (Phase 7), proposed wording: "A full regression on the locked test split sets the final defaults for backend, embedding profile and reranker model, starting from the Phase 4.1 retrieval defaults as the incumbent, and the decision is recorded with the numbers." Reason: the product owner moved the pipeline, hybrid and rerank defaults to Phase 4.1 (2026-11-24); Phase 7 still owns backends, embedding profile and the reranker model on real data.
- **Phase 7 plan 07-30** (not edited here): while the Phase 7 record is provisional, the expected map must be the 04.1 decision's `defaults` (from `eval/decisions/04.1-retrieval-defaults.json`) for the five DFLT variables and the incumbent values for everything else; otherwise its check fails on the first run after 04.1-09. Plans 07-17 and 07-25 should read the 04.1 record as the incumbent, and 07-18's manifest `default` field must carry the 04.1 values.
- **Phase 4 D-28** (decision text, not a requirement): its last sentence is superseded for the five DFLT variables by the 2026-11-24 decision; Phase 4 still closes with defaults off (04-42 unchanged), and 4.1 flips them afterwards.
- **RNK-05** unchanged; note for traceability that DFLT-03 covers the fallback used while RNK-05 cells are not yet calibrated live.
- **EVAL-14** unchanged; DFLT-05's real-golden re-run is how EVAL-14 applies to the defaults decision.
- **LANG-01** (Phase 3.2) unchanged. DFLT-01 and DFLT-04 adopt its rule for an unset pipeline (04.1 CONTEXT D-24), and the templates keep the pipeline implicit so that the rule also applies to local installs (D-25). Phase 3.2 owns the reader, the startup log, the banner and the error code.
- **RNK-07** (Phase 4.2) unchanged. This phase keeps the single-threshold behaviour, adds no mode key and records `refusal_basis: "single_threshold"` in the criteria file and the decision record (D-26), so RNK-07's "with the new targets unset the result equals Phase 4 D-18" also holds against the 04.1 decision.
- **Phase 7 plan 07-30**, further amendment (not edited here): accept the empty template value for every name in the decision's `implicit_in_templates` (today `RAG_PIPELINE`). The sentence to add, with the marker plan 04.1-09 checks for, is in `04.1-PLAN-INDEX.md`.
