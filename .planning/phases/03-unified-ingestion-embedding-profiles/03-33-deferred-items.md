# Deferred items (plan 03-33)

## 03-33 (Nango sync)

- `src/lib/nango/sync-manager.ts`, generic-provider multi-folder branch: the legacy pipeline updates `nango_sync_records.status` to `'synced'`, which `nango_sync_records_status_check` rejects (`pending, processing, completed, failed, disconnected`). The update never applies, so `document_id` and `last_synced_at` are not recorded and the file is re-processed on every sync. 03-33 keeps the legacy value (the plan requires legacy to behave as today) and writes `'completed'` under unified. Decision needed: fix legacy too.
- `src/lib/nango/sync-manager.ts`, `fetchGoogleDriveFiles`: one page of `NANGO_MAX_FILES_PER_SYNC` files ordered by `modifiedTime desc`, no pagination. A previously synced file that falls off the first page in a large folder looks orphaned and is deleted by the orphan pass. Pre-existing; not exercised by a test.
- Orphan delete (both pipelines) and the documents DELETE route do not remove the stored originals or artifacts of a deleted lineage from the object store.
