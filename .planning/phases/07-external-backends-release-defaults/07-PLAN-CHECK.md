# Phase 7 Plan Check

**Verdict: FAIL**. 2 blockers, 5 warnings, 2 info.
**Plans checked:** 33 (07-01..07-33), with 07-PLAN-INDEX.md, 07-VALIDATION.md, CONTEXT, RESEARCH, PATTERNS, REQUIREMENTS, ROADMAP, AGENTS.md, .claude/CLAUDE.md.

## What was verified and holds

- Cross-tenant isolation: the Qdrant wrapper with an injected tenant filter that asserts and throws (07-03, D-08); Weaviate tenant per workspace (07-08); re-validation through `rag_validate_chunks` drops foreign, non-current, quarantined and unservable ids (07-06); a foreign-point canary with B's id, a random UUID and A's quarantined id (07-14 Task 2); two-tenant conformance on both adapters (07-07, 07-08).
- Quarantine: a quarantine re-syncs the whole document and deletes every non-servable store id, and a release re-upserts them (07-09, guarded by a mutation test). Canary cases cover "after quarantine" and "release, owner only" (07-14). Re-validation drops a quarantined id even when a stale point is still in the store (07-06). Note: CONTEXT D-08 is the Qdrant wrapper, not quarantine. Quarantine falls under D-02 and both are covered.
- Off-state parity: 07-31 Task 2 asserts that no vendor client is constructed and no outbox row is written while the defaults are set. 07-30 uses the incumbent map while the record is provisional, so a fixture record cannot move the shipped defaults.
- Drain auth: 07-13 uses `internalApiKeyMatches` (src/lib/internal-api-key.ts, sha256 + timingSafeEqual). It answers 503 when the secret is unset or shorter than 32 characters, and the secret is never logged.
- Admin routes: index-compat and sync-target (07-15), review-chunks (07-23) and Test-connection (07-19, `requireAdminOrDeny`, fixed provider enum, `.strict()` body, no caller URL) are covered. The kick is in-process only, with no route.
- Config sync: 07-04 touches env.ts, init-env.js, config-server.js, config-ui/index.html and env-manifest.json. 07-30 checks every D-18 location.
- Dependencies: acyclic, and every Phase 7 dependency sits in an earlier wave. The edges to Phases 3, 3.1, 4, 5 and 6 are present.
- Code reality: all 52 `grep -c` gates with numeric `[HEAD=n]` baselines were replayed against the working tree and every one matched. No git commands were run.
- Coverage: every phase requirement (RET-05..09, ADM-01..04, EVAL-17), D-01..D-26 and A-1..A-12 maps to at least one plan. Deferred ideas are absent.

## BLOCKERS

### 07-01 (Task 2) [context_compliance / packages]
- **Required property:** executors never install packages. Only the orchestrator installs, after the user approves.
- **Evidence:** the Task 2 action says "run `npm install --save-exact @weaviate/node@3.15.5 @qdrant/js-client-rest@1.20.0`" inside an executor task, and its verify step runs `npm ls`. Nothing hands the install to the orchestrator.
- **Example fix (non-binding):** have the orchestrator run the install after the Task 1 approval. Task 2 then only checks the pinned versions in package.json and package-lock and edits the boundary script.

### 07-14 (and 07-28) [requirement_coverage / cross-tenant canary]
- **Required property:** the cross-tenant canary covers the voice and embed retrieval paths on every backend, as well as the semantic cache.
- **Evidence:** 07-14 has no case on the voice path and no case on the embed path. The word "voice" appears 0 times in the plan, and no plan references `resolveVoiceScope` or `resolveEmbedScope`. 07-28 covers only the semantic cache. `RAG_RETRIEVAL_BACKEND_VOICE` is its own switch, so voice can reach an external store through a scope that no canary tests.
- **Example fix (non-binding):** add canary cases that resolve the voice scope (signed token) and the embed scope (`RAG_EMBED_TENANT`) and assert there is no foreign marker on pgvector, Weaviate and Qdrant.

## WARNINGS

1. **07-29 [admin routes]:** the promote endpoint lives in config-server and relies on CSRF plus loopback. It does not use `requireRagAdmin` or `admin-route-auth`, and the admin session is forwarded only for the chunks call. Either gate promote through the app's admin check, or record why the config-server boundary is enough.
2. **07-19 [secrets]:** the "never leaks" test covers keys and response bodies, but no truth or test asserts that the endpoint URL or host (WEAVIATE_URL, QDRANT_URL, sidecar URL) stays out of probe responses.
3. **07-04, 07-05, 07-12, 07-25 [dependencies, Phase 5.1]:** these plans touch files that Phase 5.1 drafts are likely to share (the five config locations, the contract registry, the pipeline and the eval route). 07-04, 07-05 and 07-12 carry no 5.1 edge and no 5.1 precondition. Once 5.1 has a plan index, add its closing plan id to these plans and to the closeout plans that currently rely only on the `05.1-VERIFICATION.md` precondition (07-17..07-27, 07-29, 07-30).
4. **07-33 [scope]:** 4 tasks, which is borderline. It is a live, human-paced plan, so consider splitting it.
5. **07-02, 07-06, 07-10, 07-13, 07-14 [fragile baselines]:** these baselines are pinned at @fc29de8 on Phase 3 files (writer, re-embed, quarantine) while Phase 3 is still executing. Re-run the baselines once Phase 3 closes.

## INFO

1. The `HEAD=error:N` baselines (tests not yet present) were not replayed. They are failing-direction gates by design.
2. Same-wave coupling: 07-07 and 07-10 (wave 3) are ordered only by an execution note for the PGlite migrations, not by `depends_on`. Consider declaring the edge or marking the pair `coupling_justified`.

## Recommendation

Revise 07-01 and 07-14 (with 07-28 if the cases go there), address the warnings, then re-check.

## Re-check (pass 2)

**Verdict: PASS.** 0 blockers, 2 warnings (both carried over), 2 info. 34 plans checked. No git commands were run.

### Earlier blockers
- **B1 (07-01): closed.** The install is now an `<orchestrator-only>` step after the Task 1 approval. Task 2 has a precondition that halts if the install commit is missing, and its action says "do not run npm install, npm ci, npm update or any other package-manager command". Task 2 now only checks the pins.
- **B2 (07-14 and 07-28): closed by the new 07-34.**
  - It covers the voice path through `resolveVoiceScope` with a token from `mintVoiceToken`, and the embed path through `resolveEmbedScope` with `RAG_EMBED_TENANT`.
  - Both paths are tested on pgvector, Weaviate and Qdrant.
  - Each case has a negative control: a test-only read client that ignores the tenant filter, so the tests can actually fail. Production wiring is unchanged.
  - 07-28 adds voice and embed cache cases and depends on 07-34.

### Former warnings
- **07-29 promote auth: closed.** Every review endpoint first calls `GET /api/rag/admin/review/authorize`, which runs `checkAdmin` and imports only admin-route-auth. It fails closed: 401 when there is no session, 403 for a non-admin, 503 when the lookup fails or the app cannot be reached. Only a 200 that carries an admin id lets the action proceed. On refusal no temp file is written and `execFile` is never called.
  - Cross-site: the route is a GET with no side effects and `Cache-Control: no-store`. It returns only `{ ok, adminId }`, it is called server-to-server from the loopback config server behind the CSRF header, and the plan adds no CORS headers. A cross-site caller can trigger it but cannot read the answer or cause any effect.
- **07-19 leak: closed.** The response is `{provider, ok, latencyMs, code, message}` with a fixed message per code, and a test asserts that the endpoint and host never leak. Keeping latencyMs is accepted by the coordinator (D-15).
- **07-33 with 4 tasks:** accepted by the coordinator.

### New plan and wave checks
- **07-34 sits in wave 6.** Its Phase 7 dependencies (07-06, 07-07, 07-08, 07-12, 07-14) are all in waves 2 to 5, so the order is valid.
- **No shared files within a wave.** 07-34's files do not overlap with 07-15 or 07-16 in wave 6. 07-28 does not overlap with 07-17, 07-18 or 07-19 in wave 7.
- **Downstream edges hold.** 07-31 reaches 07-34 through 07-28. The index, the RET-07 and RET-08 rows and the D-26 step 7 entry are updated.
- **Voice default keeps today's behaviour.**
  - 07-12 asserts that with the defaults, chat, embed, voice and eval all get pgvector and no readiness call is made.
  - 07-34 asserts that voice stays on pgvector with no readiness call even when `RAG_RETRIEVAL_BACKEND=qdrant`.

### Remaining WARNINGS
1. **Phase 5.1 edges are still deferred.** This was accepted and is listed under pending in 07-PLAN-INDEX.md. 07-04, 07-05, 07-12, 07-25 and the closeout plans (07-17 to 07-27, 07-29, 07-30) need the 5.1 closing plan id once 5.1 has a plan index.
2. **Baselines remain fragile while Phase 3 executes.** Re-measure notes were added, but the baselines in 07-02, 07-06, 07-10, 07-13 and 07-14 must be re-run after Phase 3 closes.

### INFO
1. 07-29: consider asserting that the authorize route sends no `Access-Control-Allow-Origin` header.
2. The same-wave note for 07-07 and 07-10 (PGlite migration order) is unchanged and remains advisory.
