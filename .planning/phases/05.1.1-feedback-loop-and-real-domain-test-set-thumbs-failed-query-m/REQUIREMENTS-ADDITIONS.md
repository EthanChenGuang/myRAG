# Requirements additions and changes for Phase 05.1.1

For the orchestrator to apply to `.planning/REQUIREMENTS.md` (and, where noted, to the Phase 7 plan index). Nothing here was applied by the planner.

## New section (insert after "Cross-language & Cache (XLG, CACHE)")

### Feedback Loop (FBK)

- [ ] **FBK-01**: Every knowledge-base retrieval from chat, embed and voice is recorded in a Postgres `rag_retrieval_log` row written after the response (never on the request path): trace id, tenant key, user, organization and chat ids, channel, RAG mode, pipeline, `retrieval_config_hash`, query language, the masked query (only in `masked_query` mode), up to 50 retrieved chunk ids with document ids, ranks and scores and their kept flag, top score, retrieval status, refusal decision and reason, the outcome the user saw (answered, refused, knowledge base unavailable, degraded), total and per-stage latency; switchable with `RAG_RETRIEVAL_LOG=off|ids|masked_query` (default off); eval, media and incognito (ghost) chats are never logged; with the switch off, responses are byte-identical
- [ ] **FBK-02**: The retrieval log minimises personal data: it never stores answer text, chunk text, document names, IPs or user agents; queries pass through the PII masker and are capped; rows are readable and writable only by the service role (RLS on, no client grants), are deleted with their user, organization or chat, and are purged after `RAG_RETRIEVAL_LOG_RETENTION_DAYS` (default 30); each tenant can lower its level to `ids` or `off`; no raw customer data appears in fixtures, logs or reports
- [ ] **FBK-03**: In web chat, behind `RAG_REFUSAL_FEEDBACK` (default off), a strict "information not available" or knowledge-base-unavailable message offers "I expected an answer" / "Correct, not in my documents" with optional reason chips, stored on the user's own log row; behind `RAG_SOURCE_OPEN_SIGNAL` (default off), opening a source or citation is counted on the row as a weak signal; another user's retrieval cannot be voted on
- [ ] **FBK-04**: In the embed widget and embed window, behind `RAG_EMBED_FEEDBACK` and a 32+ character `RAG_EMBED_FEEDBACK_SECRET` (both default off/empty), visitors rate answers (helpful / not helpful with chips, no free text) through a signed per-answer token bound to one trace and one tenant, with the embed CORS rules and rate limiter
- [ ] **FBK-05**: A weekly mining job (`npm run rag:feedback-loop mine`, an admin route, optional `pg_cron`) selects failed queries per tenant — negative votes (embed and Phase 5 web votes), disputed refusals, refusals despite high scores, zero-result and low-score retrievals, possibly-unreliable groundedness, and answered-with-no-source-opened only together with another reason — deduplicates them by query fingerprint, caps them per tenant (default 50) and inserts them idempotently into a tenant-keyed review queue that survives the log purge
- [ ] **FBK-06**: Domain experts are granted per tenant by operator admins (`rag_domain_experts`); database RLS on the review queue shows each expert only the tenants they were granted (in multi-tenant mode admins included, no implicit access); experts read cases, chunk text (only of the case's tenant), search their tenant for missing evidence, and label cases in a Config UI panel with exact evidence spans, an expected answer, category, language and a PII check; every read of chunk text is logged without text; switchable with `RAG_DOMAIN_EXPERT_REVIEW` (default off)
- [ ] **FBK-07**: Labelled cases are triaged into dictionary candidates (observed term, canonical term, relation, language, occurrences) for Phase 4.1.1, training pairs (masked query, positive chunk and span, up to 10 hard negatives from the logged candidates, document group, train or held_out) for Phase 6.1, knowledge-base gaps, and golden candidates; exports carry ids and no chunk text, and no training pair uses a document that belongs to the domain test split
- [ ] **FBK-08**: A real domain test set of 100–300 items per gated tenant is built from approved golden candidates by the single Python promotion (`review_queue promote-db`): provenance `production` (or `human` when the expert paraphrased the question), PII re-checked, near-duplicates confirmed, span evidence without chunk ids, stored only under `eval/golden/private/`, with a dev/test split frozen by document group and near-duplicate cluster (new manifest rule; existing manifests unchanged), append-only
- [ ] **FBK-09**: `eval/config/gate-population.json` (default `legacy`, today's rule) switches the gate to real items (`production` and `human`, approved, gated split) with a minimum size (default 100) that fails the run instead of falling back; `ship_check` passes only when both reports are on the real population and the same manifest, no slice regresses beyond the noise band and the paired bootstrap 95% interval of the target metric is above zero; once the population is real, switching any `RAG_*` default on or activating an embedding profile requires a passing ship check
- [ ] **FBK-10**: A weekly report (`rag_eval.weekly_report`, scheduled in CI where private data exists) shows per tenant hash the retrievals, refusal, zero-result and low-score rates, votes by channel, items mined, labelled and exported, the metric trend of the last eight private eval runs on each domain set, and new failures by layer and category (`rag_eval.failure_report`), with counts, ids and hashes only

## Amended requirements

- **EVAL-16** — keep the text; add at the end: "Web-chat answers are delivered in Phase 5; refusal messages (FBK-03) and the embed widget (FBK-04) are covered in Phase 5.1.1; voice feedback is deferred." Traceability: `EVAL-16 | Phase 5, Phase 5.1.1 | Pending`.
  - Reason: Phase 5 D-05 limits the control to web chat and gives refusals no answerId; the user asked for embed and refusal feedback; no Phase 5 plan is repeated (5.1.1 edits only `src/lib/rag/generation/feedback.ts` from 05-21 to mirror the vote).
- **EVAL-17** — move from Phase 7 to Phase 5.1.1 and change "Admins work the review queue in the Config UI" to "Admins and per-tenant domain experts work the review queue in the Config UI (database-backed, tenant-isolated by RLS)" and "split assigned by the frozen hash rule" to "split assigned by the frozen document-group rule for domain sets (the item hash rule stays for existing sets)". Traceability: `EVAL-17 | Phase 5.1.1 | Pending`.
  - Reason: multi-tenant isolation of experts needs a database queue with RLS; Phase 7 D-21's file queue on the operator's machine cannot provide it. Doing it in 5.1.1 also means the real domain set exists before Phases 6 and 6.1 have to prove improvements on it.
- **EVAL-14** — keep the text; add: "The switch to real items is explicit (`gate-population.json`) and requires a minimum set size (FBK-09)." Traceability unchanged (Phase 2, Complete) plus a note "gate switch in Phase 5.1.1".
- **EVAL-05** — unchanged and stays in Phase 1. Note for the traceability table: its real-KB drafted items keep provenance `claude_draft`/`ragas_generated` and remain report-only; the gating real set comes from FBK-08.

## Traceability rows to add

| Requirement | Phase | Status |
|-------------|-------|--------|
| FBK-01 | Phase 5.1.1 | Pending |
| FBK-02 | Phase 5.1.1 | Pending |
| FBK-03 | Phase 5.1.1 | Pending |
| FBK-04 | Phase 5.1.1 | Pending |
| FBK-05 | Phase 5.1.1 | Pending |
| FBK-06 | Phase 5.1.1 | Pending |
| FBK-07 | Phase 5.1.1 | Pending |
| FBK-08 | Phase 5.1.1 | Pending |
| FBK-09 | Phase 5.1.1 | Pending |
| FBK-10 | Phase 5.1.1 | Pending |

## Consequential changes to Phase 7 plans (orchestrator action, before Phase 7 executes)

Because EVAL-17 moves here (05.1.1-CONTEXT.md D-02), Phase 7 must not execute the same work again:

| Phase 7 item | Change | Replaced by |
|--------------|--------|-------------|
| 07-22 (promotion, near-duplicates, append-only, retrieved ids in pull) | retire | 05.1.1-19 (promote-db, docgroup split, near_dup.py, runner completeness check); retrieved ids come from `rag_review_items` snapshots instead of trace metadata |
| 07-23 (retrieved ids in Langfuse metadata, review chunks route via Langfuse) | retire | 05.1.1-12 (chunk route from the review item snapshot, tenant-restricted) |
| 07-26 (failure report and nightly job) | retire | 05.1.1-20 (failure_report) and 05.1.1-21 (weekly job and lint rules) |
| 07-29 (Config UI review panel, authorize route, execFile promotion) | retire | 05.1.1-17 and 05.1.1-18 (panels against tenant-scoped routes); promotion is an operator CLI, so no execFile path is needed |
| 07-17 | drop `ReviewPromotion`, `ReviewEvidenceSpan`, `ReviewRetrievedChunk`, `FailureReport`, `FailureEntry` and the ReviewQueueItem additions; keep the release contracts | 05.1.1-01 (ExpertLabel, ReviewItem, FailureReport) |
| 07-27 | replace dependencies 07-26 and 07-29 with 05.1.1-22; document the 5.1.1 CLIs by reference | — |
| 07-CONTEXT D-21 to D-23 | mark "moved to Phase 5.1.1 (D-02 there)" | — |
| 07-17 `DefaultsDecision` | should reference a `ShipCheckResult` (05.1.1-01) for every default flipped on once the gate population is real | — |

## Exact edits for the orchestrator (checklist)

1. `.planning/REQUIREMENTS.md` traceability table:
   - change `| EVAL-16 | Phase 5 | Pending |` to `| EVAL-16 | Phase 5, Phase 5.1.1 | Pending |`;
   - change `| EVAL-17 | Phase 7 | Pending |` to `| EVAL-17 | Phase 5.1.1 | Pending |`;
   - add the ten FBK rows above; apply the EVAL-14, EVAL-16 and EVAL-17 text amendments above.
2. Phase 7 plan index `.planning/phases/07-external-backends-release-defaults/07-PLAN-INDEX.md`:
   - retire 07-22, 07-23, 07-26 and 07-29 (mark "moved to Phase 5.1.1: replaced by 05.1.1-19, 05.1.1-12, 05.1.1-20/21, 05.1.1-17/18"); remove them from the waves table, the EVAL-17 coverage row (EVAL-17 leaves Phase 7) and every shared-file ordering note;
   - mark the four plan files themselves as retired (header note) so no executor runs them.
3. `07-17-PLAN.md`: trim `ReviewPromotion`, `ReviewEvidenceSpan`, `ReviewRetrievedChunk`, `FailureReport`, `FailureEntry`, the ReviewQueueItem additions and the `ReviewPromotion.schema.json` / `FailureReport.schema.json` / `ReviewQueueItem.schema.json` outputs; drop EVAL-17 from its requirements; keep the release, regression and vendor contracts; optionally add a `ship_check_ref` (ShipCheckResult, 05.1.1-01) to `DefaultsDecision`.
4. `07-27-PLAN.md`: replace `"07-26"` and `"07-29"` in `depends_on` with `"05.1.1-22"`, and document the 5.1.1 CLIs and panels by reference instead of the retired plans.
5. `07-CONTEXT.md`: under D-21, D-22 and D-23 add "Moved to Phase 5.1.1 (05.1.1-CONTEXT.md D-02); not implemented in Phase 7."; remove EVAL-17 from "Requirements in scope".
6. `.planning/ROADMAP.md`: replace the 5.1.1 placeholder with `ROADMAP-SECTION.md`; in Phase 7 remove EVAL-17 from **Requirements** and the review-queue success criterion (criterion 6), noting "moved to Phase 5.1.1"; add the Phase 6 ordering note (depend on 05.1.1-22 for shared files).

## Cross-phase notes for sibling inserted phases

- **Phase 4.1.1 (dictionary, log mining)** runs before this phase and already planned for it: its interim `rag_term_misses` log reserves `source = 'feedback'` for this phase (its D-25), and its import service has an adapter for this phase's `DictionaryCandidate` (its D-25a, plan 04.1.1-11, relation values aligned). Plan 05.1.1-24 writes feedback failures into that log through 4.1.1's recorder. Switching 4.1.1's `readMisses` to read `rag_retrieval_log` (its D-25a option) is left as a follow-up; it is not required for either phase's success criteria.
- **Phase 6.1 (fine-tuning)** consumes the `TrainingPair` export as is (its D-08), resolves chunk text by id under the tenant and never trains on `held_out` pairs. Note for 6.1: hard negatives now carry `confirmed` (true when the expert marked the candidate not relevant); 6.1's 'expert-rejected negatives first' rule should read that flag.
- **Migration numbers** 0531–0535 are claimed here; sibling phases should avoid them.

## Revision 2026-11-25: wording for the orchestrator (not applied by the planner)

The sections above were applied to `.planning/REQUIREMENTS.md` and `.planning/ROADMAP.md` before this revision. The revision added D-03a (language columns) and D-29 (seams); the wording below would bring the two files in line. Nothing here was applied.

- **FBK-01** (`.planning/REQUIREMENTS.md`): replace "query language, the masked query (only in `masked_query` mode)" with "query language and its confidence, the languages of the kept chunks and the answer language (codes only, never text), the masked query (only in `masked_query` mode)". Reason: LANG-10 and OBS-03 read these columns.
- **ROADMAP Phase 05.1.1, success criterion 1**: replace "refusal decision and outcome, latency)" with "refusal decision and outcome, latency, and the language codes of the query, the kept chunks and the answer)".
- **ROADMAP Phase 05.1.1, ordering note**: add `src/lib/rag/generation/messages.ts` to the files whose Phase 6 editors depend on 05.1.1-22 (plan 07 adds one exported helper there).
- **LANG-10** (Phase 7) and **OBS-03** (Phase 5.3): optional note "reads the `rag_retrieval_log` language columns frozen by Phase 5.1.1 (D-03a, D-29)". The confidence is a three-value mapping (1, 0.5, null) of the current detector until Phase 7 calibrates it; no schema change is needed for that.
- **OBS-03**: the log has no document-type column; the per-document-type cells resolve the type through `candidates[].document_id`.
- **EVAL-27, EVAL-29, EVAL-30, EVAL-24** (Phase 5.3) and **DATA-24** (Phase 6.3): no text change needed. Their planners should read the plan index section "Seams for later phases" for the interface each one builds on.
- **EVAL-03**: no change. Gold spans stay span-based and never carry chunk ids; the new optional `GoldSpan.document_id` is a document id, set only on promoted domain items.
