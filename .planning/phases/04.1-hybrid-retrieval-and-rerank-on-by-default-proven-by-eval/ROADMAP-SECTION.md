### Phase 04.1: Hybrid retrieval and rerank on by default, proven by eval (INSERTED)

**Goal**: An install that sets nothing gets hybrid retrieval and reranking, refuses no-answer questions at least as reliably as today without refusing more answerable ones, and can return to today's behaviour exactly with `RAG_PIPELINE=legacy`, with all of this shown on the eval before the defaults change
**Depends on:** Phase 4 (automated close, plan 04-42; 04-43 live checks not required)
**Requirements**: DFLT-01, DFLT-02, DFLT-03, DFLT-04, DFLT-05, DFLT-06, DFLT-07
**Success Criteria** (what must be TRUE):
  1. With no `RAG_*` variable set, chat, embed, eval and voice run the v2 pipeline with the lexical leg, `RAG_RERANKER=auto`, threshold refusal on and the recorded fallback floor; every other Phase 4 switch keeps its Phase 4 default; the two-tenant matrix passes on every entry point in both tenancy modes.
  2. On a fresh install without rerank keys, `auto` reranks with the eval-chosen local fallback (or keeps the fused order) and no request is marked `degraded`; with `COHERE_API_KEY` set it uses Cohere's quality tier for chat and embed and its fast tier for voice, and Voyage is used only when named.
  3. Strict mode still answers verified-empty retrieval with "information not available" and never reports a knowledge-base failure that way; web search with Exa, `source_images` and the `{{context}}` placeholder work unchanged under the new defaults.
  4. A pre-registered gate, committed before any run, passes on both fixture modes against the baselines in force, with and without fixture-calibrated cells: no gated slice beyond the noise band, ingest-mode Recall@10 at least 0.6195, overall false refusal not above and correct refusal not below baseline beyond the band, no category with n of at least 8 dropping beyond the band, latency within `eval/config/latency-budgets.json`; the decision record lists every number and is marked provisional until the real-golden re-run.
  5. Real Cohere and Voyage rerankers were measured once on the fixture dev split (at most 600 requests): hosted quality is not below the local paths beyond the band, chat p95 is at most 600 ms and voice fast-tier p95 at most 250 ms, or the decision record takes the failing entry point off hosted rerank.
  6. A hosted deployment that never set `RAG_PIPELINE` and lacks the Phase 4 RPC serves legacy answers with one error log instead of failing; `RAG_PIPELINE=v2` set explicitly still fails loudly.
  7. With `RAG_PIPELINE=legacy`, both legacy smoke tiers show zero paired differences against the legacy baselines in CI, and the legacy characterization snapshots are byte-identical to before the phase.
  8. The new switch and value are in every config location and the eval pin, `check-config` passes, and AGENTS.md and the deployment guide state the defaults, the vendor data flow under `auto`, the upgrade steps and the switch back.
**Live verification**: When the real golden dev split reaches the live calibration minimums (20 answerable, 10 no-answer), re-run the gate's slice and refusal criteria on it and record the result next to the 04.1 decision; on a staging Supabase project without migration 0407, deploy with `RAG_PIPELINE` unset and confirm the legacy fallback, then apply the migrations and confirm v2; measure voice p95 end to end with a Cohere key.
**Plans**: 12 plans in 7 waves — see `phases/04.1-hybrid-retrieval-and-rerank-on-by-default-proven-by-eval/04.1-PLAN-INDEX.md`

Plans:
- [ ] 04.1-01-PLAN.md — Legacy-rule refusal floor behind RAG_REFUSAL_FLOOR, shared keep predicate, legacy byte-identical (wave 1)
- [ ] 04.1-02-PLAN.md — Mirror RAG_REFUSAL_FLOOR and the auto value in every config location and the eval pin, defaults unchanged (wave 1)
- [ ] 04.1-06-PLAN.md — Pre-registered gate criteria, run configs with placeholder-only key overlay, defaults gate tool (wave 1)
- [ ] 04.1-03-PLAN.md — RAG_RERANKER=auto: Cohere with key, local fallback otherwise, never degraded, hashes as resolved provider (wave 2)
- [ ] 04.1-04-PLAN.md — Implicit-default readiness: missing hybrid_search_chunks falls back to legacy, explicit v2 unchanged (wave 3)
- [ ] 04.1-05-PLAN.md — Pin legacy characterization; characterize the new defaults with AGENTS §14 assertions (wave 3)
- [ ] 04.1-08-PLAN.md — Capped live Cohere and Voyage quality and latency on the fixture, report-only (wave 3)
- [ ] 04.1-07-PLAN.md — Run the gate on both fixture modes with and without cells, record the retrieval-defaults decision (wave 4)
- [ ] 04.1-09-PLAN.md — Flip the defaults in every location once the decision says flip (wave 5)
- [ ] 04.1-10-PLAN.md — Legacy baselines, re-recorded default baselines, legacy all-zero CI tiers (wave 6)
- [ ] 04.1-11-PLAN.md — AGENTS.md and deployment guide: defaults, auto data flow, upgrade steps, switch back (wave 6)
- [ ] 04.1-12-PLAN.md — Implicit defaults on every entry point, two tenants, un-migrated database, CI-equivalent run (wave 7)

**Cross-phase notes for the roadmap**:
- Phase 4 D-28's last sentence ("the shipped defaults stay off until the Phase 7 regression") is superseded for `RAG_PIPELINE`, `RAG_LEXICAL_SEARCH`, `RAG_RERANKER`, `RAG_REFUSAL_THRESHOLD` and `RAG_REFUSAL_FLOOR` by the product owner's decision of 2026-11-24; Phase 4 itself still closes with the defaults off (04-42 unchanged).
- Phase 7 keeps external backends, the embedding-profile and reranker-model decision on the real locked test split, and the release-defaults check; its incumbent is the 04.1 decision record (see REQUIREMENTS-ADDITIONS.md).
- Phases 5, 5.1, 5.1.1, 6, 6.1 and 7 run after the flip: their route-fixture tests that assert legacy output must pass `env: { RAG_PIPELINE: 'legacy' }`, and their "against Phase 4" comparisons use the post-flip baselines.
