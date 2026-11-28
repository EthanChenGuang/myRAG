---
quick_id: 261127-trh
slug: term-rpc-hardening
status: complete
date: 2026-11-28
branch: exec/quick-term-rpc-hardening
base: origin/ci/merge-train-39
source: 04.1.1-VERIFICATION.md on origin/verify/04.1.1 (b0421d6d), items W-1, W-3, W-5, W-6, I-1
key-files:
  created:
    - tests/rag-db/terminology-overload-rerun.test.mts
    - tests/scripts/check-rag-boundary-terminology.test.ts
  modified:
    - src/lib/rag/terminology/admin.ts
    - src/lib/rag/terminology/preview.ts
    - src/lib/rag/terminology/miss-log.ts
    - src/lib/rag/feedback-loop/terminology-bridge.ts
    - src/app/api/rag/admin/terminology/_lib.ts
    - src/lib/rag/config.ts
    - scripts/ci/check-rag-boundary.mjs
    - eval/harness/fake-edge.mts
    - tests/rag/terminology/admin.test.ts
    - tests/rag/terminology-routes.test.ts
    - tests/rag/config.test.ts
---

# Quick 261127-trh: terminology RPC hardening (04.1.1 verification W-1, W-3, W-5, W-6, I-1)

This fixes only the five listed findings. It adds no migration and changes no SQL.

## Signatures checked first

- 0472 (and both setup files): `rag_term_list_entries(p_actor uuid, p_layer_key text, p_limit integer, p_offset integer, p_search text)`.
- 0980: drops that signature and creates `rag_term_list_entries(p_actor, p_layer_key, p_limit DEFAULT 50, p_offset DEFAULT 0, p_search DEFAULT NULL, p_kind text DEFAULT NULL, p_source_language text DEFAULT NULL, p_target_language text DEFAULT NULL)`.
- So a 5-named-argument call matches 0472 alone and 0980 alone. It is ambiguous (PGRST203) only when both exist, after 0472 or a setup file is re-run on top of 0980. An 8-argument call needs 0980.

## What changed

- **W-1.** `listEntriesPage` in `admin.ts` is now the single helper for `rag_term_list_entries`. It is used by `listEntries`, `loadLayer`, `getVersions` and the preview's per-layer check.
  - With no Glossary filter it sends the 5 arguments of 0472.
  - When any filter is non-empty it sends all 8. A filter only exists on 0980, and leaving the other filters out would drop them silently.
  - The brief said "all three non-empty". I read it as "any of the three", because with "all three" a single filter would be lost on the 5-argument call.
- **W-5, chosen option: the client sends every argument when the call is ambiguous. No drop migration.**
  - The 5-argument call carries the 8-argument form as `resendOnAmbiguous`. On PGRST203 it is sent once more with all 8 arguments; the filters are NULL, so the result is the same.
  - Why not a migration that drops the 5-argument signature after 0980: re-running 0472 or a setup file would bring that signature back. The listed state, "0472 re-run after 0980", would still break until the drop migration was also re-run, which is the same ordering trap 0980 already has.
  - The client approach works in all three schema states (0472 only, 0980 only, both) with no deployment order.
- **W-6.**
  - PGRST202, PGRST203 (when no resend applies) and 42883 now map to a new `TerminologyAdminFailure` reason, `schema_outdated`.
  - It is logged as `[RAG Admin] terminology schema outdated { rpc, code, signature: "<rpc>(<argument names sent>)" }`, so the log names the exact signature that was looked for.
  - The routes still answer 503, now with `error: "schema_outdated"`; every other failure still answers `"Terminology is unavailable"`.
- **I-1.** `loadRagConfig` logs one `[RAG Config]` warning per process (through the existing `problem()` key set) when `RAG_TERMINOLOGY=true` and `RAG_LEXICAL_SEARCH=false`: "RAG_TERMINOLOGY=true builds no term:0 lexical list while RAG_LEXICAL_SEARCH=false". Behaviour is unchanged: the warning is added to `config.warnings`, and the switches keep their values.
- **W-3.**
  - **Rule:** the `terminology-rpc` boundary rule now also flags any quoted `rag_term_*` string literal under `src/` outside `src/lib/rag/terminology/`. That covers constants, typed and exported constants, template literals and object values.
  - **Bridge:** it is routed through the terminology module rather than listed as an exception. `recordMissRow(client, tenantKey, row)` and `MISS_RECORDER_RPC` now live in `terminology/miss-log.ts`, and the bridge calls them and re-exports the constant. The bridge's handling of missing-recorder codes is unchanged.
- **Test harness.** `eval/harness/fake-edge.mts` now picks among function overloads by argument names, as PostgREST does:
  - an overload matches when the call names all of its arguments that have no default and names none it lacks;
  - no match answers 404 PGRST202 (it used to answer 400 `FAKE_EDGE_UNSUPPORTED`);
  - several matches answer 300 PGRST203 (it used to refuse every overloaded function).
  - `useDatabase(db)` clears the signature cache after a schema change.

## Tests (written first, failing on the old code: commit 9c306cac)

- `tests/rag/terminology/admin.test.ts`:
  - 5 arguments without a filter and 8 with one;
  - the PGRST203 resend for `listEntries`, `loadLayer` and `getVersions`;
  - schema_outdated for each of the three codes, with the logged signature;
  - 42501 stays `unavailable`;
  - the route answers 503 with `schema_outdated`.
  - 9 of these failed before the fix.
- `tests/rag-db/terminology-overload-rerun.test.mts`, single-tenant and multi-tenant, with real 0472, 0980 and the authorize SQL. States in order:
  1. 0980 only;
  2. 0472 re-run after 0980 (both signatures, checked with `to_regprocedure`);
  3. the 8-argument signature dropped, i.e. a schema without 0980 (a Glossary filter answers `schema_outdated`);
  4. 0980 re-run.
  - In every state `loadLayer`, `listEntries` and `getVersions` succeed. 4 of 8 failed before the fix.
- `tests/rag/config.test.ts`: the I-1 warning is logged once across three loads, and there is no warning with lexical search on or terminology off. Failed before the fix.
- `tests/scripts/check-rag-boundary-terminology.test.ts`: a constant passed to `.rpc(RECORDER)` is caught, as are exported, typed and template constants; the terminology module and comments are exempt; the repository passes. 2 failed before the fix.
- Changed expectation: `tests/rag/terminology-routes.test.ts` asserted that the unfiltered list sends 8 arguments with NULL filters. It now asserts the 5 argument names (an intended W-1 change).

## Gates run

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no errors |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 2652 files |
| `node scripts/check-config.mjs` | ok, 274 variables |
| `check-language-literals`, `check-settings-classification`, `check-zod-isolation` | ok |
| vitest: the 128 test files that mention terminology or import the changed modules (`rag/config`, `check-rag-boundary`, bridge, miss-log, admin, preview, admin routes) | 2224 passed, 12 skipped, 0 failed |
| rag-db: all 13 `terminology-*` files plus `*grants*` and `*search-path*` (`definer-search-path-pglite`, `hybrid-grants`, `lexical-stats-grants`, `search-path-empty`, `search-rpc-grants-pglite`), both modes where the file covers them | 217/217 pass |
| rag-db: full suite, because the fake edge is shared | see note |

**Note on the full rag-db suite.** The first run (`--test-concurrency=4`) hit my 50-minute cap after 206 top-level suites had passed. Its only failures were `ingest-identity-async` and `ingest-mode-routing`: the rag-sidecar venv was missing (uv tried to create it offline), an environment cause. After `uv sync --locked --extra chunking --extra preflight` in `rag-sidecar/`, both pass alone (18/18). A per-file rerun of all 284 files was still running at hand-off: 92 files done, every one exit 0.

## Deviations

- W-1: filters are sent when **any** of the three is set, not only when all three are (reason above).
- W-5: client-side resend rather than a drop migration, so no migration number was reserved.
- The fake edge's 400 `FAKE_EDGE_UNSUPPORTED` for unknown RPC argument names is now 404 PGRST202, as PostgREST answers. No test referenced the old message.

## Operator actions

- None are required by this change. The reverification's advice still stands: apply 0980 on the eval project so the Glossary filters work there. Without it, a filtered list now answers 503 `schema_outdated` instead of a generic 503, and the unfiltered panel list works.
