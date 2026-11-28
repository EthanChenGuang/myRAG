# Production action log (owner desk)

## 2026-11-27 train 36 on Supabase ppvywaxrycaxrtrrditl (multi-tenant)
- Owner approved the DROP sections in chat (~13:20 UTC) after the walkthrough of the sql/train36-live.sql header.
- Pre-checks: last prod migration train35_0410_r18_delta; PR #131 merged (274d0456); each sql/train36-live.sql section is identical to origin/main.
- 0950 pre-check: the existing review-reason checks on prod are the 0944 lists, so 0950 only widens them (no 0967 values lost).
- Applied with apply_migration, in order, all success:
  train36_0903_lexical_stats_purge_hook (20261127132548), train36_0923_access_labels_and_resolution (…133325),
  train36_0926_access_rls (…133348), train36_0926_access_rls_multi_tenant (…133356), train36_0931_access_derived_stores (…133435),
  train36_0950_calc_review_reasons (…133850), train36_0410_r19_delta (…133853).
- Deviation (my error): in the train36_0410_r19_delta text, the last GRANT inside `IF to_regprocedure('public.rag_caller_is_access_admin()') IS NOT NULL`
  was typed as `rag_caller_access_admin()`. That function does not exist on prod (single-tenant only), so the branch never ran; the
  resulting DB state is the same as the file's. Only the stored migration text differs from the file, in one line.
- Verification: all 21 new or changed functions exist; every one is not executable by anon/authenticated except rag_caller_access_keys and
  rag_access_enforced (by design). Exactly one rag_cache_check overload. All 9 triggers are enabled; 3 rag_access_groups_restrict policies
  are RESTRICTIVE; 8 checks validated; 5 GIN indexes; RLS on for all 11 tables checked; rag_access_group_settings.enforced=false;
  rag_access_groups_drift() = 0 for all 4 stores.

## 2026-11-27 ~13:55 UTC: WhatsApp live check 05.2-15 blocked
- Owner has never connected WhatsApp. Vercel prod env (names only, not decrypted) has no WHATSAPP_*, FLYIO_* or KOYEB_* variables: no Baileys service is configured.
- To run the check: deploy baileys-whatsapp/ (Fly.io), set WHATSAPP_PROVIDER, FLYIO_BAILEYS_URL, WHATSAPP_WEBHOOK_URL on Vercel (owner enters FLYIO_API_KEY and WHATSAPP_WEBHOOK_SECRET), redeploy, scan the QR from the app's WhatsApp connect button with a spare number, test from another phone.
- Asked the owner: set up now (A) or defer (B). Waiting.
- 2026-11-27: owner chose B. 05.2-15 and 06.2-33 deferred (WhatsApp not provisioned). Nothing changed on prod.

## 2026-11-27 ~15:10 UTC: EVAL (fsgaeysipkukqoocgzbx) local Config UI setup
- Owner set up the local dev environment (WSL, Node 22, repo at main be569250). The Config UI connects to EVAL, in multi-tenant mode.
- EVAL write: the owner created one test auth user plus one admin_users row from the Config UI "Setup Primary Admin". The credentials are only in the owner's local .env.local.
- The walkthroughs were handed to a separate session, session_01X342skiWFj6Vkcw6omyGGS (owner's request).

## 2026-11-27 ~20:10 UTC: train 37 applied on PROD ppvywaxrycaxrtrrditl (owner approved: "同意，执行吧")
- Source: sql/train37-live.sql (09c95717). Each migration section is byte-identical to origin/main 00afa6d9 (diffed).
- Pre-check: none of the 3 access_sets CHECKs or the 2 access_sets policies existed, so the 0934 DROP ... IF EXISTS were no-ops. rag_term_list_entries existed only with 5 args. enforced=false, rag_access_audit had 0 rows.
- Applied in order (apply_migration):
  - train37_0924_access_admin, version 20261127171104
  - train37_0925_access_connectors, version 20261127200845
  - train37_0934_access_derived_stores_sets, version 20261127200928
  - train37_0980_term_translation_target, version 20261127201020
  - train37_0410_r20_delta, version 20261127201032
- Fidelity: the md5 of every stored statement equals the md5 of its section file (no deviation this time).
  - A first 0924 attempt never ran: its approval prompt was dropped when the worker restarted.
- Verify:
  - 41 rag_access_*/rag_connector_*/term functions, all with search_path="".
  - anon can execute none, except rag_access_enforced() (by design since train 36).
  - authenticated can execute only rag_access_enforced and rag_caller_reads_access_sets.
  - service_role can execute all.
  - Only the 8-arg rag_term_list_entries remains.
  - access_sets column exists on rag_answer_records, rag_retrieval_log and rag_review_items.
  - Policies: 2 RESTRICTIVE SELECT TO authenticated. CHECKs: 3 validated.
  - rag_connector_document_access: RLS on, no anon/authenticated SELECT.
  - 0 non-NULL access_sets rows. enforced=false.
- No existing row was written or rewritten.

## 2026-11-27 ~21:00 UTC: Config UI walkthrough, EVAL fsgaeysipkukqoocgzbx only (session_01X342skiWFj6Vkcw6omyGGS)
- EVAL write, item 2 (04.2-23 Identifier patterns), all done by the owner in the Config UI under the test admin's own u: tenant (Default workspace):
  - 1 insert into rag_identifier_patterns (placeholder "Test placeholder letters only", `ZZQ-[A-Z]{3}`);
  - 2 toggles (disable, enable);
  - 1 delete of that same row, with the owner present and confirming.
  - Net zero rows. Five invalid patterns were refused by the server, so nothing was written for them. The sample test writes nothing.
- No other database write. Local-only changes: OPENAI_API_KEY added to the owner's .env.local (needed by dev startup).
- Item 1 (04.1.1-13 Terminology): blocked on EVAL. rag_term_list_entries returns PGRST202 because EVAL lacks 0980 (0945 is missing too). Waiting for the owner desk to bring EVAL up to main.
- Item 3 (04.2-26): deferred until EVAL is current. Plan (orchestrator-approved): placeholder docs in the test admin's own workspace, then a dup-cluster build for that tenant only.

## 2026-11-27 ~21:50 UTC: EVAL (fsgaeysipkukqoocgzbx) catch-up to main 00afa6d9, PAUSED after train 34 (owner approved "同意，执行吧"; paused by owner to save usage)
- Before: eval was at train 29. Source: sql/train30..37-live.sql, every migration section identical to origin/main 00afa6d9.
- Applied (apply_migration, names eval_trainNN_<file>):
  - train30: 0969, 1006, r14
  - train31: 0944, 0972, 0973, 0974, 0975, 0977, 1009, r15
  - train32: 0978
  - train33: 0706, 0900, 0901, 0902, 0904, 0945, 0976, r16
  - train34: 0708, 0709, 0740, 0920, 0920.multi-tenant, r17
- Three train-31 calls were dropped by a worker restart and re-applied after checking schema_migrations; nothing ran twice.
- Remaining: train35 (0921, 0922, 0930, 0932, r18), train36, train37. After those: md5 fidelity check, verify, then tell the walkthrough desk.
- The Supabase connector is temporarily authorized to the eval org (ChenGuang's Org). Switch it back to the prod org afterwards.
- ~21:55 UTC, paused (owner usage limit). State at pause:
  - item 2 PASS (sign-out alert included);
  - item 1 still blocked: EVAL has trains 30–34 (0945 now present), not 35–37, so 0980 is still missing;
  - item 3 deferred until EVAL matches main.
  - Owner decision sent to the orchestrator: hide the sidebar footer button when unset, keeping the ability to show it later (quick task exec/quick-sidebar-hide).
  - No database writes since the entry above.

## 2026-11-27 ~22:35 UTC: EVAL (fsgaeysipkukqoocgzbx) catch-up to main 00afa6d9, DONE (owner resumed: "是，继续做")
- Applied after the pause, one call at a time:
  - train35: 0921, 0922, 0930, 0932, r18
  - train36: 0903, 0923, 0926, 0926.multi-tenant, 0931, 0950, r19 (file text, which grants rag_caller_is_access_admin)
  - train37: 0924, 0925, 0934, 0980, r20
- Fidelity: all 43 eval_train30..37 statements match the section files by md5 (raw or trailing-newline variant). 0 mismatches.
- Verify:
  - 44 access/connector/term/review functions, all with search_path="".
  - No unexpected anon/authenticated EXECUTE. service_role can execute all of them.
  - Only the 8-arg rag_term_list_entries is left.
  - access_sets present on 3 tables, with 2 RESTRICTIVE policies.
  - rag_connector_document_access: RLS on, no client SELECT.
  - rag_access_enforced()=false. The calc_* review reasons are present.
- No data rows were written or rewritten. Eval now matches main for trains 30-37.
- The Supabase connector is still authorized to the eval org. The owner switches it back to the prod org before train 38.

## 2026-11-27 ~23:20 UTC: Config UI walkthrough resumed after the EVAL catch-up (EVAL fsgaeysipkukqoocgzbx only)
- Item 1 (04.1.1-13 Terminology): PASS, except candidate dismiss, which is SKIP because no candidates exist.
- EVAL writes, all in the Workspace layer of the test admin's u: tenant (rag_term_* tables, with audit rows):
  - Manual: 1 entry created ("termalpha beta"). A conflicting entry was refused by the server, so nothing was written for it.
  - Script tools/walkthrough/walkthrough-terminology.mjs, run wtqhjf: 1 translation pair, 2 CSV-imported entries (merge).
  - Cleanup: all four entries deleted (two by the script, two by the owner by hand, with the owner's approval). Workspace layer back to 0 entries.
  - Audit/history rows for these writes remain, by design.
- Languages saved from the Config UI: RAG_SUPPORTED_LANGUAGES=zh,en,it, RAG_PRIMARY_LANGUAGE=en. This went to the owner's local .env.local. The save may also record a config-change row on EVAL. No rebuild was started ("Saving rebuilds nothing").

## 2026-11-28 ~00:10 UTC: Config UI walkthrough item 3 (04.2-26), EVAL fsgaeysipkukqoocgzbx only
- EVAL writes by tools/walkthrough/walkthrough-sources.mjs, all under the test admin's own u: tenant. 4 runs (wtngra, wtvajj, wtxsnz and the first, failed one that uploaded nothing). Each run:
  - 5 placeholder .txt uploads via the unified pipeline (documents and versions rows, chunks, rag-originals storage objects, duplicate-cluster bands);
  - one `npm run rag:dup-clusters -- --tenant u:<id>` (hashed 0, clustered 0);
  - incognito chats (not persisted);
  - every uploaded document deleted through DELETE /api/documents/<id>, all versions included (200, plus an expected 404 for the second id of the same lineage).
- Result: version tags PASS. "Also in" not verifiable in the UI: empty model reply bug, reported to the orchestrator.
- Local only: .env.local switches set by the script's setup (backup .env.local.walkthrough-backup), restored with `node walkthrough-sources.mjs restore`.

## 2026-11-28 ~08:40 UTC: EVAL (fsgaeysipkukqoocgzbx) rehearsal of trains 38-41 + NF-1 0989 + UF-1 0991 (main e6afe8a2), DONE
- Orchestrator handoff, owner approved ("可以，先在 EVAL 上演练"; EVAL steps pre-approved by the owner). Order:
  t38, t39, 0989, 0991, t40, t41.
- Applied (apply_migration, one call at a time, names eval_trainNN_<file>):
  - t38: 0930, 0930.mt, 0933, 0741, 0981, 0984, 0409 delta, 0410 r21
  - t39: 0982, 0983, 0985, 1010, 0410 r22
  - quick fixes: eval_nf1_0989_chats_shared_rls, eval_uf1_0991_block_direct_document_insert. Only the BEGIN..COMMIT apply block was applied; the probes contain ROLLBACK, so they ran separately.
  - t40: 0723, 0724, 0724.mt, 0726, 0727, 0986, 0988, 0410 r23
  - t41: 0720, 0721, 0721.mt, 0722, 0728, 0937, 0987, 0990, 1011, 0410 r23
- md5: all 33 train sections and both quick-fix apply blocks match the files byte for byte.
- Verify (each train's own verify):
  - t38: one overload each, all with access params and search_path="". No client EXECUTE. Readiness listed only rag_attribute_filter_values and rag_attribute_documents, as the file expects.
  - t39: readiness ready=true. 9 scope triggers. New tables have RLS on and 0 policies. glossary_term_lost is in the CHECK.
  - 0989: chats policies have no "shared" reference. anon sees 0 shared rows.
  - 0991: 2 guard triggers (O). No INSERT policies on documents or chunks. An authenticated insert is refused with 42501 (rolled back).
  - t40: one rag_tenant_doc_types(text,text[],boolean). Readiness ready. rag_purge_audit has RLS on.
  - t41: 6 nullable columns. 2 tables with RLS on and 0 policies. 7 triggers (O). The review policy is RESTRICTIVE and checks enforcement. Readiness ready. unowned_with_log=0.
  - Overall: rag_access_enforced()=false.
- Data writes: none, apart from guarded backfills that are no-ops while enforcement is off.
- Notes for PROD:
  - NF-1 file header says "owner desk / SQL editor"; on prod the owner chooses whether to paste it or have me apply the block.
  - Train 41 DEPLOY CAUTION: set NANGO_WEBHOOK_SECRET before deploying the train-41 app.

## 2026-11-28 08:07 UTC: PROD (ppvywaxrycaxrtrrditl) read-only rollback snapshot before trains 38-41
- Free plan: no Supabase backups or PITR. The owner chose a read-only definition snapshot instead.
- Prod state: last migration train37_0410_r20_delta; rag_access_enforced()=false.
- Snapshot contents:
  - 23 existing functions that trains 38-41 / 0989 / 0991 redefine (definition + ACL).
  - 17 policies on chats, documents, document_chunks, rag_review_items, rag_retrieval_log.
  - 42 triggers on the affected tables.
  - 3 constraints.
  - The 0720 columns are absent.
- Files: snapshots/prod-pre-train38-2026-11-28.json and snapshots/prod-pre-train38-2026-11-28-functions.sql.
- Nothing was written to prod.

## 2026-11-28 ~08:30 UTC: PROD (ppvywaxrycaxrtrrditl) train 38 APPLIED and verified (owner said "跑")
- Applied: train38_0930_access_retrieval_functions, _0930_access_retrieval_functions_multi_tenant, _0933_access_seam_legs, _0741_red_team_review_cases, _0981_tenant_doc_types, _0984_review_items_access_sets, _0409_delta, _0410_r21_delta.
- md5: 8/8 match the files (and equal the EVAL rehearsal).
- Verify:
  - One overload each, all with access parameters. search_path="" everywhere. No anon/authenticated EXECUTE.
  - rag_enqueue_review_item has only the 5-arg signature.
  - Readiness lists only rag_attribute_filter_values and rag_attribute_documents, as expected (fixed by 1010 in train 39).
  - rag_access_enforced() is false and stays callable by anon/authenticated.
- No data rows were written; the 0984 backfill is a no-op while enforcement is off.

## 2026-11-28 ~08:45 UTC: PROD (ppvywaxrycaxrtrrditl) train 39 APPLIED and verified (owner said "跑")
- Applied: train39_0982_scope_gate_tables, _0983_scope_gate_functions, _0985_translation_gap_glossary_reason, _1010_attribute_resolver_access, _0410_r22_delta.
- A worker restart dropped the first 1010 call. I checked schema_migrations, confirmed it had not run, and re-applied it once; nothing ran twice.
- md5: 5/5 match the files.
- Verify:
  - Readiness ready=true.
  - Each attribute resolver has a single access-aware signature (INVOKER).
  - 28 scope/attribute functions, all with search_path="", none callable by anon or authenticated.
  - Two new empty tables with RLS on and 0 policies. 9 scope triggers.
  - glossary_term_lost is in the CHECK. enforced=false.
- No data rows were written.

## 2026-11-28 ~09:36 UTC: PROD (ppvywaxrycaxrtrrditl) read-only storage check for queue item 30
- storage.buckets has no `chat-attachments` bucket on prod.
- storage.objects has 0 objects under `chat-attachments/extracted-images/`.
- Nothing to delete on prod. No write.

## 2026-11-28 ~09:45 UTC: PROD (ppvywaxrycaxrtrrditl) NF-1 0989 APPLIED and verified (owner said "跑", chose option A: owner desk applies)
- Applied the BEGIN..COMMIT block of .planning/quick/261127-nf1-shared-chats-rls/prod-apply.sql as nf1_0989_chats_shared_rls. md5 dd424865da75f1f4ecf8aeacbf7cd77f matches the file block.
- Before: the SELECT policy "Users can view chats" referenced shared.
- After:
  - Four own-row policies; no chats policy mentions shared; RLS is on.
  - anon sees 0 shared rows (probe rolled back).
  - Prod has 0 shared chats with a share_id, so no share link exists to open in the browser.
- No data rows were written.
