# Phase 7: External Backends & Release Defaults - Context

**Gathered:** 2026-11-24
**Status:** Ready for planning
**Mode:** `--auto`. Every gray area was resolved with the recommended option, per the user's standing instruction "all questions follow your recommendations".

<domain>
## Phase Boundary

This phase has two halves.

**1. External backends (RET-05 to RET-09).** Weaviate and Qdrant become selectable retrieval backends behind the Phase 4 `RetrievalBackend` contract:
- Supabase stays the only source of truth. A trigger-fed outbox and a drain worker sync every change: insert, update, delete including cascade deletes, version replace, quarantine and release, and re-embed. A reconcile job detects and repairs drift.
- Tenant isolation is enforced in four layers:
  - a Weaviate tenant per workspace;
  - Qdrant with a shared collection per embedding profile, an `is_tenant` index, and a tenant filter injected on every query and every prefetch;
  - re-validation of every returned chunk ID against Supabase under the caller's scope;
  - a cross-tenant canary suite that blocks release.
- An index-ready state per backend, profile and tenant falls back to pgvector and reports `degraded`.
- The Phase 4 conformance suite, including the Chinese exact-term case, passes unchanged on both backends.

**2. Release closeout (ADM-01 to ADM-04, EVAL-17):**
- every provider and switch in the Config UI, with masked secrets, Test-connection and the index-compatibility warning;
- a full regression that sets the shipped defaults and records the decision with its numbers;
- docs and `.env` templates;
- a vendor data-flow inventory;
- the Config UI review-queue workflow that promotes production failures into the private golden set, plus a periodic failure report.

Requirements in scope: RET-05, RET-06, RET-07, RET-08, RET-09, ADM-01, ADM-02, ADM-03, ADM-04 and EVAL-17. Also verified here: the "every backend" clauses of RET-01 to RET-03, and RET-10 for Qdrant and Weaviate.

Out of scope:
- New retrieval algorithms. Fusion, the tokenizer, rerank and refusal are Phase 4, and this phase must not change them per backend.
- Query transforms and the cache (Phase 6), citations (Phase 5) and injection defense (Phase 5.1).
- Removing legacy code paths after the defaults flip. That is deferred to the next milestone.

Dependencies:
- The backend and sync work needs only Phases 3 and 4. It consumes the Phase 3 tables and soft delete, the Phase 3.1 soft-delete seam, and Phase 4's contract and conformance suite.
- The regression and closeout need Phases 5, 5.1 and 6, because their switches are part of the defaults decision.

</domain>

<decisions>
## Implementation Decisions

### Outbox and triggers (RET-05)
- **D-01:** A notification-only outbox, `vector_sync_outbox`, holds `id`, `target` (`weaviate | qdrant`), `entity` (`chunk | document | profile | tenant`), `entity_id`, `tenant_key`, `profile_id`, `enqueued_at`, `attempts`, `status` (`pending | leased | done | dead`), `lease_until`, `last_error`. It carries no content payload: the worker always reads the current row, so out-of-order or duplicate events cannot write stale data.
  - Triggers enqueue on:
    - `document_chunks` INSERT, UPDATE of any synced column and DELETE (including FK cascade);
    - `documents` UPDATE of the tenant columns, `is_current` or `status` (soft delete, quarantine, release, version publish);
    - `chunk_embeddings` INSERT, UPDATE and DELETE;
    - activation and rollback of embedding and chunking profiles.
  - Triggers write rows only for targets listed in the new table `rag_vector_sync_targets` (an enabled flag per backend). With no target enabled (the default), every trigger is a no-op, so default installs see no write amplification.
  - The migrations follow Phase 3 D-05: ordered, idempotent files in `supabase/migrations/`, mirrored into both setup files, covered by the schema-equality test and loaded by PGlite. RLS allows server-role access only.
  - **Reversibility:** one-way. These are new tables, triggers and functions on real Supabase projects, and undoing them needs a migration.
- **D-02:** Only servable rows are synced. The worker upserts a chunk only when the chunk and its document are `is_current AND status = 'ready'` and a vector exists for the target's profile. In every other case it deletes the point or object. So quarantined, superseded, soft-deleted and failed rows never exist in an external store, and a release from quarantine (Phase 3 D-31) syncs back through the same path.
  - Bulk operations use delete-by-filter on `tenant_key` plus `document_id` (Qdrant) or the tenant plus a `document_id` filter (Weaviate): document replace, tenant removal, and organization or user deletion.
  - Point and object IDs are the chunk UUIDs (deterministic and idempotent).
- **D-03:** External payloads hold only:
  - the vector of the target profile;
  - `lexical_text` (the Phase 3 and 4 shared tokenizer output);
  - the filter fields `tenant_key`, `document_id`, `doc_type`, `doc_date`, `language`, `source`, `chunking_profile_id`, `parent_id`;
  - `content_hash` and `lexical_version`.

  The raw chunk text and document names are not stored externally. Content and metadata are read from Supabase during re-validation (D-10), which also hydrates the hit payload that Phase 4 D-01 requires. This keeps vendor data to the minimum (Pitfall 21) and makes Supabase the only place an answer's text can come from.

### Drain worker and reconcile
- **D-04:** The drain worker is a TypeScript module, `src/lib/rag/sync/`, exposed as `POST /api/internal/vector-sync/drain`. It runs time-sliced inside the 60 s function cap: a 45 s working budget, batches of 100, claim through an RPC with `FOR UPDATE SKIP LOCKED`, a 120 s lease, and coalescing by entity.
  - Retries back off exponentially up to 8 attempts, then the row is `dead`.
  - Auth: `Authorization: Bearer <RAG_VECTOR_SYNC_SECRET>`. The secret must be at least 32 characters and is compared in constant time. When it is unset the route answers 503, and it fails closed.
  - The worker is triggered in three ways:
    - (a) a kick after ingest publish, soft delete and profile activation, sent through `after()` so the request never waits;
    - (b) a scheduler: Vercel Cron when the plan allows minutely runs, otherwise Supabase `pg_cron` plus `pg_net` calling the route. Both are documented, and the live choice is a human item;
    - (c) `npm run rag:vector-sync` for local runs and large backfills, which loops the same drain function without the time slice.
  - The pgvector path is never written by the worker, so the default retrieval path never waits on sync.
  - The sync is TypeScript, not the Python sidecar, because both vendor clients are TypeScript (STACK §4, "Sync model").
- **D-05:** Reconcile is `npm run rag:reconcile`, also callable from the drain route with `mode=reconcile`, time-sliced.
  - Per `(target, profile, tenant)`, it compares the count, an ID-set checksum (bucketed hashes of the chunk IDs, so a mismatch narrows to buckets) and the maximum `content_hash` digest between Supabase's servable rows and the store.
  - It enqueues repairs for missing, extra and stale entries.
  - It runs after bulk operations (backfill, re-embed, activation) and daily.
  - A test injects drift (a deleted point, a stale payload, an extra foreign point) and asserts detection and repair.
- **D-06:** Collections and profiles:
  - Both backends use one collection per embedding profile: `myrag_chunks_<profile_id>`.
  - On Weaviate the collection has multi-tenancy enabled, `autoTenantCreation: false`, `vectorizer: none` and one vector.
  - On Qdrant it is a shared collection with a `tenant_key` keyword payload index marked `is_tenant: true`. That index and the doc-type, date, language, source and document indexes are created before any data is loaded (RET-10).
  - HNSW parameters match pgvector (`m = 64`, `ef_construction = 200`) and quantization is off, so the backend comparison measures backends and not configuration (Pitfall 20). The parameters go into the run config snapshot.
  - A new embedding profile gets a new collection, filled from `chunk_embeddings` dual-write rows (Phase 3 D-39) through the outbox.
  - The Phase 3 D-40 activation gate gains one condition: a target with an enabled external backend must be index-ready for that profile on every tenant, or activation is refused and the refusal names the backend.
  - **Reversibility:** costly. Re-creating collections means a full re-sync per backend.

### Tenant isolation (RET-06 to RET-08)
- **D-07:** Weaviate uses one tenant per workspace. The tenant name is derived only from `scope.tenantKey` (`s:default`, `u:<uuid>`, `o:<uuid>`), mapped to `s_default`, `u_<uuid>` and `o_<uuid>`.
  - The adapter is the only caller of `collection.withTenant(...)`, and it has no code path without a tenant.
  - Tenants are created by the worker on first upsert.
  - A query for a tenant that does not exist is "not ready" (D-11), never an untenanted query.
  - Single-tenant mode uses the single tenant `s_default`.
- **D-08:** Qdrant access goes through one wrapper, `qdrantScopedRequest(scope, body)`. It injects `must: [{ key: 'tenant_key', match: { value } }]` into the top-level filter and into every `prefetch` entry. Before sending, it asserts that every filter in the final request carries that clause, and it throws otherwise.
  - There are no raw client calls outside the wrapper. A unit test feeds every request builder through the assertion.
  - BM25 or IDF scoping per tenant is used where the server supports it (the researcher verifies the 1.19+ `idf` corpus filter). Without it, the cross-tenant statistics blend is documented as an accepted scoring-only effect: it reveals no content.
- **D-09:** Credentials and code boundaries:
  - Separate keys for reading and writing where the vendor supports it: `QDRANT_API_KEY` (worker, write) and `QDRANT_READ_API_KEY` (retrieval, read-only); `WEAVIATE_API_KEY` and `WEAVIATE_READ_API_KEY` (RBAC roles). The researcher verifies support on the chosen hosting tiers.
  - The Phase 2 D-14 boundary check is extended: `weaviate-client` and `@qdrant/js-client-rest` may be imported only in `src/lib/rag/backend/weaviate/`, `src/lib/rag/backend/qdrant/` and `src/lib/rag/sync/`.
  - Client versions are pinned. Node 22 is already enforced (PIPE-10).
- **D-10:** Re-validation (RET-07) runs on every external result before use. A new server-only RPC, `rag_validate_chunks(p_tenant_key, p_ids uuid[], p_profile_id)`, returns the content and metadata for exactly the IDs that are:
  - current;
  - ready;
  - in the tenant (the same `tenant_key` predicate and malformed-key exception as Phase 4 `hybrid_search_chunks`);
  - holding a vector in the profile.

  It is `SECURITY INVOKER`, revoked from `PUBLIC`, `anon` and `authenticated`, granted to `service_role`, and called through the admin client with tenant arguments taken only from `TenantScope`.
  - Dropped IDs are counted as `tenant_validation_dropped` in the span. Any non-zero count is logged as `[RAG Security]` at error level, without content, so it can alert.
  - Membership revocation needs no re-sync: a removed member cannot mint the organization scope (Phase 2 D-08), and stale points fail re-validation.
  - Re-validation has no switch (the Phase 2 D-11 rule).
  - **Reversibility:** one-way. This is a published SQL function and grant.
- **D-11:** Index-ready state and fallback (RET-09) live in a table, `rag_backend_index_state`: `target`, `profile_id`, `tenant_key`, `state` (`building | ready | stale | failed`), `last_reconciled_at`, `lag_seconds`, `supabase_count`, `backend_count`, `last_error`.
  - A tenant is `ready` when its last reconcile matched and the outbox lag is at most `RAG_VECTOR_SYNC_MAX_LAG_SECONDS` (default 300).
  - `isReady(scope)` reads the state with a 30 s in-process TTL.
  - Not ready means the request uses pgvector, with `degraded` and reason `backend_not_ready`.
  - A timeout or error from the external search means pgvector in the same request, with `degraded` and reason `backend_error`. External search timeouts are 800 ms for chat and embed, none for eval.
  - Voice is controlled separately: `RAG_RETRIEVAL_BACKEND_VOICE` (default `pgvector`), so a fallback round trip never lands on the voice latency budget unless an operator opts in.
  - External backends run only under `RAG_PIPELINE=v2`. Under `legacy` the backend setting is ignored, logged once, and warned about in the Config UI.
- **D-12:** The canary suite (RET-08) is `tests/rag/canary/`, parametrized by the same backend factory as the Phase 4 conformance suite. It runs on pgvector, Weaviate and Qdrant.
  - Seeded data goes through the real ingest write path, the outbox and the drain, never by writing directly to a store, so the sync is tested end to end.
  - Cases:
    - personal versus organization;
    - null organization;
    - single-tenant `s:default`;
    - a removed member;
    - after delete (including cascade);
    - after version replace;
    - after re-embed and profile activation;
    - after quarantine;
    - a foreign point injected directly into the store, which re-validation must drop;
    - the Phase 6 semantic cache, when CACHE-01 has landed.
  - CI job `backend-canary` runs pinned Weaviate and Qdrant service containers and Postgres with pgvector (or PGlite for pgvector).
  - It is a release gate: required on main and on PRs touching `src/lib/rag/**`, `supabase/**` or the sync module. Branch protection is a human action.
  - The Phase 4 conformance suite runs in the same job on all three backends, unchanged.

### Lexical parity on external backends (RET-01 to RET-03)
- **D-13:** Both backends index the shared tokenizer output, never their own language analysis. This keeps the Chinese exact-term case identical across backends (Pitfall 8).
  - **Weaviate:** property `lexical_text` with `whitespace` tokenization, and BM25 over it. The query tokens come from the same `tokenize()`. Weaviate's `gse` and `gse_ch` tokenizers are not used, which also removes the question of whether Weaviate Cloud exposes them.
  - **Qdrant:** a sparse vector named `lexical`, built in TypeScript from the token counts with a deterministic token-to-index hash and `modifier: idf`. Its alternative is the 1.20 full-text index with BM25 and a whitespace tokenizer. The researcher confirms which one reproduces the conformance results, and the default is the sparse vector.
  - Each backend returns two legs, dense and lexical, as separate ranked lists. Weaviate runs `nearVector` and `bm25` queries in parallel; Qdrant runs one `query_batch` with two queries. Fusion stays in TypeScript RRF (Phase 4 D-02).
  - DATA-08 filters are native pre-filters. Weaviate needs `indexNullState` and `indexRangeFilters` for null organization and date ranges, set at collection creation.
  - RET-10: Weaviate keeps ACORN with `flatSearchCutoff`; Qdrant uses its payload indexes plus ACORN for combined strict filters. The `selective_filter` case of the conformance suite must equal an exact search on both.

### Config UI (ADM-01)
- **D-14:** Config UI coverage is generated from the manifest. `scripts/rag/env-manifest.json` gains per-variable metadata for managed variables: `group` (the layer), `label`, `type` (`bool | enum | number | string | secret | url`), `options` and `requires`. A new "RAG pipeline" section of the Config UI renders every managed variable from it.
  - `check-config` fails when a managed variable lacks metadata, so every switch added by Phases 1 to 7 appears without hand-written HTML.
  - Existing hand-built panels stay: document types, quarantine, embedding profiles, chunking profiles, ingestion, prompt-injection defense.
  - **Masked secrets:** `config-server.js` never sends a secret value to the browser. It sends `set` or `unset` and the last 4 characters. A PUT changes a secret only when a new value is typed, and the value is never echoed or logged.
- **D-15:** Test-connection is one admin route, `POST /api/rag/admin/providers/test` with body `{ provider }`. It follows the Phase 3 D-45 pattern: `admin_users`, forwarding through `config-server.js`, fail closed. It runs a minimal authenticated call through the real adapters in `@/lib/rag`:
  - embeddings: a one-token embed;
  - rerankers: two documents;
  - Weaviate and Qdrant: `health` plus collection presence;
  - sidecar: `/ready` with auth;
  - Langfuse, Vectara, Lakera, LlamaCloud, Anthropic, DeepInfra, Exa: their cheapest authenticated call.

  It returns `{ ok, latencyMs, code, message }`. It never returns or logs a key, and it has a 10 s timeout. It tests the configuration the app process has loaded, and the panel shows when `.env.local` changed since the app loaded it.
- **D-16:** The index-compatibility warning is computed server-side, `GET /api/rag/admin/index-compat`. It warns when:
  - the selected backend is not ready for the active embedding profile (any tenant `building`, `stale` or `failed`);
  - an external collection's vector dimension differs from the active profile;
  - a backend is selected while `RAG_PIPELINE=legacy`;
  - sync is not enabled for the selected backend;
  - the outbox has dead rows.

### Regression and release defaults (ADM-02)
- **D-17:** The regression runner is `python -m rag_eval.regression`. It drives the eval endpoint with per-request overrides in two stages.
  - **Stage A**, on the dev split: embedding profile × reranker on pgvector, with every other switch at its recommended setting from Phases 4 to 6.
  - **Stage B**, on the locked test split:
    - the two best stage-A combinations on all three backends;
    - then a one-at-a-time ablation of every switch earlier phases left off by default, on the stage-B winner.

    The switches are: `RAG_PIPELINE=v2`, hybrid, refusal threshold, edge order, compression, parent-child, iterative scan, translation, query framework and transforms, citations, groundedness, `RAG_CONTEXT_TAGGING`, `RAG_INJECTION_CHECK=drop`, `RAG_INGEST_PIPELINE=unified` and `RAG_EMBEDDING_PROFILES=on`.
  - Every use of the test split is counted and recorded (Pitfall 12).
- **D-18:** The decision rule:
  - A challenger replaces the current default only when it beats it beyond the noise band on the primary metric. The primary metric is judge answer correctness when judge keys exist, and Recall@10 plus correct refusal otherwise.
  - It must also cause no gated slice (language, category, `cross_lingual`, `injection`, `selective_filter`) to regress beyond the noise band, stay within the latency budgets for chat and voice, and keep the injection attack-success rate at 0.
  - pgvector stays the default backend unless an external backend wins beyond the bootstrap CI width on the test split, with cost and operational burden recorded next to the numbers (Pitfall 20).
  - Security switches (tagging and injection check) default on when they hold every gate. Security wins ties.
  - Output: a Pydantic `DefaultsDecision` in `eval/config/release-defaults.json`, plus `eval/decisions/defaults-<date>.md` with every number, the config hashes and the test-split use count.
  - The fixture run proves the tooling and writes a record marked `provisional: fixtures`. The code defaults (`scripts/init-env.js`, `src/lib/env.ts`, `config-server.js`, the Config UI and the manifest) change only from the live run's record. A check asserts that the shipped defaults equal the latest non-provisional record. That plan is an end-of-phase checkpoint.
  - **Reversibility:** costly. Defaults change behaviour for every new install and unset variable, and reverting needs a new decision record.

### Docs and inventory (ADM-03, ADM-04)
- **D-19:** Documentation:
  - A new `README_RAG_PIPELINE.md` covers the sidecar (deploy, auth, extras), every provider and switch (generated tables from the manifest metadata), sync setup (targets, scheduler choice, reconcile, dead letters), backends, and the eval workflow (fixture and live tiers, gates, sweeps, calibration, regression, review queue).
  - `AGENTS.md` gets a short RAG pipeline section linking to it, with §2, §6, §16 and §17 updated. This is the explicit ADM-03 request, so the "docs only on request" rule is satisfied.
  - `scripts/init-env.js` is the `.env` template. It gains the group comments from the manifest metadata.
  - Placeholders only.
- **D-20:** The vendor data-flow inventory is machine-checked.
  - `config/rag/vendor-data-flow.json` (Pydantic `VendorDataFlow`) lists, per vendor and host: the content sent (query, chunk text, answer, vectors, `lexical_text`, file bytes, traces), the switch that enables it, whether it is opt-in, whether it applies in multi-tenant mode, and the retention and training terms, marked `to_verify` until the live check.
  - It covers Vectara, Cohere, Voyage, DeepInfra, OpenRouter, OpenAI, Weaviate, Qdrant, Anthropic, LlamaCloud, Langfuse, Lakera, Exa, the eval judge provider and the Prompt Guard model download host.
  - A generated `docs/vendor-data-flow.md` is linked from the README.
  - `check-config` fails when a managed variable of type `url` or `secret` belongs to a provider with no inventory entry.

### Review queue in the Config UI (EVAL-17)
- **D-21:** The panel lives in `config-server.js` (the local operator tool) and reads the private queue under `eval/golden/private/review-queue/` on the operator's machine. The queue is fed by EVAL-15 pulls and Phase 5 EVAL-16 votes and "possibly unreliable" results.
  - Each item shows the masked question, the answer, the retrieved chunk IDs with their document names and kept status, the refusal and groundedness status, and a Langfuse trace link.
  - Chunk text for selecting evidence spans comes from a new admin route, `GET /api/rag/admin/review/chunks`. It is admin-only and fails closed. It returns text only for the chunk IDs recorded in that queue item's trace, under the trace's `tenant_key`, and each access is logged with the admin ID.
  - The reviewer writes the expected answer, sets category, answerable and language, selects evidence spans (exact quotes validated against the chunk text), and promotes.
- **D-22:** Promotion has one implementation, in Python. `python -m rag_eval.review_queue promote` is extended to accept the full item (expected answer, category, answerable, spans) as a JSON file. `config-server.js` calls it with `execFile` (no shell), passing a validated temporary file inside the private directory.
  - The item is stored only in the gitignored private path, with provenance `production`, and the split comes from the frozen hash rule (`freeze_splits`).
  - Near-duplicates are detected with a deterministic character 3-gram Jaccard similarity of at least 0.85 on the normalized question, which works for zh. A near-duplicate needs an explicit confirm, recorded on the item.
  - Promoted items are never removed. There is no delete command. The eval loader fails when an ID in the split manifest is missing from the golden file, so a deleted item is caught.
  - Existing CLI exit codes stay.
- **D-23:** The failure report is `python -m rag_eval.failure_report --since <date>`, run in the nightly workflow when private data is present and skipped otherwise. It lists new failures since the last report, grouped by layer and category. The layer is derived from the trace:
  - gold evidence never retrieved: retrieval;
  - retrieved but cut before context: rerank or assembly;
  - a false refusal: refusal;
  - in context but the answer is wrong: generation;
  - flagged unreliable: groundedness;
  - attack success: injection.

  It writes Markdown to the private directory.

### Switches and config
- **D-24:** New env vars:
  - `RAG_RETRIEVAL_BACKEND=pgvector` (`pgvector | weaviate | qdrant`)
  - `RAG_RETRIEVAL_BACKEND_VOICE=pgvector`
  - `RAG_VECTOR_SYNC_SECRET=`
  - `RAG_VECTOR_SYNC_MAX_LAG_SECONDS=300`
  - `WEAVIATE_URL=`, `WEAVIATE_API_KEY=`, `WEAVIATE_READ_API_KEY=`
  - `QDRANT_URL=`, `QDRANT_API_KEY=`, `QDRANT_READ_API_KEY=`

  Secrets are placeholders. Sync targets are enabled through the `rag_vector_sync_targets` table from the Config UI or CLI, not by an env var, because triggers read them inside the database.

  The variables go in the five config locations and are marked `managed` with D-14 metadata, and `check-config` passes.
  - With the defaults (pgvector, no targets), behaviour equals Phase 6's.
  - `retrievalConfigHash` includes the backend and its index parameters.
- **D-25:** Trace and logs:
  - The `search` span gains `backend`, `fallback_reason` and `tenant_validation_dropped`.
  - The drain and reconcile runs emit one `[Vector Sync]` log line per slice (claimed, upserted, deleted, failed, dead, lag) and a Langfuse trace when enabled.
  - No chunk text is logged.
- **D-26:** Rollout order:
  1. migrations: outbox, targets, index state, triggers and validate RPC, with grants and anon refusal;
  2. sync module and drain route with fake stores;
  3. the Qdrant wrapper and adapter with the conformance suite;
  4. the Weaviate adapter with the conformance suite;
  5. re-validation and fallback;
  6. reconcile and drift tests;
  7. canary suite and CI service containers;
  8. the activation-gate extension;
  9. manifest metadata, the generated Config UI section and masked secrets;
  10. Test-connection and the index-compat route;
  11. the vendor inventory and its check;
  12. docs;
  13. review-queue panel, promote and failure report;
  14. the regression runner and the fixture defaults record;
  15. the live defaults checkpoint.

### Claude's Discretion
- Module layout inside `src/lib/rag/backend/{weaviate,qdrant}/` and `src/lib/rag/sync/`.
- The ID-set checksum bucketing, batch sizes and backoff constants, within the stated limits.
- The token-to-index hash for Qdrant sparse vectors.
- Config UI layout of the generated section, and the warning wording.
- Report formatting of the regression and failure reports.

### Decision index
- **D-01:** notification-only `vector_sync_outbox` with triggers on chunks, documents, chunk_embeddings and profile activation; enqueue only for targets enabled in `rag_vector_sync_targets` (default none = no-op); Phase 3 migrations convention (one-way)
- **D-02:** only current, ready rows with a profile vector are upserted, everything else deleted; bulk delete-by-filter; chunk UUID as point id
- **D-03:** external payload = vector, lexical_text and filter fields; no raw text or names; hydration from Supabase at re-validation
- **D-04:** TS drain route POST /api/internal/vector-sync/drain (45 s slice, batch 100, SKIP LOCKED claim, 120 s lease, 8 attempts then dead), Bearer RAG_VECTOR_SYNC_SECRET fail closed; kick via after(), Vercel Cron or pg_cron + pg_net, `rag:vector-sync` CLI
- **D-05:** `rag:reconcile` per (target, profile, tenant): count, bucketed id-set checksum, content-hash digest; repairs enqueued; daily and after bulk ops; drift-injection test
- **D-06:** one collection per embedding profile on both backends (Weaviate MT with no auto tenant creation; Qdrant is_tenant index and payload indexes before data); HNSW m=64/ef_construction=200, no quantization; activation gate requires external index-ready (costly)
- **D-07:** Weaviate tenant from scope.tenantKey (s_default/u_<uuid>/o_<uuid>), only via withTenant, missing tenant = not ready
- **D-08:** Qdrant wrapper injects the tenant filter into the top-level filter and every prefetch, asserts and throws; IDF scoping if supported, else documented
- **D-09:** read and write keys split where supported; boundary check limits client imports to the adapters and the sync module
- **D-10:** `rag_validate_chunks` server-only RPC (tenant_key predicate, current, ready, profile vector) re-validates and hydrates every external hit; dropped count in the span and an error log; no switch (one-way)
- **D-11:** rag_backend_index_state (building/ready/stale/failed, lag, counts); ready = reconcile match and lag <= 300 s; not ready or error falls back to pgvector, degraded; 800 ms external timeout; voice backend separate (default pgvector); external backends only under v2
- **D-12:** tests/rag/canary/ factory-parametrized on three backends, seeded through ingest, outbox and drain; cases listed above incl. a foreign point and the Phase 6 cache; CI backend-canary job with service containers as a release gate; conformance suite unchanged on all three
- **D-13:** shared-tokenizer lexical on both backends (Weaviate whitespace BM25 on lexical_text; Qdrant idf sparse vector, or full-text BM25 if research prefers); two legs per backend, RRF in TS; native pre-filters, indexNullState and range filters; RET-10 on both
- **D-14:** env-manifest metadata drives a generated Config UI section and a check-config completeness rule; secrets masked (set/unset and last 4), never echoed
- **D-15:** POST /api/rag/admin/providers/test through the real adapters, admin-only, 10 s, no key echo, loaded-config caveat shown
- **D-16:** GET /api/rag/admin/index-compat warnings (not ready, dimension mismatch, legacy pipeline, sync off, dead rows)
- **D-17:** `rag_eval.regression`: stage A on dev (embedding × reranker on pgvector), stage B on the locked test split (top 2 on three backends, then one-at-a-time switch ablation); test-split uses counted
- **D-18:** challenger must win beyond noise on the primary metric with no gated slice regressing, budgets held and injection ASR 0; pgvector default unless beaten beyond CI width; security wins ties; DefaultsDecision JSON plus decision record; fixtures provisional; code defaults only from the live record, checked (costly)
- **D-19:** README_RAG_PIPELINE.md, AGENTS.md section and links, init-env.js group comments
- **D-20:** config/rag/vendor-data-flow.json (Pydantic) with generated docs and a check-config rule against the providers
- **D-21:** config-server review-queue panel over the private queue; admin route returns chunk text only for the item's trace chunks, audited
- **D-22:** promote extended in Python (full item via JSON file, execFile), frozen split, 3-gram Jaccard near-duplicate confirm, never removed (loader fails on a missing manifest id)
- **D-23:** `rag_eval.failure_report` grouping new failures by layer (from the trace) and category, nightly when private data exists
- **D-24:** new env vars (backend, voice backend, sync secret, max lag, Weaviate and Qdrant URLs and keys); sync targets in a table; five locations; default = Phase 6 behaviour
- **D-25:** search span backend, fallback and validation fields; [Vector Sync] slice logs; no text
- **D-26:** rollout order

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope and requirements
- `.planning/ROADMAP.md` §"Phase 7: External Backends & Release Defaults": the goal, six success criteria and live verification. The "Execution Order" note: backend and sync need only Phases 3 and 4, and the regression and closeout need Phases 5, 5.1 and 6.
- `.planning/REQUIREMENTS.md`: RET-05 to RET-09, ADM-01 to ADM-04 and EVAL-17. Also read RET-01 to RET-03 and RET-10 (the "every backend" clauses and their mapping notes), EMB-02, EMB-05, EVAL-14 to EVAL-16, CACHE-01 (the canary includes the cache), OBS-01 and OBS-02.
- `.planning/PROJECT.md` §Constraints and §Key Decisions: pgvector kept permanently and default unless the eval decides otherwise, Supabase as the only source of truth, the tenant filter required on external stores, config sync, no secrets.
- `AGENTS.md`: the whole file. This phase updates it (ADM-03).

### Prior phase decisions
- `.planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-CONTEXT.md`:
  - D-01: the `RetrievalBackend` contract and `isReady`;
  - D-02: RRF in TS;
  - D-03: the conformance suite;
  - D-04: the tenant-key predicate and grants pattern;
  - D-06: RET-10;
  - D-07: the tokenizer;
  - D-12: retrieval params;
  - D-24: `retrievalConfigHash`;
  - D-28: switches stay off until this phase.
- `.planning/phases/03-unified-ingestion-embedding-profiles/03-CONTEXT.md`:
  - D-05: migrations;
  - D-06 to D-08: document and chunk columns, `tenant_key`, the current and ready filter;
  - D-11: version publish;
  - D-31: quarantine and release;
  - D-34 to D-40: profiles, `chunk_embeddings`, dual-write and the activation gate;
  - D-44 and D-45: env vars and the admin routes pattern.
- `.planning/phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/03.1-CONTEXT.md`: D-27 (`rag_soft_delete_document`, the RET-05 seam), D-07 (time-sliced internal routes under 60 s).
- `.planning/phases/02-unified-retrieval-pipeline-tenant-scope/02-CONTEXT.md`:
  - D-05 and D-06: status and degraded mapping;
  - D-07, D-08 and D-11: `TenantScope`, membership, no switch on tenant enforcement;
  - D-14: the boundary check;
  - D-19 to D-21: tracing and budgets;
  - D-26 and D-27: the review queue from 02-27.
- `.planning/phases/01-evaluation-harness-baseline/01-CONTEXT.md`: the noise band, gate, dev/test split and judge.
- `.planning/phases/05-verified-citations-groundedness/05-CONTEXT.md`, `.planning/phases/05.1-prompt-injection-defense/05.1-CONTEXT.md` and `.planning/phases/06-query-layer-llamaindex-langchain/06-CONTEXT.md`: the switches that enter the D-17 ablation, EVAL-16 queue inputs, the CACHE-01 canary case and the injection gate.

### Specs and research
- `.planning/specs/semantic-cache.md`: cross-tenant cache leakage is part of the canary suite.
- `.planning/research/STACK.md` §4 (Weaviate and Qdrant versions, multi-tenancy, hybrid, tokenizers, sync model), §6 (sidecar hosting).
- `.planning/research/ARCHITECTURE.md` §"Sync (Supabase → Weaviate/Qdrant)", Anti-Pattern 1 (raw org IDs) and Anti-Pattern 2 (dual-write from ingestion).
- `.planning/research/PITFALLS.md`: Pitfall 1 (cross-tenant leakage), 7 (sync drift), 8 (Chinese lexical), 12 (test-split overuse), 16 (config drift), 20 (backend comparison fairness), 21 (vendor data flow).
- `.planning/research/SUMMARY.md` §"Phase 8: External backends and sync" and §"Phase 9: Closeout and defaults" (research numbering), and "Research Flags".

### Code
- `src/lib/rag/backend/` (Phase 4 adds `types.ts` and the pgvector adapter), `src/lib/rag/tenant/` (`TenantScope`, `mintScope`), `src/lib/rag/pipeline.ts`, `src/lib/rag/trace/`.
- `supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql`, `supabase/migrations/`, `scripts/setup-database.sh`.
- `eval/src/rag_eval/review_queue.py` (`promote` today writes a `no_answer` draft placeholder and checks exact normalized duplicates), `eval/src/rag_eval/split.py`, `golden_io.py`, `langfuse_api.py`, `report.py`, `gate.py`.
- `scripts/config-server.js` (already requires `child_process`; Authorization forwarding to `/api/rag/admin/*`), `scripts/config-ui/index.html`, `scripts/rag/env-manifest.json`, `scripts/check-config.mjs`, `scripts/init-env.js`, `src/lib/env.ts`.
- `.github/workflows/pr-smoke.yml` and `nightly.yml` (there are no service containers yet), `scripts/ci/check-rag-boundary.mjs`, `vercel.json` (`maxDuration: 60`, no crons yet).
- `AGENTS.md`, `README_DEPLOYMENT_MODES.md` (single- and multi-tenant modes for the canary cases).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- The Phase 4 `RetrievalBackend` contract, the factory-parametrized conformance suite and the pgvector adapter are the template for both new adapters.
- `TenantScope`, `tenantKey` and the `tenant_key` generated column (Phase 3) give one tenant identifier for the SQL, the Weaviate tenant name and the Qdrant payload.
- The PGlite edge and the two-tenant fixture seed the canary data. Phase 3's `ingest()` and Phase 3.1's soft delete produce the outbox events.
- `review_queue.py` already has `pull`, `promote`, private-path guards, frozen split assignment and exit codes. EVAL-17 extends it rather than re-implementing it in JavaScript.
- `config-server.js` already forwards Authorization to admin routes and can run child processes.

### Established Patterns
- Server-only SQL functions take tenant arguments from `TenantScope`, are `SECURITY INVOKER`, are revoked from anon, are called through the admin client, and raise on a malformed key.
- Ordered, idempotent migrations, mirrored into both setup files and checked by the schema-equality test.
- Internal routes use a shared secret, constant-time comparison and fail closed. Time slices stay under 60 s.
- Every switch is in the five locations and `managed` in the manifest. Defaults stay off until evidence exists.

### Integration Points
- New code: `src/lib/rag/backend/weaviate/`, `src/lib/rag/backend/qdrant/`, `src/lib/rag/sync/`, `src/app/api/internal/vector-sync/drain/route.ts`, `src/app/api/rag/admin/{providers/test,index-compat,review/chunks}`.
- New and changed tables and functions: migrations (outbox, targets, index state, triggers, `rag_validate_chunks`, the claim RPC).
- Eval: `eval/src/rag_eval/{regression,failure_report}.py` and the promote extension. CI: the `backend-canary` job.
- Config UI: the generated section and the review-queue panel. Docs: `README_RAG_PIPELINE.md`, `AGENTS.md`, `config/rag/vendor-data-flow.json`.

</code_context>

<specifics>
## Specific Ideas

- Cross-tenant leakage is the worst failure, so isolation is layered and each layer is tested on its own:
  - adapter-level tenancy (D-07 and D-08);
  - Supabase re-validation (D-10);
  - only servable rows synced (D-02);
  - canaries through the real sync path, including a foreign point planted directly in the store (D-12).
- The backend comparison must measure backends. Embeddings, tokenizer, fusion, filters, candidate counts and HNSW parameters are held constant.
- The fixture regression proves the tooling. Only the live run on the real locked test split may change shipped defaults.

</specifics>

<deferred>
## Deferred Ideas

- Removing the legacy retrieval and ingestion code paths (`RAG_PIPELINE=legacy`, `RAG_INGEST_PIPELINE=legacy` and the legacy writers) after the defaults flip. That is the next milestone.
- Per-tenant opt-out of external vector stores and rerankers for tenants with data-residency limits (Pitfall 21), if a customer requires it.
- Native backend hybrid fusion (Weaviate `Ranked`, Qdrant RRF) as an optimization, only if a later eval shows it equals TS fusion.
- A Config UI editor for the injection rule set and the processing profiles. They stay data files.
- Qdrant JWT with per-tenant payload-filter claims as an extra server-side guard, if the hosting tier supports it.

</deferred>

---

*Phase: 07-external-backends-release-defaults*
*Context gathered: 2026-11-24*
