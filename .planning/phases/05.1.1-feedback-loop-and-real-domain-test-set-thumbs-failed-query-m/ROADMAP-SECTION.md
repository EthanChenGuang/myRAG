# Proposed ROADMAP section for Phase 05.1.1

Replace the placeholder section `### Phase 05.1.1: ...` in `.planning/ROADMAP.md` with the block below, and the overview line with:

`- [ ] **Phase 05.1.1: Feedback Loop & Real Domain Test Set** (INSERTED) - Tenant-safe retrieval log, refusal and embed feedback, weekly failure mining into an expert-labelled queue, dictionary and training exports, and a real domain test set that gates releases`

---

### Phase 05.1.1: Feedback Loop & Real Domain Test Set (INSERTED)
**Goal**: Production use continuously produces evaluation data: every retrieval is recorded privately per tenant, failed answers are found every week and labelled by the tenant's own experts, and improvements must be proven on a real domain test set before they go live
**Depends on**: Phase 5.1 (and Phase 5: builds on `rag_answer_records`, the web answer vote and the review reasons; Phase 4.1.1 for plan 05.1.1-24 only)
**Requirements**: FBK-01, FBK-02, FBK-03, FBK-04, FBK-05, FBK-06, FBK-07, FBK-08, FBK-09, FBK-10, EVAL-16 (embed and refusal extension), EVAL-17 (moved from Phase 7)
**Success Criteria** (what must be TRUE):
  1. With `RAG_RETRIEVAL_LOG` on, every chat, embed and voice retrieval writes one `rag_retrieval_log` row after the response (query masked or omitted, tenant, chunk ids, ranks and scores, config hash, refusal decision and outcome, latency), never answer or chunk text; eval, media and ghost chats are never logged; rows are service-role only, deleted with their user, organization or chat, purged after the retention window, and a tenant can lower or switch off logging; with every switch off the chat, embed and voice responses are byte-identical (characterization) and no row is written.
  2. Users can mark a strict refusal as "I expected an answer", embed visitors can rate answers through a signed per-answer token, opening a source is counted, and Phase 5's web answer votes reach the same table; votes on another user's or another tenant's retrieval are impossible (404 tests).
  3. Weekly mining turns thumbs-down, disputed refusals, refusals with high scores, zero-result and low-score retrievals and flagged groundedness into a capped, deduplicated review queue per tenant; database RLS ensures an expert of tenant A never sees tenant B's cases, shown by two-tenant tests at the SQL and API levels, and operator admins see a tenant only after an explicit grant in multi-tenant mode.
  4. In the Config UI an expert labels a case (correct documents and exact evidence spans, expected answer, PII check) and triages it into dictionary candidates (for Phase 4.1.1), training pairs with hard negatives and document groups (for Phase 6.1) and golden candidates; no training pair uses a document of the domain test split.
  5. Approved golden candidates become a real domain test set (provenance `production` or `human`, private path only, frozen document-group split, near-duplicates confirmed, append-only); `gate-population.json` switches the gate to real items with a minimum size, `ship_check` passes only on a real-set improvement without slice regressions, and a weekly report shows loop activity, metric trends and new failures by layer and category.
  6. The phase comparison against the Phase 5.1 closing report shows retrieval paired differences of exactly zero with the switches off and on, and request latency within the OBS-02 budgets.
**Live verification**: Apply 0531 to 0535 to the real project and check two-tenant RLS; confirm after()-written rows and latency on real streams, embed and voice; collect and label 100–300 real user questions with domain experts, PII-review and promote them; switch the gate to real items, record a three-run real baseline and set improvement targets for Phases 6 and 6.1 (plan 05.1.1-23).
**UI**: `/gsd-ui-phase 05.1.1` must produce `05.1.1-UI-SPEC.md` before execution (surfaces: Config UI switches, web chat refusal control and source-open signal, embed widget and window rating, Config UI expert labelling panel, Config UI feedback loop admin card).
**Ordering note**: Phase 6 plans that edit `src/app/api/chat/route.ts`, `src/app/api/embed/chat/route.ts`, `src/lib/rag/trace/finish.ts`, `src/lib/rag/pipeline.ts`, `src/lib/rag/index.ts`, the five config files, `AGENTS.md` or the setup files depend on 05.1.1-22.
**Plans**: 25 plans in 8 waves (05.1.1-01..05.1.1-25); closing plan 05.1.1-22 — plan index `phases/05.1.1-feedback-loop-and-real-domain-test-set-thumbs-failed-query-m/05.1.1-PLAN-INDEX.md`

Plans:
**Wave 1**
- [ ] 05.1.1-01-PLAN.md — Pydantic feedback-loop contracts with generated Zod; docgroup manifest rule; mining review reasons; gate_population real (wave 1)
- [ ] 05.1.1-02-PLAN.md — Seven switches in the five config locations, manifest and eval pin; call-time config reader; mining thresholds file (wave 1)
- [ ] 05.1.1-03-PLAN.md — rag_retrieval_log (0531, 0532 per mode) and purge function (0533) with the 0410 lock, PGlite tests in both modes (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*
- [ ] 05.1.1-04-PLAN.md — Tenant settings, domain experts, review items with the RLS helper and immutable split (0534), mining function (0535), two-tenant RLS tests (wave 2)
- [ ] 05.1.1-05-PLAN.md — Log row builder and after-response writer on the trace seam; logOutcome holder (wave 2)
- [ ] 05.1.1-06-PLAN.md — Gate population switch (legacy default, real with min_items) and report wording (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*
- [ ] 05.1.1-07-PLAN.md — Chat, embed and voice log context and outcomes; characterization unchanged; two-tenant route test (wave 3)
- [ ] 05.1.1-08-PLAN.md — Tenant opt-out, purge CLI and route, optional pg_cron schedule (wave 3)
- [ ] 05.1.1-12-PLAN.md — Expert grants route; RLS-scoped review list, item and chunk routes with the two-tenant API test (wave 3)
- [ ] 05.1.1-25-PLAN.md — Mirror Phase 5 web answer votes onto the retrieval log row (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*
- [ ] 05.1.1-09-PLAN.md — Refusal vote and source-open routes; switch-guarded refusal metadata (wave 4)
- [ ] 05.1.1-10-PLAN.md — Signed embed feedback token, stream metadata and CORS vote route (wave 4)
- [ ] 05.1.1-11-PLAN.md — Weekly mining: module, CLI and admin route, end-to-end two-tenant test (wave 4)
- [ ] 05.1.1-13-PLAN.md — Label validation with exact quotes; review search inside the item's tenant (wave 4)

**Wave 5** *(blocked on Wave 4 completion)*
- [ ] 05.1.1-14-PLAN.md — Dictionary, training and golden exports with the held_out leakage guard; mark-exported route (wave 5)
- [ ] 05.1.1-15-PLAN.md — Web chat refusal control and source-open signal (UI) (wave 5)
- [ ] 05.1.1-16-PLAN.md — Embed widget and window rating control (UI) (wave 5)
- [ ] 05.1.1-17-PLAN.md — Config UI expert labelling panel (UI) (wave 5)
- [ ] 05.1.1-20-PLAN.md — Stats route, failure report and weekly report (wave 5)
- [ ] 05.1.1-24-PLAN.md — Bridge thumbs-down and disputed-refusal failures into Phase 4.1.1's miss log (wave 5)

**Wave 6** *(blocked on Wave 5 completion)*
- [ ] 05.1.1-18-PLAN.md — Config UI feedback loop admin card (UI) (wave 6)
- [ ] 05.1.1-19-PLAN.md — Document-group split, near-duplicates, promote-db and the export writer (wave 6)
- [ ] 05.1.1-21-PLAN.md — Ship check and the weekly workflow job with lint rules (wave 6)

**Wave 7** *(blocked on Wave 6 completion)*
- [ ] 05.1.1-22-PLAN.md — Fold migrations, AGENTS.md, comparison against Phase 5.1, full gates (wave 7)

**Wave 8** *(blocked on Wave 7 completion)*
- [ ] 05.1.1-23-PLAN.md — Live verification and the first real domain test set (wave 8, autonomous: false)
