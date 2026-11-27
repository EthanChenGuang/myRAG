# Owner desk: continue here (paused 2026-11-27 ~12:55 UTC)

The owner desk session talks to the owner in short Simplified Chinese and handles only items that need the owner.
Orchestrator: session_01X342shLsAZx6PYph2vA7hc (new account, 2026-11-27).

## Production (Supabase ppvywaxrycaxrtrrditl, multi-tenant)
- Applied and verified (owner approved each train): train 30, 31, 32, 33, 34, 35.
  Last migration: `train35_0410_r18_delta`.
  Each section used `apply_migration` with names like `train35_0921_access_groups_columns`. The SQL was not edited.
- Verification for each train: objects exist, RLS is on, new functions are not executable by anon/authenticated.
  For t35, the md5 of the hybrid_search_chunks and rag_bm25_search_chunks bodies matches the file.
  `rag_access_group_settings.enforced = false`.
- **Train 36: APPLIED and verified 2026-11-27 ~13:39 UTC** (see log/prod-actions.md; one-line typo in the stored r19 text, no effect). Was: waits for PR #131 to merge. SQL: `sql/train36-live.sql`.
  Order: 0903, 0923, 0926 (common, then .multi-tenant), 0931, 0950, then 0410 r19.
  0923 builds 3 GIN indexes without CONCURRENTLY. The tables are tiny (~3 documents / ~35 chunks est.).
  Tell the owner about the DROP sections listed in the header and get approval before applying.
- Vercel production (project myrag prj_3cwM4FgAY5E2iqf7EBicZ9vXTecQ, team team_tHRDIP8AtALXIH4nKvMjUBwg):
  main fbb6bc3c is live. The owner swapped the prod OPENROUTER_API_KEY to a new prod-only key and redeployed (dpl_82pTJDNn…, READY).
  Not yet confirmed: an actual chat answer with the new key (Langfuse showed the last trace at 01:17 UTC).

## Owner queue status
1. Prod migrations t30–t35: DONE. t36: pending the #131 merge (see above).
2. OpenAI / DeepInfra top-up: the owner cannot pay either account. Decision: use OpenRouter.
   Executor session_01SEn5g5MUwB2Cztmd7FfJey (exec/quick-openrouter-fallback) is building the eval judge via OpenRouter and `RAG_BGE_M3_VIA=openrouter`.
   03.1-54 Task 3.1 (Batch API) is DEFERRED.
   OpenRouter account: about $43.8 left after a $20 top-up. Auto top-up is set ($5 → $10).
   The old key (dev/eval, the one in GitHub secrets and the cloud env) may get a daily cap of about $10. Peak usage was $16.5 on 2026-11-27.
3. Release gate 05.3-38/39:
   - H-1 done: classic branch protection on main requires `pr-smoke`. The API shows main protected=true.
     "Require branches to be up to date" was advised OFF; this is unverified after save.
   - H-2 done per the owner: secrets VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID (names not verifiable with my tools).
   - **H-3 and the first promote-production run are HELD** until the release gate passes without OpenAI (needs the OpenRouter executor's change merged) and OpenRouter has credit.
4. Third-party keys:
   - Langfuse is ALREADY live in prod since 2026-11-25: ENABLED=true, SAMPLE_RATE=1, EU cloud.langfuse.com, content capture off. The owner saw traces.
   - The owner is renaming the Langfuse project "My Project" → "myRAG". This is harmless.
   - Anthropic, Lakera, Vectara, Prompt Guard: recommended to skip for now. Vectara and Prompt Guard need the sidecar host.
   - Lakera and Vectara need the owner to read the vendor retention terms before the multi-tenant ACK.
5. Decisions on the owner's behalf (queue 11–14/14b/16, WhatsApp parser, 07-01 vector clients): ALL CONFIRMED by the owner (2026-11-27). The orchestrator recorded them.
6. Live checks: NOT started. Next proposed: WhatsApp reply check (05.2-15), then Config UI admin walkthroughs, screen-reader pass, sidecar host deploy, real domain test set, and 04.2-33 live traffic (handoffs/04.2-33-live-blocked.md on exec/04.2-33).

## Open question to the owner (unanswered)
The prod runtime errors (last 48h) show:
- `/api/audio` 401: there is no OPENAI_API_KEY in Vercel at all; speech needs OpenAI directly.
- `/api/ai-to-rag` title generation uses `gpt-3.5-turbo`, which is deprecated (404) — see src/app/api/ai-to-rag/route.ts:101.
The last errors were on 2026-11-25/26. The question was whether to forward these to the orchestrator (disable audio or wait for an OpenAI key; move the title model to OpenRouter).

## Rules kept
Never force-push. Never put secrets in chat or git. DROP sections need the owner present. Do not deploy (the orchestrator deploys). Log each prod action.
