# Phase 4.1 — Requirement additions and amendments

## New section (insert after "Rerank & Context (RNK)")

### Retrieval Defaults (DFLT)

- [ ] **DFLT-01**: With no retrieval variable set, every entry point runs the v2 pipeline with hybrid search, `RAG_RERANKER=auto`, threshold refusal on and the eval-chosen fallback floor, and `RAG_PIPELINE=legacy` restores the previous behaviour exactly (zero paired differences against the legacy baselines, legacy characterization unchanged)
- [ ] **DFLT-02**: `RAG_RERANKER=auto` reranks with Cohere when `COHERE_API_KEY` is set and with an eval-chosen local fallback (local BM25 or fused order) otherwise; a missing key under `auto` never marks a request degraded, and Voyage is used only when named
- [ ] **DFLT-03**: While no calibrated rerank cell applies, v2 refuses with the legacy relevance rule (`RAG_REFUSAL_FLOOR=legacy_rule`) or the similarity floor, whichever the pre-registered rule picks; strict mode's "information not available" stays correct and false refusals do not rise beyond the noise band
- [ ] **DFLT-04**: When `RAG_PIPELINE` is unset and the database lacks `hybrid_search_chunks`, the process serves the legacy pipeline with one error log; an explicit `RAG_PIPELINE=v2` keeps failing loudly
- [ ] **DFLT-05**: The new defaults are adopted only after a gate pre-registered in `eval/config/defaults-gate.json` passes on both fixture modes against the baselines in force (slices within the noise band, ingest Recall@10 at least 0.6195, refusal rates, categories with n of at least 8, latency budgets), with and without fixture cells; the decision is recorded with its numbers and is re-run on the real golden dev split once it reaches the live minimums
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
