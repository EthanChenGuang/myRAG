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
