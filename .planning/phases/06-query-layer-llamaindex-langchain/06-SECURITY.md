---
phase: "06"
slug: "query-layer-llamaindex-langchain"
status: draft
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 3
asvs_level: 1
block_on: high
created: "2026-11-28"
audited_ref: "origin/main 00afa6d9 (branch verify/06)"
---

# Phase 06 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> The register was put together from the `<threat_model>` blocks of all 46 PLAN files (every plan has one, so `register_authored_at_plan_time: true`). No SUMMARY has a `## Threat Flags` section.
> The gsd-security-auditor checked each mitigation read-only, with file:line evidence.
> **This document carries no owner signature.** The owner alone signs the accepted risks and the final approval.

---

## Verdict

**OPEN_THREATS: 3 blocking threats, T-06-95, T-06-96 and T-06-97, all in plan 06-46.**

- Plan 06-46 has not run. It stopped at its human-verify checkpoint (`origin/exec/06-46` @ `8169aab9`, `06-46-CHECKPOINT.md`), and there is no 06-46-SUMMARY.
- Every mitigation for plans 06-01 to 06-45 is present in the code: 105 of 108 `mitigate` entries are closed.
- The three open threats close only after the owner runs 06-46 Task 1 on a **test** Supabase project (never production) and writes 06-46-SUMMARY.
- Code-level backstops for T-06-97 already exist and are tested:
  - REVOKE/GRANT in 0601:38-39, 0602:222-230 and 0603:31-32,350-359, plus the folded setup files.
  - `tests/rag-db/language-shares.test.mts:138-185`, `semantic-cache.test.mts:463-512` and `hybrid-grants.test.mts:66-113`.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| App → OpenRouter (query LLM) | condense, expand, decompose, translate, HyDE and date calls through `src/lib/rag/query/llm` (LlamaIndex) or `src/lib/rag/query/langchain/` | User question and trimmed history (personal data possible); `data_collection: deny` |
| App → Supabase service role | `rag_tenant_language_shares`, `hybrid_search_chunks`, `rag_cache_*` (pgvector cache) | Tenant key from `scopeKey` only; cached answers, citations, source ids |
| App → sidecar `/v1/cache/*` → Redis | RedisVL backend (shared secret) | Tenant-tagged cached answers, embeddings |
| Voice agent → `/api/internal/voice-rag` | history (≤ 6 turns), signed scope token | Voice transcripts |
| Browser/embed → chat and embed routes | cache check and hit replay | Cached answer text, sources, citations |
| Admin → `/api/rag/admin/semantic-cache`, Config UI | clear a tenant's cache, framework switch | Tenant key, admin session |
| Supply chain | LangChain packages (06-22), RedisVL extra | npm and PyPI artifacts |

---

## Threat Register

Each plan's own `T-06-SC` (supply-chain) entry is summarised below the table.

| Threat ID | Plan | Category | Component | Severity | Disposition | Mitigation (plan) | Status |
|-----------|------|----------|-----------|----------|-------------|-------------------|--------|
| T-06-01 | 06-01 | Tampering | LLM output shapes | medium | mitigate | extra forbid, bounded list lengths (4) and strict required fields; anything else fails validation and the transform is skipped | closed |
| T-06-02 | 06-01 | Elevation of privilege | RagRunOptions overrides | medium | mitigate | override keys are a closed set; the route applies them only to the eval profile (plan 06-29) | closed |
| T-06-03 | 06-02 | Tampering | config drift between the five locations | medium | mitigate | check-config fails CI on a missing location; the manifest marks each name managed | closed |
| T-06-04 | 06-02 | Information disclosure | secrets in templates | low | mitigate | RAG_QUERY_LLM_MODEL reuses the existing OpenRouter key, which is never written to templates; REDIS_URL has an empty default everywhere | closed |
| T-06-05 | 06-03 | Denial of service | regex backtracking in the gate | medium | mitigate | patterns are anchored or bounded, compiled once; the p99 benchmark fails on a slow pattern | closed |
| T-06-06 | 06-03 | Tampering | identifiers altered by a later rewrite | high | mitigate | protected tokens are extracted here and checked verbatim (NFC, case-sensitive) after every LLM transform (plan 06-07) | closed |
| T-06-07 | 06-04 | Information disclosure | rag_tenant_language_shares across tenants | critical | mitigate | tenant only from p_tenant_key, validated by rag_assert_tenant_key; two-tenant test; key comes only from TenantScope in the app (plan 06-16) | closed |
| T-06-08 | 06-04 | Elevation of privilege | function grants | high | mitigate | REVOKE from PUBLIC, anon and authenticated; GRANT to service_role only; SET ROLE and anon-key edge tests | closed |
| T-06-09 | 06-05 | Tampering | schema drift between Pydantic and Zod | medium | mitigate | generated only; second run must be byte-identical; contracts and parity tests over samples | closed |
| T-06-10 | 06-06 | Tampering | client time zone | low | mitigate | only zones accepted by Intl are used, otherwise UTC; the range only narrows retrieval inside the tenant scope | closed |
| T-06-11 | 06-07 | Tampering | prompt injection through history | high | mitigate | history in an escaped delimited data block; outputs are text only, length-capped and protected-token-checked; they never change scope, filters, mode or tools | closed |
| T-06-12 | 06-07 | Denial of service | slow transforms stacking latency | medium | mitigate | group deadline anchored at the gate start with the 1.2 s chat budget; voice has no group | closed |
| T-06-13 | 06-08 | Elevation of privilege | a second overload with default PUBLIC execute | high | mitigate | DROP the old signature in the same migration; overload count test; REVOKE and GRANT re-issued on the new signature | closed |
| T-06-14 | 06-08 | Information disclosure | undated rows bypassing tenant predicates | critical | mitigate | the flag only widens the date predicate; tenant, current and status predicates unchanged; two-tenant undated case | closed |
| T-06-15 | 06-09 | Tampering | RedisVL tag-filter injection through tenant_key or key_hash | high | mitigate | strict regexes on both fields in every request model, so no raw string reaches a Tag filter | closed |
| T-06-16 | 06-09 | Information disclosure | unreliable answers served from the cache | high | mitigate | CachedAnswer cannot carry possibly_unreliable | closed |
| T-06-17 | 06-10 | Information disclosure | query and history sent to the query model | medium | mitigate | layer off by default; provider data_collection deny; no query text in logs; the recipient is listed for Phase 7's vendor inventory | closed |
| T-06-18 | 06-10 | Denial of service | retries and slow calls blowing the budget | medium | mitigate | maxRetries 0, abort signal per call, per-stage timeouts from config | closed |
| T-06-19 | 06-10 | Information disclosure | API key in logs | high | mitigate | presence-only warning; test asserts no key material in the log | closed |
| T-06-20 | 06-11 | Tampering | malformed sidecar cache response | medium | mitigate | the app parses every response with the generated schema and treats a failure as a miss (plan 06-21) | closed |
| T-06-21 | 06-12 | Information disclosure | cross-tenant cache hit | critical | mitigate | tenant_key equality in the CTE prefilter of every function, guard first, RLS on with no policies, two-tenant tests here and in plan 06-42 | closed |
| T-06-22 | 06-12 | Information disclosure | stale answer after a document change | high | mitigate | per-event statement triggers in the same transaction plus source re-validation on every hit | closed |
| T-06-23 | 06-12 | Elevation of privilege | SECURITY DEFINER trigger functions | medium | mitigate | fixed search_path, execute revoked, they only delete cache rows for tenant keys taken from the transition tables | closed |
| T-06-24 | 06-12 | Denial of service | unbounded cache growth | low | mitigate | TTL bound 86400 s, bounded expired-row cleanup on each store | closed |
| T-06-25 | 06-13 | Elevation of privilege | rewrite widening scope or filters | high | mitigate | the outcome carries only variants, a date range merged by narrowing, and flags; the TenantScope is never part of the layer's input or output | closed |
| T-06-26 | 06-13 | Tampering | condense losing an identifier | high | mitigate | checkCondensed discards the rewrite and the original is used; tested | closed |
| T-06-27 | 06-13 | Denial of service | slow condense | medium | mitigate | runStage timeout per profile, onFail skip, original always retrieved | closed |
| T-06-28 | 06-14 | Denial of service | variant explosion | medium | mitigate | limits validated against the D-08 ceilings; overrides only for the eval profile | closed |
| T-06-29 | 06-14 | Tampering | MCP queries rewritten | low | mitigate | tool_required with needsMcp gives no transforms, so the MCP path sees the original query | closed |
| T-06-30 | 06-15 | Tampering | HyDE turning a no-answer item into an answer | high | mitigate | HyDE is dense-only and never the rerank or refusal query (D-06); asserted here and in plan 06-25 | closed |
| T-06-31 | 06-15 | Repudiation | vendored prompts without provenance | low | mitigate | each prompt file records package, version, license and attribution | closed |
| T-06-32 | 06-16 | Information disclosure | language shares of another tenant | high | mitigate | tenant key only from scopeKey(TenantScope); cache keyed by tenant key; SQL guard (plan 06-04) | closed |
| T-06-33 | 06-16 | Information disclosure | tenant key in logs | low | mitigate | logs carry a hash of the key only | closed |
| T-06-34 | 06-17 | Tampering | cache poisoning through history or instructions in the message | high | mitigate | store only history-free turns whose raw message equals the standalone query; key includes entry profile and prompt template hash (A-3) | closed |
| T-06-35 | 06-17 | Information disclosure | personal answers served to colleagues | high | mitigate | personal-data and first-person bypass at check and store; ghost chats never stored | closed |
| T-06-36 | 06-17 | Information disclosure | wrong-code or wrong-date hits | high | mitigate | protected tokens and R2 bypass; near-miss gate in plan 06-41 | closed |
| T-06-37 | 06-18 | Elevation of privilege | adapter reaching tenant or backend modules | critical | mitigate | allow-list rule langchain-adapter-reach; the port is the only retrieval path (plan 06-26) | closed |
| T-06-38 | 06-18 | Tampering | zod 4 leaking into app schemas | medium | mitigate | zod-v4 rule plus the npm ls zod check (plan 06-22) | closed |
| T-06-39 | 06-18 | Information disclosure | cache or language-share RPC called from an unscoped module | high | mitigate | cache-rpc rule keeps calls in modules that take a TenantScope | closed |
| T-06-40 | 06-19 | Denial of service | latency stacking of transforms | medium | mitigate | per-transform timeouts, group deadline anchored at the gate, budget-shared variants; delay tests | closed |
| T-06-41 | 06-19 | Tampering | strict refusal replaced by an outage message | medium | mitigate | A-2 soft-stage rule with characterization tests; strict-mode suite re-run | closed |
| T-06-42 | 06-19 | Information disclosure | small talk answered from documents | low | accept | small talk skips retrieval only under the layer; the model answers without KB context | accepted — owner sign-off pending |
| T-06-43 | 06-20 | Denial of service | too many parallel searches | medium | mitigate | hard cap 8 from query params with a validator ceiling; cuts traced | closed |
| T-06-44 | 06-20 | Information disclosure | a variant searched outside the tenant | critical | mitigate | variants carry text only; scope and filters come from the request and are shared by every call (Phase 4 backend contract) | closed |
| T-06-45 | 06-21 | Information disclosure | cross-tenant hit through an adapter | critical | mitigate | tenant key only from scopeKey(TenantScope); PGlite two-tenant case through the adapter | closed |
| T-06-46 | 06-21 | Information disclosure | stale RedisVL answer after a document change | high | mitigate | emission from publish and soft delete, per-hit rag_cache_sources_current check, TTL | closed |
| T-06-47 | 06-21 | Spoofing | unauthenticated sidecar calls | high | mitigate | shared-secret header on every call; the sidecar fails closed (existing middleware) | closed |
| T-06-48 | 06-21 | Denial of service | cache latency on the request path | medium | mitigate | 150 ms timeout, fail-open to a miss | closed |
| T-06-49 | 06-22 | Tampering | zod 4 replacing the app's zod 3 | medium | mitigate | npm ls zod CI check, zod-v4 boundary rule, tsc and build gates | closed |
| T-06-50 | 06-22 | Information disclosure | LangSmith telemetry from the new packages | medium | mitigate | tracing stays inert unless LANGSMITH_* or LANGCHAIN_TRACING* is true; the adapter passes callbacks [] and the config warns on those variables (plan 06-37) | closed |
| T-06-51 | 06-22 | Elevation of privilege | optional sidecar dependency in the default image | low | mitigate | extra only; dependency boundary test | closed |
| T-06-52 | 06-23 | Tampering | translation altering identifiers | high | mitigate | protected-token post-check on every translated variant (plan 06-16) | closed |
| T-06-53 | 06-23 | Information disclosure | shares of another tenant steering translation | high | mitigate | shares read with the request's scope key only; per-tenant cache key | closed |
| T-06-54 | 06-24 | Information disclosure | undated rows from another tenant | critical | mitigate | the flag only widens the date predicate inside the tenant predicate; PGlite two-tenant case | closed |
| T-06-55 | 06-25 | Tampering | HyDE false answers | high | mitigate | rerank and refusal read only the standalone query and its similarity; no-answer fixture case | closed |
| T-06-56 | 06-26 | Elevation of privilege | framework choosing or widening the tenant scope | critical | mitigate | scope bound in the closure on the server; port exposes no scope-bearing field; port types contain no TenantScope (guard gate) | closed |
| T-06-57 | 06-26 | Denial of service | duplicate searches per leg | low | mitigate | memo per variant index; one RPC per variant | closed |
| T-06-58 | 06-27 | Tampering | forged history steering the rewrite | medium | mitigate | history bounded to 6 turns of 1,000 characters, markup stripped, rendered as a data block; rewrite output only becomes query text | closed |
| T-06-59 | 06-27 | Denial of service | oversized history or time zone | low | mitigate | caps in buildHistoryWindow; embed timeZone length limit; invalid zone resolves to UTC | closed |
| T-06-60 | 06-27 | Information disclosure | small talk bypassing strict mode to leak documents | low | mitigate | small talk skips retrieval, so no document context exists to leak | closed |
| T-06-61 | 06-28 | Tampering | oversized or forged history | medium | mitigate | Zod caps (6 turns, 1,000 characters, user or assistant only); existing key and signed scope-token checks unchanged | closed |
| T-06-62 | 06-28 | Denial of service | voice latency regression | medium | mitigate | 300 ms condense timeout, banned heavy transforms, budget test | closed |
| T-06-63 | 06-29 | Elevation of privilege | eval overrides reaching production profiles | high | mitigate | overrides built only in the eval route and applied only for the eval profile (plan 06-19 test); eval endpoint keeps its secret and environment gate | closed |
| T-06-64 | 06-29 | Information disclosure | secrets in run configs | medium | mitigate | the overlay allow-list admits only RAG_PIPELINE and RAG_* switch names; keys are rejected | closed |
| T-06-65 | 06-30 | Information disclosure | cross-tenant RedisVL hit | critical | mitigate | every check filtered by tenant_key and key_hash tags built by redisvl's filter builder from regex-validated values; one index per profile | closed |
| T-06-66 | 06-30 | Spoofing | unauthenticated cache writes | high | mitigate | existing shared-secret middleware covers /v1/cache/*; 422 on malformed bodies | closed |
| T-06-67 | 06-30 | Information disclosure | REDIS_URL in logs | medium | mitigate | SecretStr; never logged; empty placeholder in the env template | closed |
| T-06-68 | 06-31 | Information disclosure | transcripts sent to the app | low | accept | the same transcripts already go to the app and the agent's LLM today; history is capped and sent only when the switch is on and the server confirms it condenses | accepted — owner sign-off pending |
| T-06-69 | 06-32 | Information disclosure | hit across tenants, entry profiles, prompts or configs | critical | mitigate | lookup scoped by TenantScope and profile id; key hash covers language, mode, model, config hash with query-layer part, framework, entry profile and prompt template hash | closed |
| T-06-70 | 06-32 | Tampering | stale or unsafe hit | high | mitigate | bypass rules before check; source re-validation inside check; citations re-resolved against current sources, unresolved means miss; fail-open miss on any error | closed |
| T-06-71 | 06-32 | Denial of service | cache latency | low | mitigate | 150 ms timeout, standalone vector reused so the cache adds no extra embedding | closed |
| T-06-72 | 06-33 | Tampering | prompt drift breaking strict mode | medium | mitigate | instruction appended after the wrapper, never inside RAG_SYSTEM_PROMPT; byte-identical tests for every mode when languages match | closed |
| T-06-73 | 06-34 | Information disclosure | query text in reports | low | mitigate | sections hold counts, rates and latencies only | closed |
| T-06-74 | 06-35 | Elevation of privilege | LangChain input choosing a scope | critical | mitigate | no scope, tenant key or filter is ever passed; capture retrievers return nothing; retrieval only through the server-bound port (plan 06-37); spy test | closed |
| T-06-75 | 06-35 | Information disclosure | LangSmith tracing or Hub pulls | medium | mitigate | callbacks [], explicit baseURL, vendored prompts; fetch spy proves no Hub call | closed |
| T-06-76 | 06-35 | Tampering | unvalidated LangChain output | medium | mitigate | provider JSON Schema plus zod/v3 safeParse at the boundary | closed |
| T-06-77 | 06-36 | Tampering | poisoning through instructions in the message or history | high | mitigate | store only history-free turns whose raw message equals the standalone query; key includes entry profile and prompt hash; embed check-only by default (A-3) | closed |
| T-06-78 | 06-36 | Information disclosure | unreliable or personal answers stored | high | mitigate | store after the groundedness label, never possibly_unreliable; personal-data, ghost and tool bypasses | closed |
| T-06-79 | 06-36 | Repudiation | cached answers indistinguishable from fresh ones | low | mitigate | cache: 'hit' and the original trace id in the message metadata; a hit writes its own Phase 5 answer record and answerId | closed |
| T-06-80 | 06-37 | Elevation of privilege | LangChain retrieving outside the tenant | critical | mitigate | LegRetrievers can only call the server-created port whose scope is bound in its closure; boundary rule; two-tenant LangChain case in plan 06-42 | closed |
| T-06-81 | 06-37 | Tampering | lost citation targets from content-keyed dedupe | medium | mitigate | chunk id as pageContent; duplicate-text test | closed |
| T-06-82 | 06-37 | Information disclosure | LangSmith telemetry | medium | mitigate | callbacks [], config warning on tracing variables | closed |
| T-06-83 | 06-38 | Information disclosure | real customer data in fixtures | medium | mitigate | synthetic placeholder items only; the existing fixture PII test runs on the file | closed |
| T-06-84 | 06-38 | Repudiation | silent baseline drift | medium | mitigate | per-item jq proof against the pre-change baselines in both modes | closed |
| T-06-85 | 06-39 | Repudiation | a threshold fitted on test pairs | medium | mitigate | same-split pairs; calibration reads dev only and checks test once (plan 06-41) | closed |
| T-06-86 | 06-40 | Elevation of privilege | non-admin clearing caches | high | mitigate | S7 guard first (checkAdmin or requireAdminOrDeny), fail closed, forged-cookie and bearer tests | closed |
| T-06-87 | 06-40 | Tampering | malformed tenant key in the body | medium | mitigate | parseTenantKey plus the SQL guard | closed |
| T-06-88 | 06-40 | Information disclosure | secrets in the status response | medium | mitigate | the endpoint returns booleans, distances and warning codes only | closed |
| T-06-89 | 06-41 | Information disclosure | wrong answers for near-miss questions | high | mitigate | zero near-miss wrong-hit gate on dev and test; protected-token and date bypasses | closed |
| T-06-90 | 06-41 | Tampering | eval writes reaching production tenants | high | mitigate | the eval scope comes from evalScope with RAG_EVAL_ALLOWED_SCOPES; every eval entry is in the eval key namespace, which no chat or embed lookup can match (single-tenant test) | closed |
| T-06-91 | 06-42 | Information disclosure | cross-tenant cache hit or retrieval through the query layer | critical | mitigate | canary cases on the real SQL and adapters for every invalidation event and key part; matrix rows for both frameworks | closed |
| T-06-92 | 06-43 | Tampering | regressions merged without the cache gate | medium | mitigate | required CI steps checked by check-workflows | closed |
| T-06-93 | 06-44 | Repudiation | a verdict without its evidence | medium | mitigate | the report records every run, check and number; the tool validates it against PhaseComparison | closed |
| T-06-94 | 06-45 | Elevation of privilege | a revoke lost in folding | high | mitigate | per-mode equality with the migrations, grant and overload assertions | closed |
| T-06-95 | 06-46 | Tampering | one-way migrations on live data | high | mitigate | backup first, overload check, parity run right after | **open** (06-46 live check not run) |
| T-06-96 | 06-46 | Information disclosure | keys or customer content in verification notes | high | mitigate | SUMMARY records numbers and verdicts only; no query, rewrite, chunk text, document name or tenant id | **open** (06-46 live check not run) |
| T-06-97 | 06-46 | Information disclosure | anon or authenticated reaching the new functions or the cache table | critical | mitigate | Task 1 refuses anon-key and authenticated-JWT calls to every new function (language shares, hybrid search and all five rag_cache_ functions), refuses table reads and writes on rag_semantic_cache, and checks has_table_privilege and has_function_privilege | **open** (06-46 live check not run) |
| T-06-98 | 06-46 | Information disclosure | real questions sent to OpenRouter and stored in Redis | medium | accept | the user chooses the environment and tenants; the layer and cache stay off by default | accepted — owner sign-off pending |
| T-06-99 | 06-30 | Tampering | stale cached refusal in Redis after a new upload | medium | mitigate | refusals are never stored in RedisVL (422 on store, app adapter never sends them); pgvector keeps refusals with same-transaction trigger invalidation | closed |
| T-06-100 | 06-21 | Tampering | a cached RedisVL refusal surviving a new upload, publish or delete | medium | mitigate | refusals never stored or served by the RedisVL adapter (unit tests); the sidecar also rejects them (plan 06-30) | closed |
| T-06-101 | 06-12 | Information disclosure | document names of another tenant through rag_cache_resolve_sources | high | mitigate | guard first, tenant_key equality plus current and ready filter, service-role only, two-tenant case | closed |
| T-06-102 | 06-17 | Information disclosure | an answer about one user's attached or mentioned document, or built with non-default retrieval options, served to a colleague in the same tenant | high | mitigate | document_refs and retrieval_options bypass at check and store, so such turns never read or write the cache; route tests in plan 06-36 | closed |
| T-06-103 | 06-17 | Tampering | eval-written entries served to chat or embed users | high | mitigate | eval is its own entry profile and key namespace in the hash; eval passes the profile rule only with the eval override; seed answers refused in production (plan 06-41) | closed |
| T-06-104 | 06-32 | Information disclosure | attachment, mention or non-default-option answers shared, or eval entries reaching chat | high | mitigate | document_refs and retrieval_options bypass before check; entry profile derived from input.profile, never from caller data; single-tenant eval-versus-chat namespace test | closed |
| T-06-105 | 06-36 | Information disclosure | a colleague in the same tenant served an answer about another user's attached or mentioned document | high | mitigate | document_refs and retrieval_options bypass (plans 06-17, 06-32); same-tenant and two-tenant route tests with positive controls | closed |
| T-06-106 | 06-36 | Repudiation | a cache hit leaving no answer record, citation snapshot or feedback target | medium | mitigate | scheduleAnswerFinish on hits with citations re-resolved against current sources; route test | closed |
| T-06-107 | 06-41 | Tampering | caller-supplied seed answers stored on a production deployment | high | mitigate | cache_seed_answer refused with a structured 403 whenever NODE_ENV is production, before any retrieval or store; test | closed |
| T-06-108 | 06-28 | Information disclosure | another tenant's or session's history reaching query rewriting or retrieval | critical | mitigate | Isolation comes from the verified scope token, which alone sets the retrieval scope. The per-turn binding only prevents accidental cross-session mixing by the agent and does not authenticate history (a caller holding the internal key and a valid token can bind any text). Mismatched or unbound turns are dropped before the query layer, and a token refresh drops earlier turns, falling back to the original query. Two-tenant and refresh tests | closed |
| T-06-109 | 06-31 | Information disclosure | the agent mixing turns from two sessions or tenants | high | mitigate | every turn keeps its session token's binding from record time, and the server drops turns whose binding differs (plan 06-28). This only prevents accidental mixing and does not authenticate history; isolation comes from the verified scope token. After a token refresh, earlier turns are dropped and condensing falls back to the original query | closed |
| T-06-110 | 06-02 | Information disclosure | REDIS_URL credentials shown in the Config UI | medium | mitigate | REDIS_URL is in SECRET_VALUE_NAMES, so maskConfig never returns its value and an empty field means unchanged; node test | closed |
| T-06-111 | 06 (W-1) | Tampering / cache integrity | semantic cache ignored request retrieval filters (a filtered answer or refusal could be served to an unfiltered question within one tenant) | medium | mitigate | Closed by commit ac27468e on `exec/quick-06-cache-gaps`: any request filter now bypasses the cache (check and store). Registered by owner decision 2026-11-28 | closed |
| T-06-SC (06-22) | 06-22 | Tampering | LangChain/RedisVL installs | high | mitigate | exact pins, 7-day age cutoff, lockfile integrity hashes, no install scripts | closed (see W-5: procedural deviation, owner to confirm) |
| T-06-SC (other 45 plans) | 06-01…06-46 except 06-22 | Tampering | npm/pip/cargo installs | low | accept | no package installed (36 SUMMARYs `added: []`; `uv lock --check` and `npm ls --package-lock-only` clean) | accepted — owner sign-off pending |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low. Only open threats at or above `block_on: high` count toward threats_open.*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

### Evidence for the critical and high tenant-isolation threats (auditor, file:line)
- T-06-07/08 (language shares): `0601:19,28,38-39`; `kb-languages.ts:58`; `language-shares.test.mts:138-251`.
- T-06-13/14/54 (undated widening of `hybrid_search_chunks`):
  - `0602:10-13,121-140,222-230`; the newest body is `0930:220-231,391-396`.
  - Tests: `hybrid-include-undated.test.mts:105,141,158`, `hybrid-grants.test.mts:93` and `query-dates-undated.test.mts`.
- T-06-21/22/101 (pgvector cache):
  - `0603:29-32,44,95,109-117,133-137,166,231,250-269,276-341`.
  - Tests: `semantic-cache.test.mts:527-600`, `semantic-cache-canary.test.mts` and `semantic-cache-invalidation.test.mts:118-262`.
- T-06-45/65/66 (cache adapters and RedisVL): `pgvector.ts:42,63,77`; `redisvl-http.ts:45-48,95,130`; `rag_sidecar/cache/service.py:58-61,70,176`; `auth.py:39-46`; `test_cache_service.py:238,313`; `test_cache_endpoints.py:80,120`.
- T-06-37/39/74/80 (framework fence):
  - `check-rag-boundary.mjs:222-262,565,625` (passes), `langchain/capture.ts:16-19` and `langchain/ensemble.ts:20-37`.
  - Tests: `v2-two-tenant-matrix.test.mts:972,1008`.
- T-06-44/56/69/104 (scope never comes from variants or the request): `v2/port.ts:57-95,137-178`; `query/port-types.ts:1-51`; `cache/keys.ts:6-15,48-67`; `run-layer.ts:260,363-398`; `v2/pipeline.ts:182-196`.
- T-06-86 (admin clear): `api/rag/admin/semantic-cache/route.ts:18-19`; `semantic-cache-admin-route.test.ts:185-243`.
- T-06-108/109 (voice): `internal/voice-rag/route.ts:39-63,187-205`; `voice-rag-two-tenant.test.ts:133-163`; `voice-agent/src/voice_agent.ts:65,161-172`.
- T-06-94 (folded setup): `tests/rag-db/schema-equality.test.mts:331-336,617-673`.

---

## Accepted Risks Log

AR-06-01 through AR-06-05 were signed by the owner in person in the orchestrator session on 2026-11-28T07:14:00Z ("全部签"), confirmed again at 07:57Z; recorded here by a subagent on the owner's instruction. All are below the `high` threshold, so none of them blocks. For AR-06-05 the owner also confirmed the 06-22 install decision. The owner confirmed the bge-m3 Hugging Face revision `5617a9f61b028005a4858fdac845db406aefb181` (`src/lib/rag/embeddings/bge-m3.ts` `BGE_M3_SIDECAR_REVISION`, `rag-sidecar/src/rag_sidecar/embed/bge_m3.py`); confirmed_at 2026-11-28T07:14:00Z.

| Risk ID | Threat Ref | Rationale (from the plan) | Accepted By | Date |
|---------|------------|---------------------------|-------------|------|
| AR-06-01 | T-06-SC (45 plans) | No package installed. Only the 06-22 set is new, and both lock checks pass. Caveat: the clone is shallow, so lockfile changes were not traced to individual commits. | accepted_by: "owner (signed in person in the orchestrator session, 2026-11-28)" | accepted_at: 2026-11-28T07:14:00Z |
| AR-06-02 | T-06-42 (06-19) | Small talk skips retrieval only under the layer; the model answers without knowledge-base context. | accepted_by: "owner (signed in person in the orchestrator session, 2026-11-28)" | accepted_at: 2026-11-28T07:14:00Z |
| AR-06-03 | T-06-68 (06-31) | Voice transcripts already reach the app and the agent's LLM. History is capped and sent only with `VOICE_SERVER_QUERY_REWRITE=true`. | accepted_by: "owner (signed in person in the orchestrator session, 2026-11-28)" | accepted_at: 2026-11-28T07:14:00Z |
| AR-06-04 | T-06-98 (06-46) | During the live runs, real questions go to OpenRouter and Redis. The owner chooses the environment and the tenants; the layer and the cache stay off by default. | accepted_by: "owner (signed in person in the orchestrator session, 2026-11-28)" | accepted_at: 2026-11-28T07:14:00Z |
| AR-06-05 | W-5 (06-22) | Procedural deviation: the install ran on 2026-11-26 instead of "not before 2026-12-04", and the executor ran it instead of the orchestrator. The SUMMARY cites an owner decision that this audit cannot verify. | accepted_by: "owner (signed in person in the orchestrator session, 2026-11-28)" | accepted_at: 2026-11-28T07:14:00Z |

---

## Findings outside the register (auditor notes; not counted in threats_open)

| ID | Suggested severity | Finding | Fix suggestion |
|----|--------------------|---------|----------------|
| W-1 | medium (registered as T-06-111, closed by ac27468e) | Client-supplied `retrievalFilters` are neither in the semantic cache key nor a bypass reason. That covers `dateRange`, `sources`, `documentIds`, `docTypes`, `languages`, `invoice`, `scopes` and `attributes`, accepted at chat route `:1346-1355,2298` and embed route `:306-315,431`. `cacheKeyFilterParts` (`cache/keys.ts:35`) is defined and tested, but `run-layer.ts:390-399` never calls it; `requestRetrievalConfigHash` does not hash the filters, and `checkRules` (`bypass.ts:126-139`) only tests `versionScope` (orchestrator confirmed). Effect, within one tenant: a filtered answer or filtered refusal (pgvector stores refusals for 600 s) can be served to an unfiltered question, and the reverse. No cross-tenant path: the tenant key and the access-group set hash are both in the key. | Add a `retrieval_filters` bypass at check and store time whenever any request filter is set, or hash the normalised filters (via `cacheKeyFilterParts` plus the remaining fields) into the key. Add a test pair where a filtered and an unfiltered request with the same text must not share an entry. Owner decides whether to register it as T-06-111. |
| W-2 | low | The generated Zod `CachedAnswerSchema` does not carry Pydantic's `_storable` rule (`possibly_unreliable`/`pending`). The TypeScript store path relies on `store-after.ts:111-128` and `bypass.ts:157` alone. | Express `_storable` as a JSON-Schema constraint so `gen:schemas` carries it, or add a Zod refinement in the store path. |
| W-3 | info | HyDE skips the protected-token check by design (A-10); it stays dense-only (T-06-30). | none |
| W-4 | low | Decompose output allows up to 16 questions (`decompose.ts:11-17`) before the D-15 cut to 4, while T-06-01 states lists are bounded at 4. | Lower the schema cap to 4, or correct the threat text. |
| W-6 | low | Cache calibration exists only for `fixture-ngram`. Production profiles use `RAG_SEMANTIC_CACHE_MAX_DISTANCE=0.05` until the live calibration (06-46 Task 4). | Run `rag_eval.calibrate cache --write --check` live before turning the cache on. |
| W-7 | info | T-06-93 names `PhaseComparison`; the report validates against `SwitchComparison`. | Naming fix only. |
| W-8 | low | RedisVL invalidation fires only on publish and soft delete. Scope-tag, effective-date, approval and attribute writers (`ingest/scopes/admin.ts:238`, `versions/effective-dates.ts:339,457`, `approval/admin.ts:279`, migration 1005) invalidate pgvector only, so a RedisVL entry can stay stale for up to the TTL. The verifier counts this as gap 2 against CACHE-01. | After each of those writers succeeds, call `redisvlInvalidationTarget()?.invalidateTenant(scope, ids)` the way `publish.ts:118-125` does, and add fake-backend tests. |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-28 | 156 register rows (110 numbered ids + 46 per-plan T-06-SC) | 105 mitigate closed; 48 accepted (pending owner sign-off) | 3 (T-06-95, T-06-96, T-06-97; all blocking) | gsd-security-auditor (opus), orchestrated by /gsd-secure-phase on verify/06 |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in the Accepted Risks Log (AR-06-01..05 signed by the owner 2026-11-28)
- [ ] `threats_open: 0` confirmed (blocked on 06-46 Task 1)
- [ ] `status: verified` set in frontmatter

**Approval:** pending (owner only)

**GSD > PHASE 06 SECURITY BLOCKED.** 3 blocking threats are open, so the phase cannot advance until `threats_open: 0`.
▶ Owner: run 06-46 Task 1 on a test project and write 06-46-SUMMARY, then re-run `/gsd-secure-phase 06`.
▶ Owner: sign AR-06-01 to AR-06-05 above, or reject them.
