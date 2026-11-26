# Standing rules from the user (2026-11-25 ~12:15Z) — add to every executor brief
- Do not dispatch executors for Phase 3.1.1, 4.1, 4.1.1, 5.1.1, 6.1 until the user confirms (revisions come via a separate planning PR). Phases 5, 5.1, 6, 7 continue.
- Brief line for any plan that may touch src/lib/rag/v2/stages/query.ts: "When you change the stage order in src/lib/rag/v2/stages/query.ts, leave a slot for Phase 4.1.1's terminology stage: after the parallel rewrite group and before semantic_cache. Do not order stages in a way that blocks inserting it there."
- Before editing .planning/REQUIREMENTS.md or .planning/ROADMAP.md beyond the progress table, tell the user first.

# Division of work confirmed by the user (2026-11-25 ~12:20Z)
- Planning session (branch claude/zen-dijkstra-slb9wy, session_01SEn5g5YcfR2BPFtLJqq4ed): plans 3.2, 4.2, 5.2, 6.2; revises 3.1.1, 4.1, 4.1.1, 5.1.1, 6.1 per the review report; lands via PRs to trunk; no code, no STATE.md.
- Me (orchestrator): dispatch executors, keep the execution ledger, merge trains, CI, live checks.
- The 9 phases (3.1.1, 3.2, 4.1, 4.1.1, 4.2, 5.1.1, 5.2, 6.1, 6.2) stay filtered in ready2.py BLOCKED_PHASES until BOTH: the matching planning PR is merged to trunk AND the planning session notifies me. Then remove only that phase from the filter and run it in ROADMAP dependency order.
- I never edit REQUIREMENTS.md or ROADMAP.md except the progress table.

# Merge policy from the user (2026-11-25 ~13:20Z): "每次如果测试通过的话，就请自动合并到 main branch 里面，通过 PR。"
- Cut each merge train from trunk (claude/ecstatic-hamilton-86gtwv), open its PR with base `main`.
- When all 8 pr-smoke checks are green, mark the PR ready and merge it through GitHub (merge commit, not squash), without asking again.
- Then bring trunk level with main (fast-forward; if trunk moved, merge main into trunk and push, no force).
- If CI is red: find the root cause and fix on the train branch; never merge red.

# Credentials (user, 2026-11-25 ~13:30Z)
- Whenever I ask the user for an API key, token or similar, include a direct clickable link to the exact page where they create or copy it (e.g. Supabase tokens: https://supabase.com/dashboard/account/tokens; Cohere: https://dashboard.cohere.com/api-keys; Voyage: https://dashboard.voyageai.com/organization/api-keys; Anthropic: https://console.anthropic.com/settings/keys), and for dashboard settings link the exact settings page. Then open the secure form; never ask for the value in chat.

# Cost (user, 2026-11-25 ~13:40Z)
- Avoid paid options. Pick the free solution first; only if nothing free works, ask the user whether to pay. For the leaked-password and backup items: free path chosen.
- Before production: take a backup (owner deferred on 2026-11-25).

# Domain neutrality (owner rule at the top of REQUIREMENTS.md, PR #47, 2026-11-25)
- Capabilities stay domain-agnostic. No product code, config default, prompt, lexicon, rule or Config UI copy may contain the quiz examples (travel/lodging limits, leave days, salaries, restaurants, VPN/password FAQs, branch names). New tests use neutral synthetic sentences; existing fixtures may stay.

# Phase 6.3 + Phase 7 delta (planning PR #50, 2026-11-25)
- Phase 6.3 (Source Deletion Sync & Purge) held. Phase 7 depends on it.
- Phase 7 outbox/adapter plans not yet run must leave room for DATA-24 purge records in the outbox and an always-on RET-14 source-of-truth recheck before rerank for Weaviate/Qdrant. Add this note to any Phase 7 outbox/adapter executor brief.

# PR #51 (2026-11-25): Phase 3.2.1 held. Chat-route prompt assembly: keep the question last, no provider-side truncation (RNK-08); in the brief template.

# Migration number blocks (planning session, 2026-11-25 15:08Z)
- 3.2: 0801-0811; 4.2: 0850-0899; 4.3: 0920-0939; 5.2: 0940-0959; 5.3: 0960-0979; 6.2: 0980-0999. My executors (Phases 5, 5.1, 6, 7, 3.1 fixes) must keep new migrations out of 08xx and 09xx.

# Phase 3.2 approvals (owner, 2026-11-25 ~15:10Z): "Approve plan: 36, 53, 65"
- 36: packages approved (python-docx 1.2.0, lxml 6.1.3, defusedxml 0.7.1, locked versions). Executor brief: record the approval as the checkpoint outcome and continue; stop if versions differ.
- 65: I apply 0801-0810 live myself via Supabase MCP when reached (verify per plan, log it).
- 53: proceed; real-world items (LlamaCloud key, scanned zh/it docs, terminal picker, native-speaker review) recorded as not done unless the owner provides them; never set native_review approved by script.
- (15:12Z) Owner re-confirmed: 'Approve requirements of plan: 36, 53, 65'. Treat all three checkpoints as owner-approved; for 53 still ask for the real inputs (with links) when the plan is reached; zh review can be done by the owner (native Chinese speaker); it review needs an Italian speaker or is recorded 'not reviewed'.

# Phase 3.1.1 released (PR #55, 15:16Z)
- Migrations 0440-0442 rebuild from 0425 bodies; if any later migration redefines rag_chunk_embeddings_guard or rag_reembed_*, stop and report.
- Plan 3.1.1-15 is the human checkpoint (live Voyage, live push of 0440-0442, activation decision); needs >=30 items per doc type from 5.1.1, else doc type pending.
- 06-32 brief MUST say: the semantic-cache key uses the retrieval-config hash computed after the binding legs are planned (3.1.1-09 puts the binding map into that hash).

# 16:16Z: Phase 5.1.1 RELEASED (PRs #57-#60) except 05.1.1-24 (needs 4.1.1). Human checkpoint 05.1.1-23. Migrations 0531-0535. 05.1.1-15 edits page.tsx/answer-metadata.ts/types/chat.ts.
# Phase 7 worker (session_01SEn5g96Hk8UZuW9yEJe9uH) holds 07-17,07-25,07-30,07-31,07-32,07-33 until its PR merges; I also hold 07-22,07-23,07-26,07-29 (not named as free).

# Token flow (owner, 2026-11-25 16:17Z) — TWO STEPS, never in one message:
1. Give the direct link and say what to create. Then STOP and wait.
2. Only after the owner says the token is ready, open the secure form (request_credential).
- 2026-11-25 (planning session): every phase the planning session releases runs as soon as its declared dependencies are on trunk; no separate go message. Phase 6.3 is released but gated on Phase 6 being complete (ready2 PHASE_GATES). 06.3-14 waits for 07-37 and 06.3-26 for Phase 4.3 (stop-and-report). Human plans: 06.3-24, 06.3-25, 06.3-26.
- Phase 4.2 released 2026-11-25 (PRs #70/#71); all plans wait for 04.1-12. 0803 exemptions/hold_publish are config, exempt from purge hooks.

## 2026-11-25 17:40 notes
- Phase 5.2 released (PR #75/#76): 40 plans, migrations 0940-0944; deps 5,5.1,5.1.1,3.2. Chat-route order 05->06->09->10->13->31. 05.2-15 T1 = owner decision D-91 (stop & ask). 05.2-39/40 human (live push after 0801-0810 and 0531-0535 live).
- Phase 5.2.1 released: 26 plans, migration 0950; 01-04 depend on 05.2-38. Chat-route order 14->18->21->26 (26 optional, last). 05.2.1-25 human.
- HOLD 07-18,07-19,07-20,07-48,07-49,07-52 until worker session_01SEn5g8qWVVc3pNBbQ4AFnJ says its PR merged.
- After 07-20 lands: plans adding a setting for a manifest-listed variable add manifest metadata only (no hand-written Config UI input). Tell 05.1.1-02 executor if it runs after 07-20.
- Phase 4.3 released (PR #78/#79): 38 plans, migrations 0920-0931. PGlite-fixture plans serialize within a wave. UI plans 41-46 need 3.2 UI hosts (rag-ui.js, data-queue-extras, scope-tag-picker.tsx). 04.3-53/54 human.
  STATE: 0920-0931 apply after 0703; rerunning <0920 => rerun 0920-0931; if 0802 lands after 0930, extend 0930 hybrid_search_chunks + recompute bind slot.
  Brief notes: 3.2 hybrid_search_translations takes p_access_keys/p_access_all; 4.2 lookup RPCs take p_access_keys/p_access_all + classify in tests/rag-db/access-catalog-sentinel.test.mts, rerun 0921 after 4.2; 5.1.1 rerun 0931; Phase 6 SemanticCache uses cacheAccessKeyPart(scope) + accessRpcArgs(scopeAccessFilter(scope)).
- HOLD 07-38,07-39 too (same worker PR).
- Phase 5.3 released (PR #80/#81): 52 plans, all after 05.1.1-22; migrations 0960-0976; 0976 ships rag_purge_hook_golden_items (inventory interplay with 6.3 per 5.3 index). Lang code 'und'. Re-check contracts vs 4.2 (PR #70) and 5.2 (PR #75). Human plans 05.3-49, 05.3-50 (H-1..H-10).
- PR #82 merged (efdffc31): 07-18/19/20/38/39/48/49/52 released; 07-38/39 depend on 04.3-03/04/07/16.
- Phase 6.2 released (PR #83/#84): 40 plans, migrations 0980-0983; deps 6, 6.1, 4.1.1; 06.2-25/31 wait 4.2; 06.2-09 (+23,29,30,35) wait 5.2 GEN-08. Human: 06.2-13 (owner approval fasttext-predict==0.9.2.4 SUS + lid.176.ftz CC BY-SA; orchestrator runs lock), 06.2-19, 06.2-33.
  Brief note: 06-46 keeps the scope_gate key 06.2-03 adds to eval/config/latency-budgets.json.
  Backlog: WhatsApp handler's /api/chat call has no session -> multi-tenant retrieval has no tenant scope.
- Phase 3.2.1 released: runs after 3.1.1 and its 3.2 deps. Planning session finished; all phases released.
- Owner decisions (PR #85, b782de2c): 05.2-15 T1 = FIX WhatsApp parser, proceed without stopping. 06.2-13 approved fasttext-predict==0.9.2.4 + lid.176.ftz (pinned SHA-256): orchestrator runs the lock when 06.2-13 comes up (still held for that). 5.3 H-3 = Vercel option B (owner does settings change). 4.3 A-10/13/16 confirmed. 6.3/4.2 worker will request holds.
- HOLD 06.3-23..26,28,29 and 04.2-15,21,23,32,39 until session_01SEn5g7a9EXwDVPfZrZtR3u PR merges.
- PR #86 merged (353b45af): 6.3/4.2 holds released; new 06.3-28, 06.3-29 (0729, RAG_SOURCE_PURGE_DAILY_CAP), 04.2-39 (RAG_EMBED_VERSION_SCOPE).
- OWNER RULE (2026-11-25 20:57): archive each executor session as soon as it finishes its plan (after verifying exec/<P> is pushed with SUMMARY) — don't wait for the train merge.
- 04.1-07 gate FAILED (not_flipped): 04.1-09/10/12 held pending owner decision D-13. Also: 03.2-16 adds 0814 (apply after 0803); 03.2-21 deploy sidecar before app.
- OWNER (2026-11-25 ~21:00): Phase 4.1 v2 gate failed -> 'Fix v2, then re-test'. Planning session session_01SEn5g8EMdjRjucm4PH8pUx writes 04.1 gap plans; 04.1-09/10/12 wait for re-run gate.
- PR #92 merged (2d2fa9ed): 04.1 gap plans 04.1-14 (w5), 04.1-16 (w5), 04.1-15 (w6), 04.1-17 (w7, re-run gate). 04.1-09/10/11/12 HELD until 04.1-17 records status flip (if not_flipped -> back to owner). Overlap: 04.1.1-05 vs 04.1-15 (v2/pipeline.ts) and 04.1-16 (run-eval.mts): second lands rebases.
- PROD SEARCH (2026-11-25 22:15): owner OK'd switching prod to v2+lexical, but found v2 strict would refuse (0.65 floor vs CV top 0.39) and legacy uploads have empty lexical_text. Decision: do NOT flip yet; relex live chunks now (agent), flip prod to v2 (RAG_PIPELINE=v2, RAG_LEXICAL_SEARCH=true, RAG_SUPPORTED_LANGUAGES/PRIMARY set) only after 04.1-17 gate passes. Also: legacy upload path doesn't build lexical_text -> future uploads need relex or unified ingest.
- QWEN DECISION (2026-11-25 ~22:40): live 20-question comparison FAILED pre-registered rule (MRR 0.875 vs 0.917; R@5 1.0 both). Stay on openai-3-small. Data: OpenAI answerable hit min 0.331, no-answer top1 max 0.236 -> RAG_LOW_THRESHOLD 0.30 separates them.

# Owner (2026-11-26 ~01:35Z, going to rest): "设计出来以后，不用我同意，就自动上线部署吧。我相信你，也给你权限。" + run ~10 parallel workers on other work + apply Supabase migrations where possible (owner can't click confirmations while away).
# Owner (2026-11-26 ~01:55Z): speed-up approved: rolling refill (keep 15 executors running, train every ~8-10 completions, stacked bases OK), targeted per-plan gates (full suite on trains), split CI ts job. Parallel = 15.
# Owner (2026-11-26 ~01:50Z): "全部工作都由你自主进行，不要问我了。哪怕有删除、delete job 这种危险工作，由你自主完成。" Full autonomy incl. deletions; still: never force-push, never touch secrets, never bypass the Supabase MCP confirmation channel, take a backup/snapshot note before destructive DB ops, log every destructive action here.
# Owner (2026-11-26 ~02:00Z): creating/changing environment variables (Vercel etc.) is also mine to do autonomously; don't ask.
# Owner (2026-11-26 ~02:00Z): no PR per change. Bundle related changes: executors -> exec branches -> merge train PR (~8-10 plans). My own ad-hoc fixes (UI, ops) also go onto branches folded into the next train; separate PR only for an urgent production fix. Speed first.
- (owner, repeated, 2026-11-26) Whenever asking the owner for a token / API key / any credential: always give the direct clickable URL where they create or copy it, in the same message as the request form.
