---
quick_id: 261127-rbm-rebuild-mechanisms-42
type: quick
base: origin/exec/quick-42-fixes (c50e5550)
branch: exec/quick-rbm-rebuild-mechanisms
---

# Quick 261127-rbm: dedicated rebuild mechanisms for the Phase 4.2 lookup and cluster switches

Source: `261127-q42-SUMMARY.md`, W-5, hand-off `04.2-02-settings-classification.md`.

## Problem

`RAG_TABLE_LOOKUP`, `RAG_IDENTIFIER_INDEX` and `RAG_DUP_CLUSTERS` are classified `reparse`, because in the closed
`RebuildMechanism` set only a re-parse re-runs `indexDocumentForLookup` and `clusterPublishedDocument`. Changing one of them
therefore proposes a full re-parse of every document.

## Decision

Three mechanisms, one per existing backfill command, so that one switch triggers only its own backfill:

| Switch | Mechanism | Command |
| --- | --- | --- |
| `RAG_TABLE_LOOKUP` | `reindex_tables` | `npm run rag:table-rows -- --tenant <key>` |
| `RAG_IDENTIFIER_INDEX` | `reindex_identifiers` | `npm run rag:identifiers -- --tenant <key>` |
| `RAG_DUP_CLUSTERS` | `recluster` | `npm run rag:dup-clusters -- --tenant <key>` |

They run as commands (plan kind `command`, activation `none`), like relex; no rebuild run row is written, so the 0809
`rag_rebuild_runs.mechanism` check needs no migration.

## Tasks

1. RED: vitest `tests/rag/ingest/rebuild-lookup-mechanisms.test.ts`, sidecar pytest cases, checker node test.
2. GREEN: Pydantic `RebuildMechanism` + `REBUILD_MECHANISMS`, `npm run gen:schemas`, checker `MECHANISMS`, `impact.ts`
   (`REBUILD_MECHANISMS`, `MECHANISM_COMMANDS`), `rebuild/plan.ts` (`REBUILDABLE_MECHANISMS`, tenant commands, plan type),
   `rag:rebuild` usage, Config UI ingest-impact labels and order, classification JSON, affected tests.
3. Gates and SUMMARY.
