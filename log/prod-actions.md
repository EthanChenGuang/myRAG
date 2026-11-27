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
