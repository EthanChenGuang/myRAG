# Phase 7: External Backends & Release Defaults - Research

**Researched:** 2026-11-24
**Domain:** External vector stores (Weaviate, Qdrant) synced from Supabase with layered tenant isolation; scheduler and CI for the sync; release regression statistics; Config UI, docs and vendor inventory closeout
**Confidence:** HIGH for vendor behaviour that was probed live on pinned servers (Qdrant 1.20.2, Weaviate 1.40.7, PGlite 0.5.17); MEDIUM for hosted-tier details (Weaviate Cloud, Qdrant Cloud, Vercel plan); LOW only where marked `[ASSUMED]`

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Outbox and triggers (RET-05)
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

#### Drain worker and reconcile
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

#### Tenant isolation (RET-06 to RET-08)
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

#### Lexical parity on external backends (RET-01 to RET-03)
- **D-13:** Both backends index the shared tokenizer output, never their own language analysis. This keeps the Chinese exact-term case identical across backends (Pitfall 8).
  - **Weaviate:** property `lexical_text` with `whitespace` tokenization, and BM25 over it. The query tokens come from the same `tokenize()`. Weaviate's `gse` and `gse_ch` tokenizers are not used, which also removes the question of whether Weaviate Cloud exposes them.
  - **Qdrant:** a sparse vector named `lexical`, built in TypeScript from the token counts with a deterministic token-to-index hash and `modifier: idf`. Its alternative is the 1.20 full-text index with BM25 and a whitespace tokenizer. The researcher confirms which one reproduces the conformance results, and the default is the sparse vector.
  - Each backend returns two legs, dense and lexical, as separate ranked lists. Weaviate runs `nearVector` and `bm25` queries in parallel; Qdrant runs one `query_batch` with two queries. Fusion stays in TypeScript RRF (Phase 4 D-02).
  - DATA-08 filters are native pre-filters. Weaviate needs `indexNullState` and `indexRangeFilters` for null organization and date ranges, set at collection creation.
  - RET-10: Weaviate keeps ACORN with `flatSearchCutoff`; Qdrant uses its payload indexes plus ACORN for combined strict filters. The `selective_filter` case of the conformance suite must equal an exact search on both.

#### Config UI (ADM-01)
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

#### Regression and release defaults (ADM-02)
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

#### Docs and inventory (ADM-03, ADM-04)
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

#### Review queue in the Config UI (EVAL-17)
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

#### Switches and config
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

### Deferred Ideas (OUT OF SCOPE)
- Removing the legacy retrieval and ingestion code paths (`RAG_PIPELINE=legacy`, `RAG_INGEST_PIPELINE=legacy` and the legacy writers) after the defaults flip. That is the next milestone.
- Per-tenant opt-out of external vector stores and rerankers for tenants with data-residency limits (Pitfall 21), if a customer requires it.
- Native backend hybrid fusion (Weaviate `Ranked`, Qdrant RRF) as an optimization, only if a later eval shows it equals TS fusion.
- A Config UI editor for the injection rule set and the processing profiles. They stay data files.
- Qdrant JWT with per-tenant payload-filter claims as an extra server-side guard, if the hosting tier supports it.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RET-05 | Supabase is the only source of truth; trigger-fed outbox and drain worker sync inserts, updates, deletes (incl. cascade) and re-embeds; reconcile detects and repairs drift | Cascade-delete triggers verified on PGlite (row and statement level); claim SQL with `FOR UPDATE SKIP LOCKED` verified; per-entity lease exclusion (Pitfall 3); delete-by-filter, exact count and scroll verified on Qdrant; deleteMany limit 10,000 per call on Weaviate; scheduler matrix (Vercel Cron/Schedules vs pg_cron + pg_net) |
| RET-06 | Weaviate tenant per workspace; Qdrant shared collection per profile with `is_tenant` index and a tenant filter on every query and prefetch | Weaviate rejects untenanted queries and unknown tenants (probe); tenant-name grammar verified; Qdrant `is_tenant` index verified; top-level filter propagation to prefetch observed; `params.idf.corpus` is a third filter location the wrapper must inject |
| RET-07 | Chunk IDs from Weaviate/Qdrant re-validated against Supabase under the caller's scope | `rag_validate_chunks` pattern (Phase 4 D-04 grants); case-canonical tenant key (Pitfall 1) |
| RET-08 | Cross-tenant canary suite on every backend in CI as a release gate | Service-container recipe (images, ports, health checks, keys), "missing backend must fail not skip" guard, foreign-point injection via write key in tests only |
| RET-09 | Index-ready state per tenant and backend; fallback to pgvector with `degraded` | Missing Weaviate tenant returns `tenant not found` (maps to not ready); client timeout knobs; latency-budget interaction (Pitfall 6) |
| RET-01..03 (every-backend clauses) | Same interface, hybrid with pre-filters + RRF, shared tokenizer with Chinese exact term on every backend | Weaviate `whitespace` tokenization + `stopwords.preset: none`; Qdrant full-text BM25 with `whitespace`, `lowercase: false` (probe: Chinese tokens match; empty query returns []); Weaviate empty BM25 query errors (Pitfall 4) |
| RET-10 (Qdrant, Weaviate) | Lossless selective filters | Weaviate `filterStrategy: acorn` default, `flatSearchCutoff` 40000; Qdrant `params.acorn`, payload indexes before data, `strict_mode_config` to forbid unindexed filters; `exact: true` for the reference search |
| ADM-01 | Every provider and switch in Config UI, masked secrets, Test-connection, index-compat warning | Existing `maskConfig` (secrets never leave server) to extend; SSRF-safe Test-connection (provider enum only); dimension metadata stored on collections |
| ADM-02 | Full regression on locked test split sets defaults with numbers | Statistical protocol: existing paired bootstrap (seed 20261123, 10000 resamples), noise band, test-split budget, multiplicity control, min-n rule for gated slices, final confirmatory run |
| ADM-03 | Docs and `.env` templates describe sidecar, providers, switches, sync, eval | Scheduler setup recipes (Vercel `CRON_SECRET`, pg_cron + Vault SQL) |
| ADM-04 | Vendor data-flow inventory | `lexical_text` is content-equivalent (tokenized text), vectors are invertible: inventory must say so |
| EVAL-17 | Review queue in Config UI, promote to private golden set, periodic failure report | `config-server.js` currently imports `exec, spawn` only; add `execFile`; split rule `sha256-first8hex-mod100-lt70-dev` already frozen |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

Directives from `./CLAUDE.md` → `AGENTS.md` and `.claude/CLAUDE.md` that bind this phase:

- **Config sync:** every new `.env.local` variable goes into `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js` and the Config UI; `check-config` must pass. Model lists keep the five-location rule.
- **Do not break shipped behaviour:** strict-mode "information not available", webSearch + Exa, `source_images`, the `{{context}}` placeholder in `RAG_SYSTEM_PROMPT`, voice and embedded chat paths.
- **Multi-tenant safety:** single- and multi-tenant both supported; RLS and tenant isolation must not weaken; **external vector stores must filter by tenant**; cross-tenant leakage is the worst failure.
- **Reversible:** every new component has a switch; off = current behaviour.
- **Prove it:** every phase compares against the baseline; any layer regressing beyond noise means not done.
- **Latency budget:** retrieval path has a total budget; voice budget is lower.
- **Secrets:** never committed; tests and docs use placeholders; never log key values (log presence/length only).
- **Python sidecar** owns Docling, HHEM, DeepEval, Ragas; the app calls it over HTTP. (Sync stays TypeScript per D-04.)
- **Pydantic v2 (`pydantic>=2.14.4`) is the single schema source**; Zod is generated from its JSON Schema and checked in CI. Applies to `DefaultsDecision`, `VendorDataFlow`, the promote item file and any drain/reconcile report contract.
- **pgvector dimensions:** above 2000 dims the `vector` HNSW index does not fit; use `halfvec` or reduce.
- **Code style:** kebab-case files; `@/*` alias; `z` from `zod/v3` in API code; structured JSON errors `NextResponse.json({ error }, { status })`; `withValidation`/`validateRequest`; bracketed log prefixes (`[Vector Sync]`, `[RAG Security]`, `[Document Search]`); no new `any`; no new `eslint-disable`; minimal comments; no log spam in hot paths.
- **Quality gate:** `npx next typegen && npx tsc --noEmit -p tsconfig.json` with zero errors; lint before hand-off.
- **GSD workflow:** edits only through GSD commands. Model roles: research and planning on Opus; execution on Sonnet; a cross-tenant leak risk justifies an extra plan review (`.claude/rules/gsd-model-roles.md`).
- **Large-file risk:** `src/app/api/chat/route.ts` (~4500 lines), `scripts/config-server.js` (~3600 lines) carry high regression risk; keep edits surgical.

## Summary

Phase 7 bolts two external stores onto the Phase 4 `RetrievalBackend` contract without moving the source of truth, then closes the milestone. The vendor behaviour that the locked decisions rely on was checked against running servers in this session (Qdrant 1.20.2 and Weaviate 1.40.7 in Docker, PGlite 0.5.17 for the trigger and claim SQL). The decisions hold, with five corrections the planner must absorb:

1. **The Weaviate TypeScript client was renamed.** Weaviate's docs now install `@weaviate/node` (3.15.5); `weaviate-client` is "the previous package name, still released for a transition period". Use `@weaviate/node` and extend the boundary check to block every name (`weaviate-client`, `@weaviate/node`, `@weaviate/core`, `@weaviate/web`). D-09 names the old package, so this needs a one-line user confirmation.
2. **Qdrant lexical leg: prefer the 1.20 full-text BM25 index over the D-13 default sparse vector.** On 1.20.2 a `whitespace` text index with `lowercase: false` and `scoring: bm25` matched Chinese and code tokens. `params.idf.corpus` scoped IDF to one tenant (scores changed 0.442 → 0.575). An empty query returned `[]`. This gives real BM25 (k1/b plus length normalisation), the same per-tenant statistics model as Weaviate (whose per-tenant shard scores also differed: 0.262 vs 0.398 for identical text), and no token hashing. `lexical_text` is already in the D-03 payload. D-13 delegates this choice to research; the conformance suite confirms it at execution (plan step 3).
3. **The Qdrant wrapper must also scope `params.idf.corpus`, and forbid `lookup_from` and `shard_key`.** These are filter or collection selectors outside `filter` and `prefetch`. A top-level filter was observed to reach prefetches on 1.20.2. That makes D-08's injection defence in depth, not the only line.
4. **Vercel Cron cannot run minutely on Hobby** (once per day, ±59 min). Vercel's newer Schedules (beta) allows every 15 minutes on Hobby and every minute on Pro. Cron invokes **GET** with `Authorization: Bearer $CRON_SECRET`, not POST with `RAG_VECTOR_SYNC_SECRET`. The drain route needs a GET handler. A minutely `crons` entry committed to `vercel.json` would **fail deployment on Hobby**, so do not commit one. Supabase `pg_cron` + `pg_net` + Vault is the plan-independent default.
5. **Tenant key case.** `mintScope` accepts UUIDs case-insensitively (`/i`), while Postgres renders `uuid::text` lowercase. Weaviate tenant names and Qdrant keyword matches are case-sensitive. An upper-case UUID returned zero Qdrant hits in the probe. This never leaks, but it silently empties results or forces fallback. Canonicalise to lowercase in one helper used by SQL arguments, Weaviate names and Qdrant filters.

The release regression is underpowered by construction. The fixture test split has 20 items (17 answerable, 3 no-answer); the real set will have roughly 15–60 test items. Use the existing paired bootstrap (`SEED = 20261123`, `RESAMPLES = 10000`). Pre-register the configuration list before Stage B, control multiplicity across the ~15 ablations, report slices under a minimum n without gating them, and end with one confirmatory run of the combined defaults.

**Primary recommendation:** Build in the D-26 order. Put every Qdrant call behind `qdrantScopedRequest` and every Weaviate call behind a `withTenant` adapter, both fed by one `canonicalTenantKey(scope)`. Re-validate every hit through `rag_validate_chunks`. Use Qdrant full-text BM25 with per-tenant `idf.corpus`. Default the scheduler to pg_cron + pg_net. Pin the images `qdrant/qdrant:v1.20.2` and `semitechnologies/weaviate:1.40.x` by digest, and pin `@weaviate/node@3.15.5` and `@qdrant/js-client-rest@1.20.0` exactly.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Change capture (outbox enqueue) | Database (Supabase triggers) | — | Must be in the same transaction as the chunk/document/embedding write; covers cascade deletes no app code sees |
| Sync drain + reconcile | API/Backend (Next.js internal route, Node runtime) | CLI (`npm run rag:vector-sync`, `rag:reconcile`) | Vendor clients are TS; time-sliced under 60 s; CLI for unbounded backfills |
| Scheduling | Database (pg_cron + pg_net) or Platform (Vercel Cron/Schedules) | App `after()` kick | Plan-dependent; pg_cron is plan-independent |
| Tenant derivation | API/Backend (`src/lib/rag/tenant/`) | — | Only `TenantScope` mints tenants; never request bodies |
| External retrieval (dense + lexical legs) | API/Backend adapters (`src/lib/rag/backend/{qdrant,weaviate}/`) | External store | Adapter injects tenancy; store executes |
| Re-validation + hydration | Database (`rag_validate_chunks`, service role) | API/Backend | Supabase is the only source of answer text |
| Fusion, rerank, refusal | API/Backend (Phase 4 TS) | — | Must be identical across backends |
| Readiness/fallback | API/Backend (`isReady` 30 s TTL) | Database (`rag_backend_index_state`) | Per-request decision; state persisted by reconcile |
| Config UI, Test-connection, index-compat | Local operator tool (`config-server.js`) → API/Backend admin routes | — | Secrets stay server-side; admin auth fail-closed |
| Regression, failure report, promote | Python eval (`eval/src/rag_eval/`) | API (eval endpoint) | Pydantic contracts; one promote implementation |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@weaviate/node` | 3.15.5 (published 2026-11-13, 11 days) | Weaviate v3 client for Node (gRPC + REST) | Official package per Weaviate docs ("npm install @weaviate/node"; `weaviate-client` = "previous package name, still released for a transition period") [CITED: docs.weaviate.io/weaviate/client-libraries/typescript]; engines `node >=22.0.0` [VERIFIED: npm registry] |
| `@qdrant/js-client-rest` | 1.20.0 (published 2026-10-22, 33 days) | Qdrant REST client | Official; matches server 1.20; deps `undici 7.29.1`, `@qdrant/openapi-typescript-fetch 1.2.6`; peer `typescript >=4.7`; engines `node >=22.0.0` [VERIFIED: npm registry] |
| Qdrant server | `qdrant/qdrant:v1.20.2` (2026-11-16) | CI service + reference self-host | Needed for text-index BM25 and `idf` corpus params [VERIFIED: live probe] |
| Weaviate server | `semitechnologies/weaviate:1.40.7` (2026-11-20) or the newest 1.40.x patch at least 7 days old at execution | CI service + reference self-host | Docs' release table pairs client 3.15.x with server 1.40.x [CITED: Weaviate TS client page]; 1.41.0 shipped 2026-11-23 and is too new |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@electric-sql/pglite` + `pglite-pgvector` | 0.5.17 / 0.0.18 (already in repo) | pgvector leg of canary and conformance; trigger and claim SQL tests | Always in CI; PostgreSQL 18.7 inside [VERIFIED: probe `select version()`] |
| Supabase `pg_cron` + `pg_net` + Vault | Supabase-managed | Minutely scheduler calling the drain route | Default scheduler (plan-independent) |
| `next/server` `after()` | Next 16 (stable since 15.1) | Post-response kick | After ingest publish, soft delete, activation [CITED: nextjs.org/docs/app/api-reference/functions/after] |
| Python `qdrant-client` 1.20.0 / `weaviate-client` 4.24.1 | PyPI | **Not used.** Regression drives the eval endpoint; sync is TS | Do not add to `eval/` or the sidecar |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@weaviate/node` | `weaviate-client@3.15.3` | Same repo, same API; transitional name, will stop. Acceptable fallback if the user rejects the rename |
| Qdrant full-text BM25 (`using: 'lexical_text'`) | Sparse vector `lexical` with `modifier: idf` (D-13 default) | Sparse = TF×IDF dot product with no BM25 saturation or length normalisation unless computed client-side, a hash with collisions, an extra stored vector, and a re-sync if the hash changes. Full-text = server BM25 with per-query `k`/`b`, per-tenant `idf.corpus`, and reuse of the `lexical_text` payload already required by D-03 |
| pg_cron + pg_net | Vercel Cron (`vercel.json` `crons`) | Hobby: daily only; minutely deploy fails. Pro: minutely, best-effort delivery, GET + `CRON_SECRET` |
| pg_cron + pg_net | Vercel Schedules (beta) | Hobby every 15 min (15-min jitter, 5,000 runs/billing period); Pro every minute. Beta limits may change |

**Installation (executor, behind a `checkpoint:human-verify`; see audit):**
```bash
npm install --save-exact @weaviate/node@3.15.5 @qdrant/js-client-rest@1.20.0
```

**Version verification (run this session):** `npm view @weaviate/node version` → 3.15.5; `npm view @qdrant/js-client-rest version` → 1.20.0; `npm view weaviate-client version` → 3.15.3. No `postinstall`, `install` or `preinstall` scripts on any of the four packages (`@weaviate/node`, `@weaviate/core`, `weaviate-client`, `@qdrant/js-client-rest`) [VERIFIED: npm registry `scripts` field].

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@weaviate/node` | npm | package 2 mo (created 2026-09-16); 3.15.5 = 11 days | ~1.0k/wk | github.com/weaviate/typescript-client | [SUS] (seam: `too-new`) | Flagged. Planner must add `checkpoint:human-verify` before install. Corroborated by Weaviate's own install docs |
| `@weaviate/core` (transitive) | npm | 2 mo; 3.15.5 = 11 days | ~1.1k/wk | github.com/weaviate/typescript-client | [SUS] (`too-new`) | Flagged, same checkpoint (installed by `@weaviate/node`) |
| `weaviate-client` (fallback only) | npm | 6 yrs; 3.15.3 = 26 days | ~493k/wk | github.com/weaviate/typescript-client | [SUS] (`too-new`, which refers to the latest publish) | Fallback only if the user rejects the rename; same checkpoint |
| `@qdrant/js-client-rest` | npm | 3.5 yrs; 1.20.0 = 33 days | ~959k/wk | github.com/qdrant/qdrant-js | [OK] | Approved |
| `@qdrant/qdrant-js` | npm | — | ~34k/wk | github.com/qdrant/qdrant-js | [OK] | Not needed (umbrella); add to the boundary list only |
| `qdrant-client`, `weaviate-client` (PyPI) | PyPI | — | — | qdrant / weaviate | not checked by seam | Not used; do not install |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** `@weaviate/node`, `@weaviate/core`, and `weaviate-client` if used as the fallback. The planner inserts one `checkpoint:human-verify` before installing. Evidence to show the user: the Weaviate docs install line, the same `repository.url` for all three, and no install scripts.
**Transitive notes:** `@weaviate/core` pulls `uuid ^14`, `graphql ^16.12`, `protobufjs ^7.5.5`, `nice-grpc-*`; the root app pins `uuid ^11`, and npm nests them, so there is no conflict. `.npmrc` `legacy-peer-deps=true` is irrelevant (no peers besides `typescript`).

## Architecture Patterns

### System Architecture Diagram

```
 WRITE SIDE (source of truth)                                         READ SIDE (per request)
 ───────────────────────────                                         ───────────────────────
 ingest()/publish/soft-delete/quarantine/re-embed/activation          chat | embed | eval | (voice: pgvector default)
        │ SQL writes (same txn)                                                │ TenantScope (minted server-side)
        ▼                                                                      ▼
 documents / document_chunks / chunk_embeddings / profiles      canonicalTenantKey(scope)  ── one helper, lowercase
        │ AFTER triggers (statement-level, transition tables)                 │
        │   no-op unless rag_vector_sync_targets has enabled rows             ▼
        ▼                                                         backend = RAG_RETRIEVAL_BACKEND[_VOICE]
 vector_sync_outbox (pending)                                                  │
        │                                                        isReady(target, profile, tenant)? ── no ──► pgvector (degraded: backend_not_ready)
        │  ◄── kick: after() in-process slice (≤10 s)                          │ yes
        │  ◄── scheduler: pg_cron+pg_net (POST) | Vercel Cron/Schedules (GET, CRON_SECRET)
        │  ◄── CLI: npm run rag:vector-sync (no slice)          ┌─────────────┴───────────────┐
        ▼                                                       ▼                             ▼
 claim RPC (FOR UPDATE SKIP LOCKED, lease 120 s,        Qdrant: qdrantScopedRequest     Weaviate: collection.withTenant(name)
   skip entities with a live lease)                     queryBatch[dense, text BM25]      nearVector ‖ bm25 (parallel)
        │                                               filter+prefetch+idf.corpus         tenant missing ⇒ not ready
        ▼                                               ⇐ assert every filter scoped      empty tokens ⇒ skip bm25 call
 read CURRENT rows (service role)                               │  timeout 800 ms / error ──────► pgvector (degraded: backend_error)
        │                                                       ▼
   servable? (chunk+doc is_current ∧ ready ∧ vector) ── yes ─► upsert point/object (id = chunk UUID,
        │ no                                                    vector + lexical_text + filter fields)
        ▼                                                       │
   delete point/object (by id; bulk: delete-by-filter)          ▼
        │                                               rag_validate_chunks(p_tenant_key, ids, profile)  ← service role only
        ▼                                                 keeps current ∧ ready ∧ in-tenant ∧ has-vector; hydrates content
 mark done | retry (backoff via lease_until) | dead              │ dropped>0 ⇒ [RAG Security] error log + span count
        │                                                       ▼
 reconcile (daily, after bulk ops): count + bucketed            TS RRF (Phase 4) → rerank → refusal → assembly (unchanged)
   XOR checksum per (target, profile, tenant) ──► repairs ─► outbox; writes rag_backend_index_state
```

### Recommended Project Structure
```
src/lib/rag/
├── backend/
│   ├── types.ts                 # Phase 4 contract (unchanged)
│   ├── factory.ts               # picks pgvector|weaviate|qdrant per entry point; fallback wrapper
│   ├── tenant-key.ts            # canonicalTenantKey(scope), weaviateTenantName(key)
│   ├── revalidate.ts            # rag_validate_chunks call + dropped counting
│   ├── readiness.ts             # isReady with 30 s TTL over rag_backend_index_state
│   ├── qdrant/
│   │   ├── client.ts            # read and write QdrantClient instances (only file importing the package)
│   │   ├── scoped-request.ts    # qdrantScopedRequest + assertScoped (pure, unit-tested)
│   │   ├── collection.ts        # create collection + payload indexes + strict mode + metadata
│   │   └── adapter.ts           # RetrievalBackend impl
│   └── weaviate/
│       ├── client.ts            # read and write clients (only file importing @weaviate/node)
│       ├── collection.ts        # create collection (MT, whitespace lexical_text, quantizer none)
│       └── adapter.ts
└── sync/
    ├── drain.ts                 # drainSlice({ budgetMs, batch }) – shared by route, after() and CLI
    ├── claim.ts                 # RPC wrappers: claim, complete, fail
    ├── servable.ts              # read current state → upsert | delete decision (pure)
    ├── stores/{qdrant,weaviate,fake}.ts   # VectorStoreWriter interface + fakes for tests
    └── reconcile.ts
src/app/api/internal/vector-sync/drain/route.ts   # POST (secret) + GET (cron) → drainSlice
supabase/migrations/07NN_*.sql                    # numbering follows 03xx/035x/04xx convention
tests/rag/canary/                                 # factory-parametrized, release gate
```

### Pattern 1: Statement-level outbox triggers with transition tables
**What:** One `AFTER INSERT`, one `AFTER UPDATE OF <synced cols>` and one `AFTER DELETE` trigger per table, `FOR EACH STATEMENT REFERENCING NEW/OLD TABLE`, each doing one set-based `INSERT ... SELECT` into the outbox for each enabled target.
**Why:** A document delete cascades to thousands of chunks. In PGlite (PG 18.7) a statement trigger with a transition table fired once on cascade and saw all 5 child rows [VERIFIED: probe output `[ { op: 'DELETE-stmt', n: 5 } ]`]. Row-level triggers also fire on cascade [VERIFIED: probe, rows `a1`/`a2` DELETE enqueued per target].
**Constraint:** "transition tables cannot be specified for triggers with more than one event" [VERIFIED: probe error text], so it takes three triggers per table.
**Early exit:** `IF NOT EXISTS (SELECT 1 FROM rag_vector_sync_targets WHERE enabled) THEN RETURN NULL;` gives the D-01 no-op default [VERIFIED: probe "no targets, outbox rows = 0"].

### Pattern 2: Claim with per-entity mutual exclusion
**What:** The claim RPC selects pending rows (or leased rows whose `lease_until < now()`), ordered by `enqueued_at`, `LIMIT p_limit FOR UPDATE SKIP LOCKED`. It **excludes any `(target, entity, entity_id)` that has another row leased with `lease_until > now()`**, then sets `status='leased', lease_until=now()+120s, attempts=attempts+1`.
**Why:** "Notification-only + read current row" is not enough on its own. Worker A can read state S1, worker B can then read S2 and write it, and A's late write of S1 wins. Excluding live-leased entities serialises each entity; reconcile catches the rest.
**Backoff without a new column:** on failure set `status='pending', lease_until = now() + least(2^attempts, 3600) s`, and let the claim require `lease_until IS NULL OR lease_until < now()`. At `attempts >= 8` set `dead`.
**Coalescing:** within a claimed batch, group by `(target, entity, entity_id)`, process once, and complete all the row IDs.

### Pattern 3: `qdrantScopedRequest`, scoping all filter locations
```typescript
// Source: field names from @qdrant/js-client-rest 1.20.0 generated_schema.d.ts (QueryRequest, Prefetch, SearchParams, IdfCorpusParams)
type Cond = { key: 'tenant_key'; match: { value: string } };
const FORBIDDEN = ['lookup_from', 'shard_key'] as const;

function scopeFilter(f: Filter | undefined, c: Cond): Filter {
  return { ...(f ?? {}), must: [c, ...((f?.must as unknown[]) ?? [])] };
}
function scopeNode(n: QueryNode, c: Cond): QueryNode {
  for (const k of FORBIDDEN) if (k in n) throw new Error(`[RAG Security] qdrant ${k} not allowed`);
  const out: QueryNode = { ...n, filter: scopeFilter(n.filter, c) };
  if (n.params?.idf && n.params.idf !== 'global') {
    out.params = { ...n.params, idf: { corpus: scopeFilter(n.params.idf.corpus, c) } };
  }
  if (n.prefetch) out.prefetch = (Array.isArray(n.prefetch) ? n.prefetch : [n.prefetch]).map((p) => scopeNode(p, c));
  return out;
}
export function assertScoped(n: QueryNode, value: string): void { /* walk filter, every prefetch (recursive) and params.idf.corpus; each must[] contains the exact Cond; reject 'global' idf, lookup_from and shard_key */ }
```
Recommend that `params.idf` is always `{ corpus: <tenant filter> }` for lexical queries and that `'global'` is rejected, which aligns IDF with Weaviate's per-tenant shard statistics.

### Pattern 4: Weaviate adapter with tenant-only access
- `weaviateTenantName(key)`: `s:default → s_default`, `u:<uuid> → u_<uuid>`, `o:<uuid> → o_<uuid>`. The server accepts only `[A-Za-z0-9_-]`, 1–64 chars [VERIFIED: probe error "should only contain alphanumeric characters (a-z, A-Z, 0-9), underscore (_), and hyphen (-), with a length between 1 and 64 characters"]. The docs say 4–64 [CITED]; the generated names are 9 or 38 chars, so both rules pass.
- Query without a tenant is rejected server-side: "class … has multi-tenancy enabled, but request was without tenant" [VERIFIED: probe]. An unknown tenant gives "tenant not found" [VERIFIED: probe]. Map that error to `not ready` → pgvector fallback (D-07/D-11), never retry untenanted.
- Insert into a missing tenant fails ("tenant not found") [VERIFIED: probe], so the worker calls `tenants.create([{ name }])` (idempotent per name) before the first upsert.
- `collection.withTenant(name)` is the only entry point [VERIFIED: `@weaviate/core` 3.15.5 `collection/index.d.ts:94` `withTenant: <TT extends TenantBase>(tenant: string | TT) => Collection<T, N, V>;`].

### Pattern 5: Collection creation specs (create before any data)
**Qdrant** (`myrag_chunks_<profile_id>`):
- `vectors: { dense: { size: <dims>, distance: 'Cosine' } }` (named vector, float32 default datatype)
- `hnsw_config: { m: 64, ef_construct: 200 }` [VERIFIED: probe readback]
- no `quantization_config`
- `strict_mode_config: { enabled: true, unindexed_filtering_retrieve: false, unindexed_filtering_update: false }` forces every filter field to be indexed (RET-10 safety net) [field names VERIFIED in client types; behaviour ASSUMED]
- `metadata: { profile_id, dims, embedding_model, lexical_version, hnsw: { m: 64, ef_construct: 200 } }` for the D-16 dimension check (`metadata` field exists in `CreateCollection` [VERIFIED: client types])

Then payload indexes, in order:
- `tenant_key`: `{ type: 'keyword', is_tenant: true }`
- `document_id`, `doc_type`, `language`, `source`, `chunking_profile_id`, `parent_id`: `keyword`
- `doc_date`: `datetime` (range with RFC 3339 strings [VERIFIED: probe])
- `lexical_text`: `{ type: 'text', tokenizer: 'whitespace', lowercase: false, scoring: { type: 'bm25' } }` [VERIFIED: probe readback]

**Weaviate** (class `Myrag_chunks_<sanitized>`):
- `multiTenancy: { enabled: true, autoTenantCreation: false }`
- `vectorizer: none`
- HNSW: `maxConnections: 64` (layer 0 uses 2× on both Weaviate [CITED] and pgvector [ASSUMED]), `efConstruction: 200`, `distance: cosine`, `filterStrategy: acorn`
- quantizer `configure.vectorIndex.quantizer.none()`, which maps to `skipDefaultQuantization: true` [VERIFIED: `@weaviate/core` `config/utils.js` `isUncompressedCreate` branch]
- `invertedIndex: { indexNullState: true, stopwords: { preset: 'none' }, bm25: { k1: 1.2, b: 0.75 } }`

Properties:
- `lexical_text`: text, `tokenization: whitespace`, `indexFilterable: false`
- `document_id`, `doc_type`, `language`, `source`, `chunking_profile_id`, `parent_id`, `content_hash`: text, `tokenization: field`, `indexSearchable: false`
- `doc_date`: date, `indexRangeFilters: true`
- `lexical_version`: int

Readback on 1.40.7 confirmed `maxConnections: 64`, `efConstruction: 200`, `filterStrategy: "acorn"`, `flatSearchCutoff: 40000`, all quantizers disabled [VERIFIED: probe].

### Anti-Patterns to Avoid
- **Any Qdrant call outside the wrapper, including `count`, `scroll` and `delete`.** Reconcile and bulk deletes also take a filter and must go through a scoped variant (write key). Only collection admin (create, index) is tenant-less, in `collection.ts` under the write key.
- **Retrying an untenanted Weaviate query after "tenant not found".** That is the not-ready path.
- **Committing a minutely `crons` entry to `vercel.json`.** It breaks Hobby deploys.
- **Logging `lexical_text`.** It is content (see Security).
- **Default `vitest run` silently skipping canaries.** In the `backend-canary` job, a missing backend must fail.
- **Raw `organization_id` or `user_id` in payloads.** Only `tenant_key` (Anti-Pattern 1 in ARCHITECTURE.md).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| BM25 on Qdrant | Client-side TF saturation + length norm into sparse values | Qdrant 1.20 text index `scoring: bm25` + `params.idf.corpus` | Server keeps doc lengths and per-corpus stats; no hash collisions |
| Per-tenant isolation in Weaviate | Payload `tenant_key` filter in one shared Weaviate collection | Native multi-tenancy + `withTenant` | Server rejects untenanted queries; per-tenant shards |
| Constant-time secret compare | `===` | `internalApiKeyMatches` (`src/lib/internal-api-key.ts:8-11`, sha256 both sides + `timingSafeEqual`) | Already the project pattern |
| Paired statistics | New bootstrap code | `eval/src/rag_eval/paired.py` (`SEED = 20261123`, `RESAMPLES = 10000`) and `gate.py` | Same numbers as every phase gate |
| Secret masking | New masking | `scripts/config-server-security.js` `maskConfig` / `isSecretConfigEntry` | Already guarantees "Secret values never leave the server" |
| Split assignment | JS port | `split.py` `SPLIT_RULE = "sha256-first8hex-mod100-lt70-dev"` via the Python CLI | D-22 |
| Distributed lock for cron overlap | Redis lock | Claim RPC leases + per-entity exclusion | Overlapping drains are safe by construction |
| Scheduler secret storage | Secret in a cron SQL literal | Supabase Vault `vault.create_secret` + `vault.decrypted_secrets` | Documented Supabase pattern |

**Key insight:** every isolation property must be enforced by code that cannot be bypassed. That means a server-rejected untenanted query (Weaviate), one wrapper with an assertion (Qdrant), and a SQL predicate with grants (re-validation). Configuration conventions alone don't count.

## Runtime State Inventory

Not a rename or migration phase. One package-name note: if the code ever adopted `weaviate-client`, nothing is stored under that name. The boundary list in `scripts/ci/check-rag-boundary.mjs:32` (`export const VECTOR_OR_RERANK_PACKAGES = ['weaviate-client', '@qdrant/js-client-rest', 'cohere-ai', 'voyageai'];`) is a code edit only.
- **Stored data:** none (no external collections exist yet).
- **Live service config:** none.
- **OS-registered state:** none. The pg_cron job is created at live setup, not migrated.
- **Secrets/env vars:** new only (D-24).
- **Build artifacts:** none.

## Common Pitfalls

### Pitfall 1: Tenant key case mismatch
**What goes wrong:** `mintScope` validates with `UUID_RE = /^[0-9a-f]{8}-...$/i` and `scopeKey` returns `` `u:${scope.userId}` `` verbatim (`src/lib/rag/tenant/scope.ts:22`, `63-68`). An upper-case UUID gives `u:ABC…`. Postgres `tenant_key` (generated from `uuid`) is lowercase. Qdrant keyword match is exact (upper-case probe → `{"points":[]}` [VERIFIED]) and Weaviate tenant names are case-sensitive [CITED].
**How to avoid:** add `canonicalTenantKey(scope) = scopeKey(scope).toLowerCase()` and use it for `p_tenant_key`, Weaviate names, Qdrant filters, the index-state key and the outbox `tenant_key`. Unit-test with an upper-case UUID.
**Warning signs:** a tenant always `not ready` on Weaviate; Qdrant lexical and dense legs empty while pgvector returns hits.

### Pitfall 2: Weaviate class name grammar vs `myrag_chunks_<profile_id>`
**What goes wrong:** profile IDs such as `voyage-4-large-2048` contain hyphens. Weaviate class names must start upper-case and are alphanumeric/underscore [ASSUMED: GraphQL name rules]. The server capitalises the first letter (the probe created `Myrag_chunks_p1`).
**How to avoid:** `weaviateCollectionName(profileId)` = `Myrag_chunks_` + profileId with non-`[A-Za-z0-9]` replaced by `_` + `_` + first 8 hex of sha256(profileId), so collisions are impossible. Qdrant keeps `myrag_chunks_<profile_id>` verbatim. Record both names in `rag_backend_index_state` or the run snapshot.

### Pitfall 3: Stale overwrite between concurrent drains
See Pattern 2. Vercel delivery is "best effort … can also occasionally invoke the same scheduled run more than once" [CITED: vercel.com/docs/cron-jobs/manage-cron-jobs], and `after()` kicks overlap with scheduler runs.

### Pitfall 4: Empty lexical query
Weaviate `bm25` with an empty query errors: "keyword search (bm25) must have query set" [VERIFIED: probe]. Qdrant returns `[]` [VERIFIED]. A stopword-only query must short-circuit to an empty lexical leg before the call, which the Phase 4 conformance suite covers ("a lexical query that is empty or made only of stopwords").

### Pitfall 5: Weaviate stopwords and analysis
The `invertedIndexConfig.stopwords.preset` default is `"en"`. Stopwords are only removed under `word` tokenization [CITED: Weaviate inverted-index reference]. With `whitespace` they are not applied, but set `preset: 'none'` anyway so a later tokenization change cannot silently drop Italian or English tokens. Qdrant text index defaults: `lowercase: true`, `ascii_folding: false`, stemmer disabled, no stopwords [VERIFIED: client types]. Set `lowercase: false` explicitly; the tokenizer already normalises.

### Pitfall 6: Fallback blows the search budget
`eval/config/latency-budgets.json:7` sets chat/embed `"search": 400`, while D-11's external timeout is 800 ms. A timeout followed by a pgvector fallback is ≥ 800 ms + pgvector time, so the stage budget is exceeded on every `backend_error`.
**How to avoid:** report degraded-path latency separately. The regression's latency gate (D-18) must run with production timeouts, not eval's "none", and report the `backend_error` rate. Open Question 3 offers a hedge.
**Also:** construct clients once per process (module scope). For Weaviate retrieval use `skipInitChecks: true` (option exists in `connection/helpers.d.ts` [VERIFIED]); for Qdrant set `checkCompatibility: false` (default `true` [VERIFIED: client d.ts]). This avoids a version round trip inside the 800 ms window. The Qdrant `query()` options take no per-call `AbortSignal`, only a client-level `timeout` [VERIFIED: d.ts]. Race the call against the request signal and the 800 ms timer.

### Pitfall 7: Qdrant `is_null` vs absent fields
`is_null` did not match a point whose `doc_date` key was absent; `is_empty` did [VERIFIED: probe]. Either always write every filter field (explicit `null`) or translate "missing" to `is_empty`. Pick one, and make the conformance null-date case decide.

### Pitfall 8: Vercel Cron specifics
- GET method.
- `Authorization: Bearer ${CRON_SECRET}`; recommended ≥ 16 chars.
- Production deployments only.
- No retries; best-effort delivery; possible duplicates.
- Does not follow redirects.
- Hobby: daily only ("expressions … more frequently will fail during deployment") [CITED: vercel.com/docs/cron-jobs/usage-and-pricing].

Vercel says Cron Jobs "are a legacy feature and will be migrated to Schedules" [CITED]. Schedules (beta) limits: Hobby every 15 min with 15-min jitter and 5,000 runs per billing period; Pro every minute [CITED: vercel.com/docs/schedules/limits].
**How to avoid:** the drain route exports GET as well as POST. GET compares against the same `RAG_VECTOR_SYNC_SECRET`, and docs tell operators to set `CRON_SECRET` to the same value. Add `export const dynamic = 'force-dynamic'`. Do not commit a `crons` entry.

### Pitfall 9: pg_net timeout vs drain slice
pg_net is asynchronous. The Supabase example uses `timeout_milliseconds:=5000` [CITED]. If the caller drops the connection at 5 s, whether the Vercel function keeps running depends on whether the handler watches `request.signal` [ASSUMED].
**How to avoid:** set `timeout_milliseconds := 58000`, and never tie the drain loop to `request.signal`. The loop is bounded by its own 45 s budget.

### Pitfall 10: Canary skipped looks green
The default `npx vitest run` in `pr-smoke` has no services. Canary files must `describe.runIf(process.env.RAG_CANARY_BACKENDS)`. In `backend-canary`, a guard test must assert that `RAG_CANARY_BACKENDS === 'pgvector,weaviate,qdrant'` and that both health endpoints answered. A skip must never satisfy the required check.

### Pitfall 11: Docker Hub rate limits in CI
This session hit `429 Too Many Requests` pulling `semitechnologies/weaviate` [VERIFIED]. Pin images by digest and add a pull-retry step. Optionally log in to Docker Hub with a read-only token (human item).

### Pitfall 12: `lexical_text` is content
D-03 says "the raw chunk text … not stored externally". But `lexical_text` is the NFKC-lowercased token stream with bigrams, which in practice is readable text. Vectors are partially invertible [ASSUMED: embedding-inversion literature]. ADM-04 must record `lexical_text` and vectors as content-equivalent for Weaviate and Qdrant, and the multi-tenant docs must say so.

### Pitfall 13: Weaviate `deleteMany` cap
`deleteMany` deletes at most `QUERY_MAXIMUM_RESULTS` (default 10,000) per call; "re-run the query" until none match [CITED: docs.weaviate.io manage-objects/delete]. Loop with `dryRun: false, verbose: false` until `matches === 0`, inside the time slice.

### Pitfall 14: Small test split, many comparisons
See Regression Protocol below.

## Code Examples

### Qdrant: two legs in one batch, tenant-scoped (probe-verified shape)
```typescript
// Source: request shape verified against qdrant/qdrant:v1.20.2 (POST /collections/{c}/points/query/batch)
const tenant = { key: 'tenant_key', match: { value: canonicalTenantKey(scope) } } as const;
const body = {
  searches: [
    { query: req.denseVector, using: 'dense', limit: req.denseLimit, filter: { must: [...nativeFilters] },
      params: { acorn: { enable: true } }, with_payload: false },
    { query: { text: req.lexicalTokens.join(' ') }, using: 'lexical_text', limit: req.lexicalLimit,
      filter: { must: [...nativeFilters] }, params: { idf: { corpus: { must: [] } } }, with_payload: false },
  ],
};
const scoped = qdrantScopedBatch(scope, body);     // injects `tenant` into filter + idf.corpus (+ prefetch), then assertScoped
const res = await readClient.queryBatch(collection, scoped);
```
Probe evidence: tenant A text query returned only tenant A's point with per-tenant IDF score `0.57536423`, while the unfiltered query returned both tenants with `0.44217452` each [VERIFIED].

### Weaviate: two legs in parallel (TS v3 API)
```typescript
// Source: TS method names from docs.weaviate.io search/bm25 and @weaviate/core 3.15.5 types; params ASSUMED where marked
const col = readClient.collections.use(collectionName).withTenant(weaviateTenantName(canonicalTenantKey(scope)));
const where = buildWeaviateFilter(col, req.filters);              // byProperty(...).equal / containsAny / greaterOrEqual / isNull
const [dense, lexical] = await Promise.all([
  col.query.nearVector(req.denseVector, { limit: req.denseLimit, filters: where, returnMetadata: ['distance'] }),
  req.lexicalTokens.length
    ? col.query.bm25(req.lexicalTokens.join(' '), { queryProperties: ['lexical_text'], limit: req.lexicalLimit, filters: where, returnMetadata: ['score'] })
    : Promise.resolve({ objects: [] }),
]);
```

### Re-validation RPC (shape)
```sql
-- Source: grants pattern of Phase 4 D-04; columns from Phase 3 D-06/D-07/D-35 (planned, not yet in repo)
create or replace function public.rag_validate_chunks(p_tenant_key text, p_ids uuid[], p_profile_id text)
returns table (id uuid, document_id uuid, content text, metadata jsonb /* + promoted columns the hit payload needs */)
language plpgsql security invoker stable set search_path = public as $$
begin
  perform rag_assert_tenant_key(p_tenant_key);          -- same malformed-key exception and mode rule as hybrid_search_chunks
  if coalesce(array_length(p_ids, 1), 0) > 500 then raise exception 'too many ids'; end if;
  return query
    select c.id, c.document_id, c.content, c.metadata
    from document_chunks c join documents d on d.id = c.document_id
    where c.id = any(p_ids) and c.tenant_key = p_tenant_key and d.tenant_key = p_tenant_key
      and c.is_current and c.status = 'ready' and d.is_current and d.status = 'ready'
      and exists (select 1 from chunk_embeddings e where e.chunk_id = c.id and e.profile_id = p_profile_id);
end $$;
revoke execute on function public.rag_validate_chunks(text, uuid[], text) from public, anon, authenticated;
grant execute on function public.rag_validate_chunks(text, uuid[], text) to service_role;
```
Profiles with `storage = legacy_column` keep vectors in `document_chunks.embedding`. The `exists` clause must branch on the profile's storage (Phase 4 D-04 routing), or the legacy profile must have `chunk_embeddings` rows (Phase 3 D-35 says "legacy rows record model and dims"). Confirm at planning against the 03 and 04 plans.

### pg_cron + pg_net scheduler (operator-run, not a migration)
```sql
-- Source: Supabase docs functions/schedule-functions and cron/quickstart (Vault + net.http_post pattern)
select vault.create_secret('https://<app-host>', 'rag_app_url');
select vault.create_secret('<RAG_VECTOR_SYNC_SECRET placeholder>', 'rag_vector_sync_secret');
select cron.schedule('rag-vector-sync-drain', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'rag_app_url') || '/api/internal/vector-sync/drain',
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'rag_vector_sync_secret')),
    body := '{"mode":"drain"}'::jsonb,
    timeout_milliseconds := 58000) as request_id; $$);
select cron.schedule('rag-vector-sync-reconcile', '17 3 * * *', $$ /* same call with {"mode":"reconcile"} */ $$);
-- prune: cron.job_run_details is not cleaned up automatically (Supabase docs)
```
Keep this out of `supabase/migrations/` and the setup files. PGlite has no `pg_cron`, and enabling extensions on a project is an operator decision. Ship it as `supabase/optional/vector-sync-schedule.sql` plus docs.

### GitHub Actions `backend-canary` job (skeleton)
```yaml
backend-canary:
  runs-on: ubuntu-latest
  timeout-minutes: 30
  services:
    qdrant:
      image: qdrant/qdrant:v1.20.2@sha256:<digest>
      ports: ['6333:6333']
      env:
        QDRANT__SERVICE__API_KEY: ci-qdrant-write-placeholder-000000000000
        QDRANT__SERVICE__READ_ONLY_API_KEY: ci-qdrant-read-placeholder-0000000000000
    weaviate:
      image: semitechnologies/weaviate:1.40.7@sha256:<digest>
      ports: ['8080:8080', '50051:50051']          # v3 client needs gRPC
      env:
        AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED: 'false'
        AUTHENTICATION_APIKEY_ENABLED: 'true'
        AUTHENTICATION_APIKEY_ALLOWED_KEYS: ci-wv-write-placeholder,ci-wv-read-placeholder
        AUTHENTICATION_APIKEY_USERS: writer,reader
        AUTHORIZATION_ADMINLIST_ENABLED: 'true'
        AUTHORIZATION_ADMINLIST_USERS: writer
        AUTHORIZATION_ADMINLIST_READONLY_USERS: reader
        PERSISTENCE_DATA_PATH: /var/lib/weaviate
        CLUSTER_HOSTNAME: node1
        DISABLE_TELEMETRY: 'true'
      options: >-
        --health-cmd "wget -q --spider http://localhost:8080/v1/.well-known/ready || exit 1"
        --health-interval 5s --health-retries 30
  steps:
    # checkout/setup-node/npm ci pinned by SHA as in pr-smoke
    - name: Wait for Qdrant            # qdrant image has no curl/wget: health-cmd cannot be used
      run: for i in $(seq 1 60); do curl -sf localhost:6333/readyz && exit 0; sleep 2; done; exit 1
    - run: npx vitest run tests/rag/canary tests/rag/backend-conformance
      env: { RAG_CANARY_BACKENDS: 'pgvector,weaviate,qdrant', QDRANT_URL: 'http://localhost:6333', WEAVIATE_URL: 'http://localhost:8080' }
```
Facts behind it:
- The Qdrant image lacks `curl` and `wget` (`exit=127`); the Weaviate image has `/usr/bin/wget`; `/readyz` returned "all shards are ready" and `/v1/.well-known/ready` returned 200 [VERIFIED: probe].
- The keys above are CI placeholders. Generate them per run if the reviewer objects to literals.
- AdminList read-only rejected writes: "user 'reader' has insufficient permissions" [VERIFIED].
- Weaviate Cloud uses RBAC `viewer` instead [CITED].

## Regression Protocol (ADM-02 statistics)

Inputs that exist today:
- Noise band, `eval/config/noise.json:2-7`: `"floor": 0.02`, `"k": 3`, `"gated_slice_prefixes": ["overall", "language:"]`.
- The gate computes `band = max(noise.k * stat.spread, noise.floor)`.
- Paired bootstrap, `paired.py:13-14`: `SEED = 20261123`, `RESAMPLES = 10000`, 95 % percentile interval.
- Split rule `sha256-first8hex-mod100-lt70-dev` (~30 % test).
- Fixture test split = 20 items (17 answerable, 3 no-answer; 30/30/30 zh/en/it overall) [VERIFIED: computed from `eval/fixtures/split-manifest.json` and `golden.jsonl`].

Recommendations:
1. **Interpret D-18 operationally.**
   - *"Beats beyond the noise band"* means `mean(challenger) − mean(incumbent) > band(metric)` on the primary metric, where the band comes from the incumbent's three-run spread (deterministic metrics give spread ≈ 0, so band = 0.02).
   - *"Wins beyond the bootstrap CI width"* (backend only) means the paired-difference 95 % CI has `ci_low > 0` **and** `mean_d > band`.
   - Record both numbers.
2. **Pre-register Stage B.** Before the first test-split call, write `eval/decisions/regression-plan-<date>.json` with the config list, metric, slices and rule, plus its hash into the decision record. The test-split budget is the number of configs in that plan, plus 1 confirmatory run. Every other use increments `test_split_uses` and needs a recorded reason.
3. **Control multiplicity.** About 15 switch ablations plus 6 backend runs at α = 0.05 each expect about one false "win". Apply Holm–Bonferroni across the ablation family on the paired p-value (bootstrap: share of resamples ≤ 0), or require `ci_low > 0` at 99 %. Security switches are exempt from needing a win ("security wins ties") but not from the no-regression gates.
4. **Minimum n for gated slices.** On a 20–60 item test split, category and `selective_filter` slices hold 1–6 items. Add `min_gate_n` (recommend 10) to the noise config. Smaller slices are reported, marked "too small to gate", and never decide a default (Pitfall 12: "say up front which slices are statistically too small to gate"). The `injection` ASR = 0 rule stays absolute at any n.
5. **Final confirmatory run.** One-at-a-time ablations miss interactions. Run the combined winning defaults once more on the test split against the incumbent. It must pass every gate, or the decision falls back to the incumbent for the conflicting switches.
6. **Judge metrics:** when judge keys exist, run the incumbent and the final challenger 3× each (judge stochasticity) and use a band from those runs. Single runs suffice for deterministic retrieval metrics.
7. **Fixture run:** with 20 items, every CI is wide. The fixture record proves plumbing only (`provisional: fixtures`, D-18).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `weaviate-client` npm package | `@weaviate/node` (+ `@weaviate/web`, shared `@weaviate/core`) | 2026 (3.15.x) | Install and boundary list change |
| Qdrant lexical via client-built sparse vectors | Full-text index `scoring: bm25` + `query: { text }` | Qdrant 1.20 | Server BM25, no hashing |
| Qdrant shard-wide IDF | `params.idf: { corpus: <filter> }` | Qdrant 1.19 | Per-tenant statistics |
| Weaviate HOT/COLD tenants | ACTIVE/INACTIVE/OFFLOADED | 1.26 | Inactive tenant queries error → fallback |
| Weaviate sweeping filter | ACORN default | 1.34 | RET-10 default holds |
| Weaviate no default compression | `DEFAULT_QUANTIZATION` env (unset by default; Weaviate Cloud "optimization profile" may set it) | 1.33 | Must set quantizer `none()` explicitly |
| Vercel Cron Jobs | Vercel Schedules (beta) | 2026 | Hobby 15-min cadence possible |

**Deprecated/outdated:** STACK.md §4's `weaviate-client@3.15.3`, `autoTenantCreation: true` and "named vectors per profile" are superseded by D-06/D-07 and the rename above. STACK's note that "Qdrant server-side `qdrant/bm25` inference is Cloud only" is irrelevant: the text-index BM25 works self-hosted [VERIFIED: probe].

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Weaviate class names must be `^[A-Z][_0-9A-Za-z]*$` (no hyphen) | Pitfall 2 | Collection create fails; the sanitizer covers it either way |
| A2 | pgvector HNSW also uses 2·m at layer 0, so `maxConnections: 64` ≈ `m = 64` | Pattern 5 | Minor fairness skew; record in snapshot |
| A3 | Qdrant `strict_mode_config` rejects filters on unindexed fields as configured | Pattern 5 | Missing index not caught; conformance `selective_filter` still checks recall |
| A4 | A Vercel function keeps running after the caller (pg_net) times out, unless it listens to `request.signal` | Pitfall 9 | Truncated slices; 58 s timeout avoids it |
| A5 | Embedding vectors are partially invertible to text | Pitfall 12 | Inventory wording only |
| A6 | Weaviate Cloud and Qdrant Cloud offer read-only keys on the tiers the user will pick (Weaviate Cloud: RBAC `viewer` role [CITED]; Qdrant Cloud: granular JWT keys [CITED]; self-hosted read-only verified) | D-09 | Falls back to one key per vendor; document |
| A7 | Weaviate Cloud may auto-deactivate or offload idle tenants | RET-09 | Queries error → `backend_error` fallback; harmless but noisy |
| A8 | The `@weaviate/node` API is identical to `weaviate-client` 3.15 for the methods used | Stack | Small compile fixes |
| A9 | Float32 storage in Qdrant/Weaviate vs `halfvec` in pgvector changes rankings negligibly | Halfvec | Conformance ties may differ; compare sets, not exact order at equal scores |
| A10 | The Phase 3/4 table, column and function names quoted from CONTEXT/PLAN files (not yet in code) land as planned | Code examples | Rename at execution |

## Open Questions (with recommendations)

1. **Weaviate package name (needs user).** D-09 says `weaviate-client`; the vendor now ships `@weaviate/node`. **Recommend `@weaviate/node@3.15.5`**, with the boundary list covering all names.
2. **Qdrant lexical leg (research-delegated by D-13).** **Recommend the full-text BM25 index**, not the sparse vector. Keep a `lexical_mode` field in the collection metadata so a later switch is detectable. Plan step 3 runs the conformance suite on it. If the Chinese exact-term case fails, fall back to the sparse vector (FNV-1a 32-bit token hash, `values` = raw counts, `modifier: idf`, `idf.corpus` scoped).
3. **800 ms timeout vs the 400 ms search budget.** Recommend keeping D-11 but adding an optional hedge: if the external call has not answered by `RAG_BACKEND_HEDGE_MS` (default off), start pgvector in parallel and take the first valid result. **Needs user** only if they want the hedge in this phase; otherwise report degraded latency separately.
4. **Scheduler choice (human, per D-04).** **Recommend pg_cron + pg_net** as the documented default. Vercel Cron only if the project is on Pro; Schedules (beta) if on Hobby and a 15-minute lag is acceptable. Note that the 300 s `RAG_VECTOR_SYNC_MAX_LAG_SECONDS` default makes a 15-minute schedule permanently "not ready" without `after()` kicks.
5. **Last-4 secret display (D-14).** The existing tool shows no characters at all. **Recommend showing the last 4 only when the value is ≥ 20 chars**, else `set`. Low risk either way.
6. **Outbox expansion of `profile`/`tenant` entities.** These can fan out to millions of chunks. **Recommend** that the worker expands them through a paged SQL function with a cursor stored in the outbox row. This needs one extra column (`cursor text`) beyond D-01's list, an implementation detail the planner can add.
7. **Outbox retention.** D-01 has no pruning. **Recommend** that reconcile deletes `done` rows older than 7 days and keeps `dead` rows until an operator requeues them. Index-compat (D-16) already warns on dead rows.
8. **Re-validation for `legacy_column` profiles.** See the Code Examples note. Resolve against the Phase 3/4 plans during planning.
9. **Canary pgvector backend:** PGlite or a real Postgres service? **Recommend PGlite**, reusing `eval/harness/pglite-supabase.mts`. PGlite is single-connection, so test concurrent claims as sequential claims plus lease expiry. Add a `pgvector/pgvector:0.8.7-pg17` service only if the planner wants a true concurrent SKIP LOCKED test, which needs the Supabase role bootstrap ported.

**Items needing the user:**
- (1) the package rename;
- (3) the hedge (optional);
- (4) the scheduler, Vercel plan and live hosts (cloud region near Vercel `iad1`);
- branch protection for `backend-canary`;
- an optional Docker Hub token for CI pulls;
- the `@weaviate/node` install checkpoint (SUS);
- live-tier read-only key availability (A6).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | app, sync, tests | ✓ | 22.23.5 | — |
| npm | install | ✓ | 10.9.9 | — |
| Python / uv | regression, failure report, promote | ✓ | 3.13.18 local (CI uses 3.12) / uv 0.11.32 | — |
| PGlite + pgvector | canary pgvector leg | ✓ | 0.5.17 / 0.0.18 (PG 18.7) | — |
| Docker | local backend tests | ✓ client 29.9.3; daemon not running by default (started manually this session) | — | CI service containers |
| Qdrant server | adapter tests | via Docker | v1.20.2 image pulled | Qdrant Cloud (live) |
| Weaviate server | adapter tests | via Docker | 1.40.7 image pulled (Docker Hub 429 on first try) | Weaviate Cloud (live) |
| Supabase pg_cron / pg_net | scheduler (live) | not checkable here | — | Vercel Cron (Pro) or Schedules |
| Hosted Weaviate/Qdrant, real keys | live verification | ✗ | — | Human item |

**Missing dependencies with no fallback:** none for build and CI. The live checks need hosted backends and keys (human).
**Missing dependencies with fallback:** the Docker daemon locally (start `dockerd`, or rely on CI).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (root `vitest.config.ts`), `node --test` for `.mts` and CI-script tests, pytest via `uv` for `eval/` |
| Config file | `vitest.config.ts`; `eval/` pyproject |
| Quick run command | `npx vitest run tests/rag/sync tests/rag/backend` |
| Full suite command | `npx vitest run && node --import tsx --test tests/*.test.mts && uv run --directory eval pytest -q` plus the `backend-canary` job with services |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RET-05 | Triggers enqueue per enabled target on insert, update of synced cols, delete and cascade; no-op without targets | unit (PGlite) | `npx vitest run tests/rag/sync/outbox-triggers.test.ts` | ❌ Wave 0 |
| RET-05 | Claim: SKIP LOCKED, lease expiry reclaim, per-entity exclusion, backoff, dead at 8 | unit (PGlite) | `npx vitest run tests/rag/sync/claim.test.ts` | ❌ |
| RET-05 | Drain: servable → upsert, else delete; coalescing; 45 s budget stop; `[Vector Sync]` line has no text | unit (fake stores) | `npx vitest run tests/rag/sync/drain.test.ts` | ❌ |
| RET-05 | Drain route: 503 unset/short secret, 401 wrong, GET + POST, constant-time | route | `npx vitest run tests/rag/sync/drain-route.test.ts` | ❌ |
| RET-05 | Reconcile detects deleted point, stale payload, extra foreign point; enqueues repair; updates index state | integration (services) | `RAG_CANARY_BACKENDS=… npx vitest run tests/rag/canary/reconcile.test.ts` | ❌ |
| RET-06 | `qdrantScopedRequest` injects into filter, every nested prefetch and `idf.corpus`; rejects `lookup_from`, `shard_key`, `idf: 'global'`; every request builder passes `assertScoped` | unit (pure) | `npx vitest run tests/rag/backend/qdrant-scoped.test.ts` | ❌ |
| RET-06 | Weaviate adapter never calls a collection without `withTenant`; tenant-name mapping and lowercase | unit + integration | `npx vitest run tests/rag/backend/weaviate-adapter.test.ts` | ❌ |
| RET-06/09 | Unknown Weaviate tenant → not ready → pgvector `degraded: backend_not_ready` | integration | canary job | ❌ |
| RET-07 | `rag_validate_chunks`: drops foreign, non-current, quarantined, no-vector IDs; anon and authenticated refused; malformed key raises | unit (PGlite, SET ROLE) | `npx vitest run tests/rag/backend/validate-chunks.test.ts` | ❌ |
| RET-07 | Foreign point planted (write key) is dropped; `tenant_validation_dropped` > 0 and `[RAG Security]` logged | canary | canary job | ❌ |
| RET-08 | All D-12 cases × 3 backends via ingest → outbox → drain | canary | `npx vitest run tests/rag/canary` (job sets env) | ❌ |
| RET-08 | Guard: canary job fails if a backend env or health is missing | canary | same | ❌ |
| RET-09 | Timeout/error → pgvector same request, `backend_error`; voice uses `RAG_RETRIEVAL_BACKEND_VOICE`; legacy ignores backend (logged once) | unit | `npx vitest run tests/rag/backend/fallback.test.ts` | ❌ |
| RET-01..03, RET-10 | Phase 4 conformance unchanged on 3 backends (zh exact term, filters, selective = exact, empty lexical) | conformance | `npx vitest run tests/rag/backend-conformance` (job) | Phase 4 creates |
| D-06 | Activation refused when an enabled external target is not ready for every tenant | unit (PGlite) | `npx vitest run tests/rag/sync/activation-gate.test.ts` | ❌ |
| ADM-01 | Manifest metadata completeness; secrets masked (no value in GET/PUT echo); Test-connection never returns key, 10 s timeout, provider enum only; index-compat warnings × 5 | unit + route | `node --test scripts/check-config.test.mjs && npx vitest run tests/rag/admin` | partial |
| ADM-02 | Regression runner: pre-registered plan hash, test-split counter, decision rule incl. min-n and multiplicity, `DefaultsDecision` validates, fixture record `provisional`; shipped-defaults check | unit (pytest) + CLI | `uv run --directory eval pytest tests/test_regression.py -q` | ❌ |
| ADM-03 | Docs generated tables match manifest; AGENTS.md links | unit | `npx vitest run tests/rag/agents-guide.test.ts` (extend) | ✅ extend |
| ADM-04 | Every managed `url`/`secret` var's provider has an inventory entry; generated md up to date | unit | `node --test scripts/check-config.test.mjs` | partial |
| EVAL-17 | Promote via JSON file: production provenance, frozen split, 3-gram Jaccard ≥ 0.85 confirm, append-only, loader fails on missing manifest ID; `execFile` path inside private dir; review chunks route returns only the trace's chunk IDs under the trace's tenant, audited | pytest + route | `uv run --directory eval pytest tests/test_review_queue.py -q && npx vitest run tests/rag/admin/review-chunks.test.ts` | partial |
| EVAL-17 | Failure report layer derivation (6 layers) | pytest | `uv run --directory eval pytest tests/test_failure_report.py -q` | ❌ |
| Boundary | Vendor client imports only in the adapter and sync dirs; all four Weaviate names and `@qdrant/qdrant-js` blocked elsewhere | CI script | `node --test scripts/tests/check-rag-boundary.node-test.mjs` | ✅ extend |

### Sampling Rate
- **Per task commit:** the quick command for the touched area (< 30 s, no services).
- **Per wave merge:** full `pr-smoke` suite locally plus the `backend-canary` job.
- **Phase gate:** pr-smoke and backend-canary green; fixture regression record produced; gate vs baseline within noise.

### Wave 0 Gaps
- [ ] `tests/rag/sync/` (triggers, claim, drain, route, activation gate) with a PGlite fixture extension for the Phase 7 migrations.
- [ ] `tests/rag/backend/` (qdrant-scoped, weaviate-adapter, validate-chunks, fallback, tenant-key).
- [ ] `tests/rag/canary/` with a backend factory and a service guard.
- [ ] `src/lib/rag/sync/stores/fake.ts` (in-memory store implementing the writer and search for unit tests).
- [ ] `eval/tests/test_regression.py`, `test_failure_report.py`; extend `test_review_queue.py`.
- [ ] CI: the `backend-canary` job (services, waits, env).

## Security Domain

`security_enforcement: true`, ASVS level 1, block on high.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V1 Architecture | yes | Four isolation layers; Supabase as the only source of answer text |
| V2 Authentication | yes | Drain: Bearer `RAG_VECTOR_SYNC_SECRET` (≥ 32 chars, constant time via `internalApiKeyMatches`, 503 when unset); admin routes: `requireAdminRequest` / `admin_users` |
| V3 Session | limited | Existing admin cookie (`admin-session.ts`) for config-server forwarding |
| V4 Access Control | yes | Tenant from `TenantScope` only; Weaviate `withTenant`; Qdrant wrapper + assertion; `rag_validate_chunks` service-role only; read-only vendor keys on the retrieval path |
| V5 Input Validation | yes | Zod (`zod/v3`) on drain body (`mode` enum), Test-connection (`provider` enum, no URL accepted), review-chunks (trace ID, item ID); Pydantic for promote file |
| V6 Cryptography | yes | No hand-rolled crypto; sha256 + `timingSafeEqual`; Vault for the cron secret |
| V7 Logging | yes | `[RAG Security]` error on dropped > 0 with counts only; `[Vector Sync]` per slice; never log `lexical_text`, content or keys |
| V8 Data Protection | yes | Minimal payload (D-03); vendor inventory marks `lexical_text` and vectors as content-equivalent |
| V9 Communications | yes | Require `https://` for `WEAVIATE_URL`/`QDRANT_URL` when `NODE_ENV=production` (reject plaintext with an API key) |
| V10 Malicious Code | yes | Package audit; exact pins; checkpoint for SUS packages; images pinned by digest |
| V12 Files | yes | Promote temp file created inside `eval/golden/private/`, path validated, `execFile` with an argv array (no shell) |
| V14 Configuration | yes | Masked secrets; fail-closed routes; defaults unchanged (pgvector, no targets) |

### The four isolation layers (cross-tenant leak = worst failure)

| Layer | Mechanism | Independent test |
|-------|-----------|------------------|
| 1. Adapter tenancy | Weaviate: server rejects untenanted queries ("request was without tenant") [VERIFIED]. Qdrant: wrapper injects into filter, prefetch and `idf.corpus`, asserts, and forbids `lookup_from`/`shard_key` | Pure unit test over every request builder; Weaviate integration test that an untenanted call is impossible in code (no exported path) |
| 2. Re-validation | `rag_validate_chunks` (current ∧ ready ∧ same tenant ∧ profile vector), service role only, no switch | PGlite role tests; canary foreign point planted with the write key is dropped and counted |
| 3. Servable-only sync | Worker deletes everything not servable; per-entity lease prevents stale overwrite | Canary cases after delete, cascade, version replace, quarantine, re-embed |
| 4. Canary release gate | 3 backends × D-12 cases in `backend-canary`, required check | Guard test fails on skip; branch protection (human) |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Query issued without tenant filter (new code path, debug call, reconcile) | Information disclosure | Single wrapper + assertion; boundary check; Qdrant count/scroll/delete also scoped |
| Tenant spoofed from request body | Spoofing | `TenantScope` minted server-side; adapters accept only branded scopes |
| Stale vectors after delete or revocation | Information disclosure | Servable-only sync + re-validation (no re-sync needed for revocation) |
| Leaked read key reads every tenant | Information disclosure | Read-only key (cannot write; probe: "Forbidden: Global manage access is required"); payload minimal; rotate procedure in docs |
| Leaked write key plants or deletes points | Tampering / DoS | Re-validation drops planted points; reconcile repairs deletions; write key only in drain/CLI env |
| Drain route abuse | DoS / Tampering | Secret, fail-closed 503, lease-bounded work, no request-supplied IDs or tenants accepted |
| Test-connection SSRF | SSRF | Provider enum only; URLs from loaded env; 10 s timeout; admin only |
| Review chunks over-read | Information disclosure / EoP | Only the chunk IDs in the item's trace, under the trace's `tenant_key`, through the tenant predicate; audit log with admin ID |
| Cross-tenant BM25 statistics | Information disclosure (score side channel) | Qdrant `idf.corpus` per tenant (verified); Weaviate per-tenant shard stats (verified) |
| Command injection in promote | EoP | `execFile` with an argv array; temp path validated inside the private dir. `config-server.js` currently imports `{ exec, spawn }` (line 5) and must add `execFile` |
| Secret echo in Config UI | Information disclosure | `maskConfig` contract kept; PUT changes only on a typed value; never logged |

## Sources

### Primary (HIGH: live probes in this session)
- Qdrant `qdrant/qdrant:v1.20.2` (Docker), probed:
  - read-only vs write keys;
  - `is_tenant` index;
  - text-index BM25 with whitespace tokens (zh, codes);
  - `params.idf.corpus` on text and sparse;
  - top-level filter reaching an unfiltered prefetch, including nested prefetches;
  - exact `count`, `scroll`, delete-by-filter;
  - `datetime` range, `is_null` vs `is_empty`;
  - case-sensitive tenant match;
  - empty text query;
  - `query/batch` with `acorn`.
- Weaviate `semitechnologies/weaviate:1.40.7` (Docker), probed:
  - MT collection readback (HNSW 64/200, ACORN, no quantization, `skipDefaultQuantization` field);
  - tenant-name grammar;
  - untenanted and unknown-tenant errors;
  - insert into a missing tenant;
  - AdminList read-only write denial;
  - per-tenant BM25 scores;
  - date range and `IsNull`;
  - empty BM25 error;
  - Aggregate count.
- PGlite 0.5.17 (PostgreSQL 18.7): row- and statement-level triggers on FK cascade; multi-event transition-table restriction; `FOR UPDATE SKIP LOCKED` claim.
- npm registry: versions, engines, dependencies and scripts for `@weaviate/node`, `@weaviate/core`, `weaviate-client`, `@qdrant/js-client-rest`; tarball type definitions (`generated_schema.d.ts`, `qdrant-client.d.ts`, `@weaviate/core` `collection/index.d.ts`, `config/utils.js`, `connection/helpers.d.ts`).
- In-repo files read this session:
  - `src/lib/rag/tenant/scope.ts:22,63-68`
  - `scripts/ci/check-rag-boundary.mjs:32`
  - `eval/config/noise.json:2-7`
  - `eval/config/latency-budgets.json:4-8,21-24`
  - `eval/src/rag_eval/paired.py:13-14`
  - `eval/src/rag_eval/split.py:8-13`
  - `vercel.json:6-10`
  - `scripts/config-server-security.js:5-7`
  - `scripts/config-server.js:5`
  - `src/lib/internal-api-key.ts:8-11`

### Secondary (MEDIUM: official docs, fetched 2026-11-24)
- docs.weaviate.io: client-libraries/typescript (package rename), manage-collections/multi-tenancy, config-refs/collections, config-refs/indexing/inverted-index, config-refs/indexing/vector-index, search/bm25, manage-objects/delete, configuration/compression/uncompressed, deploy/configuration/env-vars, deploy/configuration/configuring-rbac
- qdrant.tech: documentation/guides/multiple-partitions (is_tenant, per-tenant IDF v1.19), documentation/security (read-only key, JWT RBAC), documentation/concepts/hybrid-queries
- vercel.com: docs/cron-jobs/usage-and-pricing, docs/cron-jobs/manage-cron-jobs, docs/schedules/limits
- supabase.com: docs/guides/cron/quickstart, docs/guides/functions/schedule-functions
- nextjs.org: docs/app/api-reference/functions/after

### Tertiary (LOW)
- Qdrant course page claiming global-filter propagation to prefetch (superseded by the probe)
- Weaviate forum post on 1.33 RQ default (superseded by docs and probe readback)
- Search summary on Weaviate Cloud API-key roles (viewer); confirm on the live tier

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. Registry-verified versions; vendor docs for the rename; SUS flags handled by checkpoint.
- Architecture (sync, isolation, lexical): HIGH. Every load-bearing vendor behaviour was probed on the pinned servers.
- Scheduler: MEDIUM. Docs are clear; the plan tier is unknown (human item).
- Regression statistics: MEDIUM. Built on existing project tooling; the min-n and multiplicity values are recommendations.
- Hosted-tier key and role support: MEDIUM-LOW until the live check.

**Research date:** 2026-11-24
**Valid until:** 2026-12-08 (fast-moving: Weaviate 1.41 just shipped, and Vercel Schedules is beta)
