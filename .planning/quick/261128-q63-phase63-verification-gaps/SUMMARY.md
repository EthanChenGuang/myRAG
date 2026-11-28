---
quick_id: 261128-q63
slug: phase63-verification-gaps
branch: exec/quick-63-gaps
base: origin/ci/merge-train-42 @ 7c4d2ed5
source: origin/verify/06.3 @ 0c428e69 (06.3-AUDIT-REPORT.md, 06.3-VERIFICATION.md, 06.3-SECURITY.md)
status: complete
gaps_closed: [G1, G2, G3, G4, G5]
threats_addressed: [T-06.3-49, T-06.3-26, T-06.3-64 (docs part)]
requirements: [DATA-23, DATA-24, RET-14, EVAL-31]
---

# Quick 261128-q63: Phase 6.3 verification gaps G1–G5

Closes the five code and documentation gaps of the Phase 6.3 verification. Every fix began with a test that failed on an
assertion. Every switch defaults to off, and with it off the behaviour is the same as before (details below).

## Commits

| Commit | Gap | What |
|---|---|---|
| b2110a78a | — | reserve 0747 (and 0748, released later) |
| a188f6224 | G1, G4 | RED: hooks, leftovers, inventory, source_key coverage, image_upload scrub |
| d97bd3708 | G2, G5 | reserve 1012 and 1013, release 0748 (see Deviations) |
| 0215f462c | G1, G4, G5 | 0747 (+ mode files), 1012, `CONNECTOR_PROVIDERS`, G5 tests |
| 7be402101 | G2 | RED: source alerts on OBS-03, stale_index_drop rule, logged recheck counts |
| c88baa65f | G2 | contracts + gen:schemas, monitor-alerts.json, 1013, rule, retrieval-log fields |
| 2d9ff28cc | G3 | AGENTS.md Phase 6.3 section, 4.2/4.4 re-run rule, README_NANGO_INTEGRATION.md, fragment tests |
| 27dd94c08 | G2 | monitor write behind the `@/lib/rag` boundary, lazy-loaded only with RAG_MONITOR on |
| a6c26e243 | G4 | guarded 0410 grant entry for the new SECURITY DEFINER function |

## What changed

**G1 (BLOCKER, T-06.3-49): migration 0747.** The functions below are redefined from their newest bodies. No older
migration was edited.
- `rag_purge_foreign_stores` (0728 body): adds two calls, each guarded by `to_regprocedure`:
  - `rag_purge_hook_doc_attributes` (1009), counted under `counts.doc_attributes`
  - `rag_purge_hook_finetune` (0992), counted under `counts.finetune`
  - Both run before `rag_purge_lineage` deletes the documents.
- `rag_purge_foreign_leftovers` (0728 body): adds two verify rows.
  - `doc_attributes`: staged rows keyed by a (source, source_key) of the lineage's documents. After the purge it falls back to the purge record's source and key hash.
  - `finetune`: untainted versions trained on the tenant that were created before the newest purge.
- `rag_purge_store_inventory` (0728 body): new rows and their handling:
  - `rag_staged_attributes`: purge_step, store doc_attributes
  - `rag_finetune_consent`: purge_step, store finetune. A document purge keeps the row and a tenant purge deletes it, both through hook 0992.
  - `embedding_model_versions`: purge_step, store finetune (tainted)
  - `rag_section_rule_sets`, `rag_boilerplate_rules`, `rag_attribute_definitions`, `rag_attribute_header_templates`: exempt (tenant rule data, removed by `rag_tenant_rule_data_delete`)
- `purge-store-coverage.test.mts`: the catalog walk now also finds tables with a `source_key` column. It picked up `rag_staged_attributes`, which was missing before.

**G4 (T-06.3-26): 0747 and its mode files.**
- `rag_purge_lineage` (0746 body) collects the SHA-256 of each `metadata.image_url` on the versions' chunks and documents, before the scrub and before the chunk delete. Only the hashes are stored, in the new column `rag_purge_audit.image_url_sha256`, which has a hex-format CHECK.
- `rag_purge_scrub_chats` (mode files, 0724 body) drops `source_images` and `images` entries in two cases:
  - the URL is under the lineage prefix, as before;
  - the URL's hash is among the chunks' hashes or the newest purge record's hashes. This also covers a re-scrub after the purge.
- New 5-argument `rag_withdrawn_chat_messages` and 4-argument `rag_chat_messages_reference`. The 0724 signatures stay.
- `rag_purge_verify` (0746 body) adds a `source_images` row through `rag_purge_chat_image_leftovers` (mode files, tenant-bounded).
- Tests: new `tests/rag-db/purge-image-upload.test.mts`, covering the purge, a re-scrub after the purge, isolation from another tenant, and grants.

**G5: migration 1012 and `CONNECTOR_PROVIDERS`.**
- 1012 widens the four provider CHECKs of 0920/0925 to accept `sharepoint-online` and `one-drive`.
- It does the same for the three connector functions that check the provider: `rag_connector_apply_access`, `rag_connector_map_set` and `rag_connector_rule_set`. Each body is rewritten from its current `pg_get_functiondef`, so the newest body and its security attributes are kept.
- `CONNECTOR_PROVIDERS` in `src/lib/rag/access/connector.ts` lists the two new providers.

**G2 (HIGH): migration 1013, contracts and code.**
- Contract (`MonitorAlert`, `MonitorRule`):
  - new kinds `source_sync` and `stale_index_drop`
  - new rules `source_reconcile_paused`, `source_reconcile_overdue`, `source_reconcile_failed`, `source_reconcile_incomplete` and `stale_index_drop_rate`
  - `RetrievalLogEntry` gains optional `source_rechecked` and `stale_index_drop`
  - `npm run gen:schemas` was run; the defaults factory and `eval/config/monitor-alerts.json` are regenerated (config_hash recomputed, provenance still `defaults`)
- 1013 (SQL):
  - extends the 0963 rule and kind CHECKs
  - adds `rag_retrieval_log.source_rechecked` and `stale_index_drop` (both NULL, or a consistent pair with dropped ≤ checked)
  - adds `rag_monitor_stale_index_drop(p_day)`, which sums per tenant for one UTC day (INVOKER, empty search_path, service_role only)
- `raiseSourceAlert`:
  - always writes `last_reconcile_status`, as before
  - with `RAG_MONITOR=true` it lazily loads `storeSourceMonitorAlert` from `@/lib/rag` and upserts one alert through `upsertAlerts`. The tenant is resolved in SQL (`rag_nango_owner_tenant_key`), the dedup key is a hash of (tenant, rule, connection id), the alert holds counts only, and the webhook is queued when `RAG_MONITOR_WEBHOOK_URL` is set.
  - paused and failed map to severity `alert`; overdue and incomplete map to `warning`
- New daily context rule `stale_index_drop_rate`:
  - code in `src/lib/rag/monitor/stale-index-drop.ts`, registered in `RULE_KIND_REGISTRY`
  - severity: warning when the rate is above `warn=0` (any drop), alert from `alert=0.05`, `min_sample=1`
  - the retrieval-log row carries the two counts only when the recheck completed

**G3 (HIGH): documentation (06.3-24 Task 1, owner-authorised).**
- AGENTS.md section 6, new subsection "Source deletion sync and purge (Phase 6.3)":
  - switches and their defaults
  - the reconcile command and route (which refuses calls without `RAG_SIDECAR_SECRET`)
  - the scheduler options, with Vercel cron ruled out
  - deletion modes, the pause and its 24-hour confirmation
  - purge and verify, the daily cap, the tombstone rule and the recheck
  - migration order: re-run 0746 and then 0747 after re-running 0727; 0724/0728/0746 → 0747; 0920/0925 → 1012; 0963 → 1013
- AGENTS.md section 9: the SharePoint/OneDrive switch and keys.
- AGENTS.md 4.2/4.4 re-run rule (gap 4 of the 4.4 verification): always re-run 0932, then 0936, then 0938. Running 0936 alone after 0938 stops with 55000.
- `README_NANGO_INTEGRATION.md`:
  - `NANGO_WEBHOOK_SECRET` is the webhook signing key, checked against `X-Nango-Hmac-Sha256` over the raw body, and the legacy `X-Nango-Signature` is refused
  - registering SharePoint and OneDrive (`Files.Read` / `Sites.Read.All`; owner or application permission for full permission lists)
  - reconcile scheduling
  - the env reference
- `tests/rag/agents-guide.test.ts`: new Phase 6.3 fragment assertions.

## Behaviour with switches off (unchanged)

- **RAG_MONITOR off:** `raiseSourceAlert` makes the same single connection-row update and no rpc. Asserted in `tests/nango/source-alerts-monitor.test.ts`, and the monitor module is not even loaded.
- **Retrieval-log rows:** a row without a completed recheck has no new key (asserted). `defaults-equal-phase53` passes.
- **Purge (no switch):** it now also clears staged attributes, taints fine-tune versions trained on the tenant, and drops image_upload picture links from saved chats. These are the gap fixes; the canary still passes.
- **Connector admin routes:** they accept the two Microsoft provider names. No row is written unless an admin maps one, and SharePoint copies stay owner-only.

## Gates run (foreground)

| Gate | Result |
|---|---|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors (re-run after the last code change) |
| `npx vitest run` (full: contracts.generated.ts and the rag index changed) | in progress at commit time; result recorded in the follow-up commit |
| vitest targeted: tests/nango/ (29 files), monitor-stale-index-drop, monitor-rules, feedback-loop/, agents-guide, access/connector-map-routes | all pass |
| check-rag-boundary, check-config, check-language-literals, check-settings-classification, check-zod-isolation, check-migration-numbers | all 0 |
| `npm run gen:schemas` then `git status` | no diff |
| rag-db (node --test, both modes in each file): purge-foreign-stores, purge-store-coverage, purge-image-upload, access-connectors, purge-grants, purge-lineage, purge-citation-marker, search-path-empty, definer-search-path-pglite, finetune-purge-hook, phase33-purge, purge-seam, purge-library, source-deletions-purge, lexical-stats-purge-hook, purge-hook-golden-items, schema-equality, purge-cache, vector-sync-purge, vector-sync-purge-drain, purge-outbox, source-purge-cap, monitor-source-alerts, monitor-storage, retrieval-log-schema, monitor-daily, monitor-aggregate, hybrid-grants, lexical-stats-grants, search-rpc-grants-pglite | all pass (skips: 2 + 3, single-tenant / 0740-present cases as before) |
| rag-e2e: deletion-canary, defaults-equal-phase53 | 23/23 pass |
| pytest rag-sidecar (full, shared contract modules changed) | 2955 passed, 12 skipped |
| pytest eval: test_config_files, test_phase_compare | 148 passed |
| `npm run test-rag` | not run: no retrieval, ingest, generation or golden-set code path changed (purge SQL, alert wiring, docs only) |

Two failures were expected along the way:
- schema-equality "has teeth" failed while 1013 was still a `SELECT 1` placeholder; it passes with the real body.
- The 0410 upgrade-lock test asked for a guarded 0410 entry for the new SECURITY DEFINER function, which was added.

## Deviations

1. **Migration numbers: 0747 + 1012 + 1013 instead of 0747 + 0748.** G5's tables and functions are created by 0920/0925, and G2's `rag_monitor_alerts` by 0963. Both sort after 07xx, so on a fresh apply in number order a 0747/0748 change would run before those objects exist. In fact the first G5 run inside 0747 was a silent no-op. I took the next numbers free on every origin branch outside the reserved 08xx/09xx blocks (1012, 1013), pushed placeholders at once and released 0748. 0747 holds G1 and G4.
2. **0410 edited (append only):** one guarded REVOKE/GRANT entry for `rag_purge_chat_image_leftovers`, following the standing rule for new privileged functions. No other older migration was touched.
3. **G2 stale-drop data:** the daily rule needed persisted counts, so 1013 adds two nullable retrieval-log columns, and the contract and writer were extended. There is no change to `rag_monitor_daily` or `rag_monitor_aggregate`.
4. **`raiseSourceAlert`** reads `RAG_MONITOR` from `@/lib/env` (same 'true' parsing as `monitorSettings`) and imports `@/lib/rag` only when the switch is on. This is because the nango tests partially mock `@/lib/rag`. The return type widens to `'connection_status' | 'monitor_alert'`; no caller reads the value.
5. **Test helper:** `tests/helpers/nango-memory-admin.ts` gains the `neq` filter its header already listed.

## Live SQL for train 43 (apply after backup, in this order, each file is idempotent)

```text
-- after 0720–0729 and 0746 (Phase 6.3) are live:
supabase/migrations/0747_purge_gap_closure.sql
supabase/migrations/0747_purge_gap_closure.<single-tenant|multi-tenant>.sql
-- after 0920 / 0925 (Phase 4.3):
supabase/migrations/1012_connector_microsoft_providers.sql
-- after 0531 and 0963 (Phase 5.1.1, 5.3):
supabase/migrations/1013_source_monitor_alerts.sql
-- then re-run 0410 (adds the guarded grant for rag_purge_chat_image_leftovers)
supabase/migrations/0410_security_definer_rpc_grants.sql
```

Read-only checks afterwards (expect no row granted to anon/authenticated, and the new column and functions present):

```sql
SELECT p.oid::regprocedure, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('rag_purge_image_url_hashes', 'rag_purge_image_url_match', 'rag_chat_image_leftover_count',
       'rag_purge_chat_image_leftovers', 'rag_withdrawn_chat_messages', 'rag_chat_messages_reference', 'rag_purge_foreign_stores',
       'rag_purge_foreign_leftovers', 'rag_purge_lineage', 'rag_purge_verify', 'rag_monitor_stale_index_drop');
SELECT column_name FROM information_schema.columns
 WHERE (table_name, column_name) IN (('rag_purge_audit', 'image_url_sha256'), ('rag_retrieval_log', 'source_rechecked'), ('rag_retrieval_log', 'stale_index_drop'));
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('rag_monitor_alerts_rule_check', 'rag_connector_group_map_provider_check');
```

## Deferred (follow-ups, not done here)

- **G6 (owner):** retention decision for `rag_review_items` snapshots (masked query plus candidate ids of purged documents).
- **G8 hardening W2–W8:**
  - `removeOrphans` defaults to `complete ?? true`
  - SQL owner-tenant check in the 0746/0747 source_sync arm
  - `file_name` in the NULL-mode deletion logs
  - extracted images under `chat-attachments`
  - `rescrubRecentPurges` reads the oldest rows first
  - `CitationRecordSchema.quote` has no minimum length
- **Earlier SUMMARY Deferred items:**
  - the localStorage withdrawn quote (06.3-06)
  - answer text is not scrubbed (06.3-10)
  - delta-token rows of drives removed from the selection (06.3-12)
  - the Config UI "Connected" state (06.3-17)
  - the Low items listed in 06.3-VERIFICATION
- **New, Low:**
  - **Nango source_key lookup.** The `doc_attributes` verify fallback after a purge matches the purge record's `source_key_sha256`. For Nango documents that hash is of `source_file_id`, so a staged row keyed by a different `source_key` would not be counted. The purge itself deletes the staged rows by join before the documents go.
  - **Config UI labels.** The monitor panel has no labels for the new rule ids; they render as codes (the panel's documented fallback).
  - **Canary case.** The e2e deletion canary has no image_upload case. The rag-db file `purge-image-upload.test.mts` covers it.
  - **SharePoint mapping UI.** The Config UI and app provider lists (`MAPPING_PROVIDERS`, `ACCESS_GROUPS_PROVIDERS`) do not offer the Microsoft providers yet. That belongs to plan 06.3-26 with its permission mapping.
- **Live and owner items unchanged:**
  - 06.3-24 Task 2 (live push and anon probe), now also covering 0747/1012/1013
  - 06.3-25 and 06.3-26
  - sign-offs AR-06.3-01 and AR-06.3-02
  - decisions D-49 and D-41
