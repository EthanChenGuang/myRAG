---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 31
subsystem: ingestion
tags: [postgres, pglite, chunking, parent-child, dual-write, tenant-isolation]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: 04-07 document_parents, chunking_profiles, variant invariant; 04-03 chunkLexicalText; 04-19 RAG_PIPELINE=v2 switch; 04-44 active chunking profiles
provides:
  - rag_write_profile_chunks and chunking_build_runs / chunking_build_gaps (0408)
  - chunkParentChild (structure, fixed and none parent modes)
  - buildProfileChunks / writeProfileChunks (src/lib/rag/ingest/profile-chunks.ts)
  - ingestion dual-write of building, ready and active chunking profiles under RAG_PIPELINE=v2
affects: [04-32, 04-33, 04-34, 04-42]

status: complete
actuals:
  tokens: 90000
  tasks: 3
  commits: 6
  plan_head_before: ba1057d
  plan_head_after: 65e475731d1ae4e7b7078e186d33ff678213a4a5

key-files:
  created:
    - supabase/migrations/0408_profile_chunk_writer.sql
    - src/lib/rag/ingest/chunkers/parent-child.ts
    - src/lib/rag/ingest/profile-chunks.ts
    - tests/rag-db/profile-chunk-writer.test.mts
    - tests/rag/ingest/parent-child-chunker.test.ts
    - tests/rag/ingest/profile-dual-write.test.ts
  modified:
    - supabase/migrations/0410_security_definer_rpc_grants.sql
    - src/lib/rag/ingest/stages/embed-write.ts
    - src/lib/rag/ingest/writer.ts
    - scripts/ci/check-rag-boundary.mjs
    - tests/helpers/ingest-fakes.ts

key-decisions:
  - "0408 kept (0408 was free on trunk; 0409 and 0410 exist). The writer is guarded and service_role only, and is also listed in 0410's service-role section so the upgrade re-lock covers it."
  - "rag_write_profile_chunks has two trailing defaulted parameters (p_final, p_total) so a six-argument call is one complete atomic write and a caller may still split a very large profile across calls."
  - "rag_write_chunks is replaced in 0408 with one changed predicate: its final cleanup now deletes only chunking_profile_id = 'legacy' rows. Without it a legacy rewrite removed profile children (found by a failing test)."
  - "Dual-write reads RAG_PIPELINE once per embed stage run; under legacy there is no registry read, no profile write and no extra embedding call."
  - "A registry read failure or a profile write failure under v2 fails the run (chunking_profiles_unavailable, profile_write_failed); a failing non-active embedding target leaves a gap like the legacy chunks."

requirements-completed: [CHK-03, CHK-04]
---

# Phase 4 Plan 31: Parent-child chunker, profile chunk writer, dual-write Summary

Ingestion can now store the parents and children of any non-legacy chunking profile: one tenant-checked, idempotent SQL writer, a table-safe parent-child chunker driven by the processing profile's chunker kind, and a v2-only dual-write in the embed stage that keeps new uploads complete in every built profile.

## What was built

1. **0408 (Task 1).** `rag_write_profile_chunks(p_document_id, p_tenant_key, p_profile_id, p_parents, p_children, p_embeddings, p_final DEFAULT true, p_total DEFAULT NULL)`, SECURITY DEFINER, one transaction. Ids are sha256(document : profile : parent|child : index), so rewrites hit the same rows and never collide with legacy ids. Tenant key, organization, version, currency, doc type, language and source come from the document row. The legacy-storage embedding profile fills `document_chunks.embedding`, halfvec profiles upsert `chunk_embeddings`; a child whose text changed drops its old vectors; the final call removes children from `p_total` on and parents no child points to. `chunking_build_runs` and `chunking_build_gaps` are server-only (RLS on, no policies, no anon or authenticated privileges). The legacy profile id, an unknown or retired profile, and a profile of another doc type are refused.
2. **Chunker (Task 2).** `chunkParentChild(markdown, { childTokens, parentMode, parentTokens }, chunker)`. Structure mode runs the processing profile's chunker kind with the parent cap (clauses over the cap split at item boundaries and repeat the heading); fixed mode packs windows that end at sentence boundaries inside a heading section; `none` gives children only. Children are cut with the Phase 3 table rules at `childTokens` (embedding-text tokens), never split a table row, repeat the header row, and inherit the parent's section_path.
3. **Dual-write (Task 3).** `buildProfileChunks` is pure; `writeProfileChunks` goes through the ingest writer (`IngestWriter.writeProfileChunks` and `listChunkingProfiles`). The embed stage calls it after the legacy writes and before publish for every building, ready or active non-legacy profile of the document's type, embedding for the same targets (`resolveEmbeddingTargets`), only when `loadRagConfig(getRagDeps().ragEnv()).pipeline === 'v2'`.

## Verification

- `node --import tsx --test tests/rag-db/profile-chunk-writer.test.mts`: 18/18 (single-tenant and multi-tenant), failed 16 of 18 before the migration.
- `npx vitest run tests/rag/ingest` (and `tests/rag/embeddings`): all pass, including the named case `RAG_PIPELINE=legacy skips dual-write`.
- `npx vitest run tests/rag/search-rpc-grants.test.ts`, `node --import tsx --test tests/rag-db/search-rpc-grants-pglite.test.mts`, `node scripts/ci/check-rag-boundary.mjs`, `npx tsc --noEmit -p tsconfig.json`: green (tails in the return message).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] rag_write_chunks removed profile children**
- **Found during:** Task 1 (test "rag_write_chunks of the legacy writer does not delete or touch profile children")
- **Issue:** the legacy writer's final cleanup `chunk_index >= p_total` ignores `chunking_profile_id`, so any legacy rewrite deleted profile children of the same document.
- **Fix:** 0408 re-creates rag_write_chunks (body of 0313) with `AND c.chunking_profile_id = 'legacy'` on that DELETE and re-issues its REVOKE/GRANT.
- **Files modified:** supabase/migrations/0408_profile_chunk_writer.sql
- **Commit:** a304d43

**2. [Rule 2 - Missing critical] Boundary check did not know the new writer RPC**
- **Fix:** added `rag_write_profile_chunks` to `WRITER_RPCS` in scripts/ci/check-rag-boundary.mjs so a call outside src/lib/rag/ingest/ fails CI.
- **Commit:** 65e4757

### Plan-level adjustments

- **Setup files not folded.** The folded setup files hold Phase 3 only (no document_parents, chunking_profiles or lexical columns yet); folding 0408 alone would reference missing tables. Phase 4 folding is plan 04-42, which must include 0408 and the rag_write_chunks replacement.
- **Extra writer parameters** `p_final`, `p_total` (defaulted) and extra IngestWriter methods; `src/lib/rag/ingest/writer.ts`, `scripts/ci/check-rag-boundary.mjs`, `tests/helpers/ingest-fakes.ts` and `0410` were edited although the plan's file list omits them.
- **chunkParentChild takes a ChunkerConfig**, not a bare kind: legal_clauses needs the profile's clause patterns and lead-in phrases.
- **Fixed-mode parents stay inside a heading section** (sentence-aligned windows that never cross a heading, so section_path stays exact) and repeat a table header when a window starts inside a table.
- **document_parents.is_current is written true** and not flipped when a version is superseded (publish touches document_chunks only). Parents are reachable only through current children and rag_fetch_parents is tenant-scoped, so this is not a leak; see deferred items.

## Auth gates

None.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register: T-04-56 (writer compares the document's tenant_key with p_tenant_key, tested in both modes with a foreign key and a second tenant) and T-04-57 (children are variant after publish; `match_chunks_by_profile` returns none; hybrid search returns them only for a named or active profile) are mitigated and tested.

## Deferred items

- Image-caption chunks (`chunk_kind = 'image'`, `source_images`) are not copied into profile children; a profile with parents has only text and table children, so activating one would drop image chunks from retrieval for documents that have them unless 04-32/04-33 decide how to carry them.
- A very large profile is written in one call per profile (atomic, as the plan states). The SQL accepts `p_final`/`p_total` batching if payload size or statement time becomes a problem.
- `document_parents.is_current` is not synchronised on publish of a newer version.
- Plan 04-33 names its own migration 0409, which now exists on trunk (search RPC revoke); it needs a free number.
- Pre-existing failures, identical with 0408 removed: `tests/rag-db/schema-equality.test.mts` (rag_relex_candidates RPC failure), `tests/rag-db/parents-schema.test.mts` ("adds parent columns without rewriting document_chunks": column chunking_profile_id does not exist), `tests/rag-db/ingest-writer.test.mts` #18 (lists `rag_ingest_realtime_topic_allowed` as not service-role-only), `tests/rag-db/ingest-mode-multi-tenant.test.mts` #1, `tests/rag-db/v2-tracer.test.mts` exact_term item.

## Self-Check: PASSED

Files created exist (0408, parent-child.ts, profile-chunks.ts and the three test files) and the six task commits are on exec/04-31.
