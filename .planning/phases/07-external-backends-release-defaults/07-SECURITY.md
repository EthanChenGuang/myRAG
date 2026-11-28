---
phase: "07"
slug: "external-backends-release-defaults"
status: draft
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
block_on: high
created: "2026-11-28"
audited_commit: c536c9e5
---

# Phase 07 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Audit: `/gsd-secure-phase 07` on branch `verify/07` (from `origin/exec/07-31`, HEAD c536c9e5). Verdict **SECURED**, `threats_open: 0`.
> Status stays `draft`: the owner sign-offs listed below are not given here and must not be ticked by an agent.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| App → Weaviate / Qdrant | Read path (queries, prefetch) and sync path (upsert, delete, purge) to the external vector stores | vectors, lexical text, `tenant_key`, `document_id`, `access_groups` (D-03 payload only; no document text beyond lexical text) |
| External store → app | Hits returned by an external backend | chunk ids and scores; every hit re-validated against Supabase (`rag_validate_chunks` / `rag_validate_chunks_for_groups`) before use |
| Supabase triggers → outbox → drain | Writer triggers enqueue, drain worker claims and ships | entity ids, tenant keys, purge lineage ids |
| Scheduler / Cron → `/api/internal/vector-sync/drain` | Shared-secret internal route | bearer secret `RAG_VECTOR_SYNC_SECRET` (≥32 chars) |
| Admin UI / Config UI → admin routes | targets, index-compat, providers/test, rollouts, languages, language-quality, red-team | admin session (`checkAdmin` / `requireAdminOrDeny`), CSRF + loopback on the Config UI server |
| Eval harness → internal red-team route | `RAG_EVAL_SECRET` | synthetic attack cases only |

---

## Threat Register (summary)

Register built from the `<threat_model>` blocks of all 53 PLAN files: 177 numbered IDs (T-07-01..T-07-177) plus T-07-SC.

| Disposition | Count | Status |
|-------------|-------|--------|
| mitigate | 147 | all closed (evidence below) |
| transfer | 19 (T-07-57; 18 threats of retired plans 07-22, 07-23, 07-26, 07-29 → Phase 5.1.1) | closed (transferred) |
| accept | T-07-147; T-07-SC in 52 plans | closed (accepted risks log) |
| T-07-SC in 07-01 (mitigate) | 1 | closed (exact pins, lock integrity, no install scripts) |
| owner / live (07-32, 07-33, 07-50) | 10 | **owner sign-off required** — not implementation gaps, not counted as open |

SUMMARY threat flags: only 07-14-SUMMARY has a `## Threat Flags` section ("None"); no unregistered flag.

### Cross-tenant priority checks

| Check | Evidence |
|-------|----------|
| Tenant clause on every Qdrant query, prefetch (any depth), IDF corpus | `src/lib/rag/backend/qdrant/scoped-request.ts` (`scopeNode`, `assertScoped`, `FORBIDDEN_KEYS`); store calls via `scopedScroll`/`scopedCount`/`scopedDeleteIds`/`scopedDeleteByFilter` in `src/lib/rag/sync/stores/qdrant.ts` |
| Weaviate tenant-only data path | `weaviate/adapter.ts:tenantCollection`; autoTenant creation/activation off; missing tenant → `BackendNotReadyError`, never retried untenanted |
| Supabase re-validation of every external hit, no switch | `backend/external.ts:createExternalBackend` → `revalidateChunks`; 0704 `rag_validate_chunks` asserts tenant; source recheck forced on Weaviate/Qdrant (`source-recheck.ts:sourceRecheckDecision`) |
| Access groups (SEC-12 adapter clause) | Qdrant `requireAccessClause`, Weaviate `withAccessGroups`, `external.ts:assertExternalAccess`, 0742 `rag_validate_chunks_for_groups`; payload refuses a point without `access_groups` |
| Purge through outbox | 0727 → 0740 `rag_vector_sync_enqueue_purge` (tenant assert, lineage mismatch); `sync/purge.ts:processPurgeGroup` counts to zero; reconcile reopens |
| SQL grants / search_path | every function in 0701–0709, 0740–0745: `SET search_path = ''`, REVOKE PUBLIC/anon/authenticated, service_role only; RLS on, no policies; `schema-equality.test.mts:assertPhase7Secured` |
| Logs | `sync/log.ts:buildVectorSyncLogPayload` fixed field list; no secrets, no text, no tenant keys in CLI output |

### Closed — mitigate (evidence, file:symbol)

| IDs | Evidence |
|-----|----------|
| 01–02 | boundary rule `vector-store-client`; `docker-compose.backends.yml` digest pins, 127.0.0.1 ports |
| 03–06 | 0701 RLS/REVOKE; 0702 DEFINER triggers with empty search_path, transition-table inserts, early exit when no target enabled |
| 07–11 | `scoped-request.ts` scoping, forbidden keys, tenant IDF; `canonicalTenantKey` (assert + lower-case) |
| 12–15 | empty secret defaults + 32-char warning; `parseBackend` default pgvector; `vector_sync.py` `extra="forbid"`; `fallback_reason` in trace |
| 16–20 | re-validation (`external.ts`, 0704), payload built field by field (`servable.ts:toPoint`), 0704 REVOKE, `logTenantValidationDropped`, `rag_servable_chunks` view parity |
| 21–25 | Qdrant scoped batch, read-only key client, http refused in prod with key, payload indexes + strict mode, `filter_unsupported` → pgvector |
| 26–29 | Weaviate tenant collection, error mapping, autoTenant off, quantizer none / stopwords none |
| 30–38 | `planDocumentSync` deletes, claim advisory lock + lease, fixed log fields, drain budget/cursor, 0706 `external_not_ready`, grants, reconcile repair and 64-bucket XOR readiness, prune 7 days |
| 39–46 | readiness gate, 800 ms timeout race, degraded trace, eval-only override, `checkVectorSyncAccess` (timingSafeEqual), strict body + 45 s slice, Vault-based schedule recipe, `after()` kick |
| 47–56 | canary suite on 3 backends, foreign-point control, `canaryGuardProblems`, targets/index-compat routes admin-first, `check-workflows.py` digest + no continue-on-error + no `secrets.` in pr-smoke |
| 58–70, 118, 172 | release contracts (`plan_sha256`, ledger), check-config secret typing and five-location sync, providers/test admin-first + enum + fixed messages + timeout, Config UI masking/merge/CSRF/host check, vendor data-flow inventory |
| 79–84, 88–92, 98–102, 111–116, 120 | regression pre-registration + Holm, security ties, provisional records cannot move defaults, backend snapshot, doc tests, semantic-cache canaries (all entry points), `check-release-defaults.mjs`, `assertPhase7Secured`, off-parity, voice/embed scope canaries with negative controls |
| 121–134 | 0740 purge enqueue (assert, CHECKs, 1..200 stale ids, disabled targets that hold state), purge tenant mismatch refusal, all-collection sweep, `PurgeIncompleteError` + reopen, forced recheck, stale-repair rate limit, purge/recheck canaries in backend-canary job |
| 135–146, 148–150 | language-monitor and rollout contracts, trace language sanitising, calibration hashes, red-team marker/tenant refusal, internal cases route `checkEvalAccess` + 404 when off, synthetic-only corpus, cost `not_provided`, `language_below_baseline`, 0742 compare columns, access filter on every query/prefetch, byte-identical pre-rev-4 Qdrant request |
| 151–168, 169 | `RAG_LANG_CONFIDENCE` metadata, 0743 counts only + admin route, rollout canary foreign point, rollout arm from `scopeKey` only, 0744 RLS/assert/actor, Config UI red-team `execFile` shell:false + admin authorize + 409 run_active, rollouts route admin-first + 404 off, promote per-language windows, 0745 tenant-scoped selection, removal deletes nothing |
| 173–177 | `LexicalParamsMismatchError`, only `bm25` k/b in text query, `rebuild-lexical` without `--confirm` reports and exits 2, params from config only, mismatch message ids only |

Full per-ID evidence is in the auditor's return (orchestrator session, 2026-11-28).

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-07-01 | T-07-147 (low, 07-38) | Group identifiers reach the vendor as filter fields, like `tenant_key` and `document_id` (D-03); not a content kind | plan-time disposition (07-38) | 2026-11-25 |
| AR-07-02 | T-07-SC (accept in 52 plans) | No package installed by those plans: Phase 7 commits change only npm script entries (`rag:languages`, `rag:rollout`, `rag:red-team`); no lockfile or uv lock change outside 07-01 | plan-time disposition | 2026-11-25 |

Note: the 07-01 package-legitimacy checkpoint (`@weaviate/node`/`@weaviate/core` 3.15.5, `@qdrant/js-client-rest` 1.20.0) was approved by the orchestrator under owner delegation (07-01-SUMMARY), not by the owner. Owner confirmation is listed below.

---

## Owner Sign-Off Required (not given here)

| ID | Sev | Item | Plan | Evidence already in place |
|----|-----|------|------|---------------------------|
| T-07-110 | crit | Full canary suite against the hosted backends and the real project before any tenant data is synced | 07-33 | canary suite + backend-canary CI job |
| T-07-103 | high | Hosting / region decision; vendor retention and training terms (`config/rag/vendor-data-flow.json` has 34 `to_verify` values) | 07-32 | targets seeded disabled; defer keeps data in Supabase |
| T-07-105 | high | Make `backend-canary` a required check on main (confirm through the GitHub API) | 07-32 | job has no continue-on-error; aggregate job needs it (`pr-smoke.yml:599`) |
| T-07-104 | med | Read-only key per backend available and recorded | 07-32 | warn-once fallback in `qdrant/client.ts`, `weaviate/client.ts` |
| T-07-106 | high | Live canary on synthetic tenants only | 07-33 | — |
| T-07-107 | high | No keys, golden items or tenant ids in the live SUMMARY or decision record | 07-33 | — |
| T-07-108 | high | Database backup before live migrations | 07-33 | idempotency proven on PGlite, both modes |
| T-07-109 | high | Human review of the live defaults record | 07-33 | `check-release-defaults` in CI |
| T-07-170 | high | Revision-4 live checks on synthetic tenants only | 07-50 | — |
| T-07-171 | high | Red-team run targets the synthetic workspace only | 07-50 | marker refusal in `run-red-team.mts` |
| — | — | Confirm the delegated 07-01 package approval | 07-01 | exact pins + integrity hashes |

---

## Informational (non-blocking)

1. `pr-smoke.yml:590` runs `tests/rag/canary` and `tests/rag/backend-conformance` in one vitest step; 07-14/07-34 advised separate steps (conformance drops the legacy collection mid-run). Likely flaky red, not false green. Recommend splitting.
2. Cache hits naming no document are served without a Supabase re-check (`cache/sources.ts`), by design; isolation rests on the tenant key in the cache key.
3. `purged_points_present` not persisted on stale rows (07-36 deviation 1): observability only.
4. `backendForRequest` does not route on `accessFilter`; `tenant/access-startup.ts` checks the registry default's capabilities, not the selected backend's. Holds today (both adapters declare `accessFilter: true`).
5. Transferred threats (Phase 5.1.1) have no SECURITY.md yet: run `/gsd-secure-phase 5.1.1`.
6. Drain route returns reconcile reports with tenant keys to the bearer-secret holder (ids only, never logged).
7. 0702 `rag_vector_sync_enqueue` takes tenant keys without `rag_assert_tenant_key`; internal, trigger-fed, service_role only, outbox CHECK enforces the pattern.
8. T-07-120: a provisional record without the three ADM-02 blocks passes with a notice (orchestrator decision (b), 07-30/07-43); non-provisional records still exit 2.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-28 | 178 | 168 (+10 owner sign-off) | 0 | gsd-security-auditor (opus), `/gsd-secure-phase 07` |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [ ] Owner sign-offs above (07-32, 07-33, 07-50, 07-01 delegation) — **owner only**
- [ ] `status: verified` set in frontmatter — after the owner sign-offs

**Approval:** pending (owner)
