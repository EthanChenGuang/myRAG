---
phase: 02-unified-retrieval-pipeline-tenant-scope
reviewed: 2026-11-23T23:19:12Z
depth: standard
files_reviewed: 46
files_reviewed_list:
  - src/lib/rag/index.ts
  - src/lib/rag/types.ts
  - src/lib/rag/deps.ts
  - src/lib/rag/config.ts
  - src/lib/rag/pipeline.ts
  - src/lib/rag/backend/supabase-rpc.ts
  - src/lib/rag/legacy/enhanced-retrieval.ts
  - src/lib/rag/query/temporal-query-detector.ts
  - src/lib/rag/context/assemble.ts
  - src/lib/rag/context/fetch-rows.ts
  - src/lib/rag/context/overview.ts
  - src/lib/rag/context/voice.ts
  - src/lib/rag/context/media.ts
  - src/lib/rag/refs/resolve.ts
  - src/lib/rag/voice/keyword-fallback.ts
  - src/lib/rag/rerank/local-hybrid.ts
  - src/lib/rag/embeddings/openai.ts
  - src/lib/rag/generation/prompt.ts
  - src/lib/rag/generation/messages.ts
  - src/lib/rag/tenant/scope.ts
  - src/lib/rag/tenant/resolve-chat.ts
  - src/lib/rag/tenant/membership.ts
  - src/lib/rag/tenant/embed.ts
  - src/lib/rag/tenant/eval.ts
  - src/lib/rag/tenant/voice.ts
  - src/lib/rag/tenant/voice-token.ts
  - src/lib/rag/tenant/admin.ts
  - src/lib/rag/tenant/repair-owner.ts
  - src/lib/rag/trace/collector.ts
  - src/lib/rag/trace/config.ts
  - src/lib/rag/trace/finish.ts
  - src/lib/rag/trace/langfuse.ts
  - src/lib/rag/trace/log.ts
  - src/lib/rag/trace/mask.ts
  - src/lib/rag/trace/sample.ts
  - src/lib/rag/trace/schedule.ts
  - src/app/api/chat/route.ts
  - src/app/api/embed/chat/route.ts
  - src/app/api/internal/voice-rag/route.ts
  - src/app/api/internal/voice-chat/route.ts
  - src/app/api/internal/rag/run/route.ts
  - src/app/api/livekit/token/route.ts
  - src/app/api/generate-image/route.ts
  - src/app/api/generate-video/route.ts
  - voice-agent/src/agent.ts
  - voice-agent/src/participant_scope.ts
  - voice-agent/src/rag_client.ts
  - voice-agent/src/voice_agent.ts
  - src/lib/document-processor.ts
  - src/lib/ui-stream-chunks.ts
  - scripts/ci/check-rag-boundary.mjs
  - scripts/ci/check-node-runtime.mjs
  - .github/workflows/pr-smoke.yml
  - .github/workflows/nightly.yml
  - eval/src/rag_eval/paired.py
  - eval/src/rag_eval/gate.py
  - eval/src/rag_eval/metrics.py
  - eval/src/rag_eval/baseline.py
  - eval/src/rag_eval/online_judge.py
  - eval/src/rag_eval/langfuse_api.py
  - eval/src/rag_eval/review_queue.py
findings:
  critical: 3
  warning: 11
  info: 7
  total: 21
  necessity: 0
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-11-23T23:19:12Z
**Depth:** standard
**Files Reviewed:** 46 primary files (61 listed, including supporting files read for cross-checks)
**Status:** issues_found
**Diff range:** `e9d1390..HEAD` (HEAD `695c2e1`), restricted to `src voice-agent scripts eval rag-sidecar next.config.js .github`. The `fix(security):` commits are covered by a separate reviewer and were only read where they touch the RAG pipeline or tenant scope.

**Severity mapping.** The caller asked for Critical/High/Medium/Low/Info. The GSD frontmatter keys map as follows: `critical` = Critical + High (BLOCKER, must fix before ship), `warning` = Medium + Low, `info` = Info. Breakdown: Critical 1, High 2, Medium 5, Low 6, Info 7.

## Summary

The `src/lib/rag/` core is in good shape. The TenantScope brand, the scope resolvers (chat, embed, voice token, eval), the stage runner, the status derivation, the single-query assembly and the trace collector all hold up when traced. Every vector search and keyword query in the module takes a minted scope. Document-reference reads are predicated. Rows are fetched by id only after a scoped search. The boundary check and the config drift check both pass (`node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`).

The serious problems sit at the edges of the module:

1. **The tenant predicate can still be bypassed at the database (CR-01).** `match_documents_by_workspace` is SECURITY DEFINER, anyone with the public anon key can execute it, and it trusts the caller's `p_org_id` and `p_user_id`. The pipeline's text, embed and eval search calls it through the anon client. That makes the deferred "revoke anon grants" fix a breaking change as well.
2. **The shared voice room lets a second participant overhear the active user's tenant answers (HI-01).** The one-user rule is checked only when the token is minted, the check fails open, and the agent broadcasts its data and audio to everyone in the room.
3. **The strongest tenant and parity tests never run in CI (HI-02).** Five `.test.mts` suites are left out of every workflow: two-tenant isolation through the real SQL, the D-17 query count, and the legacy and assembly differentials. They pass locally (25/25) but protect nothing on PRs.

The Medium findings cover two problems. First, switches and failure modes break the strict refusal and web-search contracts (MD-01, MD-02). Second, three follow-ups from the paused notes are still open (MD-03, MD-04, MD-05).

Necessity rubric (`.claude/gsd-core/references/necessity-review.md`) was read. The only candidate was the eval-only `stageOverrides` path. Tests exercise it, which makes it a test seam rather than a necessity finding, so it is recorded as a spec gap (IN-01).

### Known follow-ups (`.planning/paused/followups-notes.md`) status

| Follow-up | Status | Where |
| --- | --- | --- |
| 02-31 webhook signature compare not constant-time | **Fixed** (`crypto.timingSafeEqual`) | `src/lib/whatsapp/base-client.ts:38` |
| 02-12 org owner without `organization_members` row gets 403 | **Partially fixed**: repair runs in chat, images, documents and ai-to-rag, but not in LiveKit token or the media routes | MD-04 |
| 02-18 chat-input image/video fetches send no `organizationId` | **Still open** | MD-03 |
| 02-16 (a) voice keyword step selects unused `embedding` | **Still open** | LO-03 |
| 02-16 (b) single-tenant dedupe quirk | Still present, kept on purpose for snapshot parity | `src/lib/rag/pipeline.ts:593-596`, `keyword-fallback.ts:153` |
| 02-16 (c) TS2790 in semanticRerank | **Fixed** (plain `tsc --noEmit` gate) | n/a |
| 02-16 (d) single-tenant voice-chat save | **Fixed** via the `act` claim; anonymous single-tenant sessions still get 400 `Missing userId`, the same as before the phase | `voice-chat/route.ts:139-144` |
| 02-22 add `rag-langfuse-export` to pr-smoke | **Fixed** | `pr-smoke.yml:44` |
| 02-17 check-workflows `uv run --all-extras --frozen` | Not changed; `uv run` is inexact by default, so extras from the preceding `uv sync --locked --all-extras` stay installed. No defect found | `pr-smoke.yml:62` |
| 02-12 tenant-scope the no-query overview search; remove dead imports | **Fixed** (overview runs through `runOverviewPipeline` with the scope) | `pipeline.ts:344-425` |
| 02-13 text+document array collapsed to text | **Still open** | MD-05 |
| 02-13 characterize-chat mocks thinking-rag-enhancer | **Fixed** (no test references the retired modules) | n/a |
| 02-23 `createUIMessageStream` `onFinish` metadata ignored by the SDK | **Still open** (pre-existing) | IN-05 |
| 02-14, 02-17 human or live checks | Not code; still pending live verification | n/a |

## Critical Issues

### CR-01 (Critical): Tenant predicate bypassable at the database; the pipeline's text search depends on the anon grant that allows it

**File:** `src/lib/rag/pipeline.ts:487`, `src/lib/rag/deps.ts:205`, `src/lib/rag/backend/supabase-rpc.ts:80-89`, `supabase/multi-tenant-setup.sql:694-738`
**Issue:** `match_documents_by_workspace` is `SECURITY DEFINER`, is granted `EXECUTE` to `anon` and `authenticated`, and takes the tenant only from its `p_org_id` and `p_user_id` arguments. It never consults `auth.uid()` or membership. The anon key is public, since it ships to the browser as `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Anyone can therefore `POST /rest/v1/rpc/match_documents_by_workspace` with another organization's UUID, or another user's UUID with `p_org_id: null`, plus any 1536-dim vector, and read that tenant's chunks.

The phase success criterion ("only searches a server-verified tenant") holds inside the Node process but not at the storage boundary. The phase also entrenches the problem. `legacySearch` is the chat, embed and eval search path, and it calls the RPC through `deps.anonClient()`. Voice, media and overview already use the admin client. Revoking the anon grant, the fix deferred in 02-CONTEXT "Deferred Ideas", would now break text chat retrieval.

This bypass is pre-existing and the fix was explicitly deferred. It is listed as Critical because cross-tenant leakage is the project's stated worst failure, and because this phase made the eventual fix harder.
**Fix:** Search with the service-role client everywhere, the same way voice, media and overview do. Then revoke direct execution in SQL:
```ts
// src/lib/rag/pipeline.ts (legacySearch call)
const admin = deps.adminClient();
if (!admin) throw new Error('[RAG Search] admin client unavailable');
legacySearch({ ..., client: admin as unknown as RpcClient, signal: stageSignal })
```
```sql
REVOKE EXECUTE ON FUNCTION public.match_documents_by_workspace FROM anon, authenticated;
```
If a client-callable variant is ever needed, derive the user from `auth.uid()` and check `is_org_member()` inside the function.

### HI-01 (High): Shared fixed voice room lets a second participant overhear the active user's tenant answers

**File:** `src/app/api/livekit/token/route.ts:7,25-37,60-87`; `voice-agent/src/agent.ts:287-296,318-331`; `voice-agent/src/participant_scope.ts:13-33`
**Issue:** Every token joins the same room (`myrag-voice`) with default subscribe rights. The "one active user" rule is enforced in two places, neither of which stops a second participant from listening:

1. At mint time, `anotherUserInRoom()` is a time-of-check-to-time-of-use (TOCTOU) check. Two users who mint while the room is empty both receive tokens. A token minted now can also be used to join later, because the LiveKit JWT TTL defaults to hours. The check also fails open: if `listParticipants` throws, it returns `false`.
2. In the agent, `ActiveUserGuard` only stops the agent from answering the second user's audio.

The agent still publishes its TTS audio track to the room. It also broadcasts every transcription with `publishData(data, { reliable: true })`, which carries no `destinationIdentities`. A second participant therefore hears and receives the text of answers drawn from the first user's organization or personal knowledge base, plus the first user's own transcripts.

In multi-tenant mode an anonymous caller also gets a room token (`user-anon-…`, no scope), so no session is needed to eavesdrop. The first user's `rag_scope_token` sits in participant metadata, which LiveKit sends to every other participant. It is not usable without `x-api-key`, but it should not be distributed.

This undermines the D-10 adjustment ("a second concurrent user gets 'voice busy' instead of borrowing the first user's tenant"). The second user is not served with the first user's scope, but does receive the first user's content.
**Fix:** Pick one, in order of preference:
- Give each session its own room, named server-side (`voice-${randomUUID()}`), and use explicit agent dispatch. This was deferred, but it is the only complete fix.
- Interim: in the agent, publish data only to the active participant (`publishData(data, { reliable: true, destinationIdentities: [activeUserGuard.active] })`). Restrict subscription to the agent's audio track to the active identity (`localParticipant.setTrackSubscriptionPermissions(false, [{ participantIdentity: active, allowAll: true }])`). Kick other `user-` participants via `RoomServiceClient.removeParticipant`. Refuse room tokens to callers with no session in multi-tenant mode. Fail closed when the participant listing errors. Set a short `ttl` on the `AccessToken`.
- Move the scope token out of participant metadata. Have the agent fetch it server-to-server with the internal key, keyed by participant identity.

### HI-02 (High): Two-tenant isolation, query-count and parity suites are not run in CI

**File:** `.github/workflows/pr-smoke.yml:43-44`; `vitest.config.ts` (`include: ['tests/**/*.test.ts']`)
**Issue:** Vitest only collects `*.test.ts`, and the tsx step names five `.test.mts` files explicitly. The following suites are therefore never executed by any workflow:
- `tests/rag-two-tenant.test.mts`: cross-tenant retrieval through resolved scopes and the real SQL on PGlite
- `tests/two-tenant-fixture.test.mts`
- `tests/rag-assemble-query-count.test.mts`: the D-17 constant-query-count proof at 5, 25 and 100 chunks
- `tests/rag-legacy-differential.test.mts`: legacy parity
- `tests/rag-assemble-differential.test.mts`

They pass locally (`node --import tsx --test …`: 25 tests, 25 pass, 0 fail). Without CI, a future change that drops the tenant predicate, reintroduces N+1 queries or breaks byte-identical assembly will not be caught. Tenant isolation is the top-ranked risk in PROJECT.md.
**Fix:**
```yaml
      - name: tsx tests
        run: node --import tsx --test tests/*.test.mts
```
Alternatively, list the five files explicitly. Add a `check-workflows.py` assertion that every `tests/*.test.mts` appears in a workflow step.

## Warnings

### MD-01 (Medium): Disabling the "optional" `assemble` stage silently bypasses strict refusal in chat and embed; voice ignores the switch

**File:** `src/lib/rag/config.ts:233-241`; `src/lib/rag/pipeline.ts:536-551,567-573,656-663`; `src/app/api/chat/route.ts:2151-2177`
**Issue:** `assemble` is listed in `OPTIONAL_STAGES`, so `RAG_DISABLED_STAGES=assemble` is accepted. For the `chat`, `embed` and `eval` profiles, a disabled stage records `disabled`, which D-05 says is not `degraded`. `assembly` is then `null`, and the status comes from `deriveStatus(records, candidates.length)`, which is `ok` whenever the search returned anything.

The chat route then sees `status: 'ok'` with `context === ''`. That becomes "No relevant context found." with zero `usedDocuments`. Because `shouldBlockNoContextResponse` requires `status === 'empty'`, the deterministic "information not available" refusal is skipped, and the LLM answers in strict mode with no knowledge-base context and no sources. Embed and media likewise proceed with empty context and `ok`.

In the voice pipeline, the same switch is ignored. Line 663 re-runs `assembleVoiceResults` outside the stage runner whenever the stage is skipped, so `disabled` has no effect. If `assembleVoiceResults` itself throws, the re-run throws a non-`StageError` out of `runRetrieval`, and voice-rag returns a 500 with the raw message.
**Fix:** Make `assemble` (and `post_filter` for chat) core for the assembly profiles, or reject it in `parseDisabled` for those profiles. At minimum, derive `status: 'degraded'` with reason `assemble_disabled` when `assembly === null` and candidates exist, so chat maps it to the knowledge-base-unavailable path. In voice, do not call `assembleVoiceResults` a second time outside `runStage`. If the voice wire shape requires a value, treat `assemble` as core for voice.

### MD-02 (Medium): A knowledge-base outage now hard-fails chat even with web search on, and in balanced and flexible modes

**File:** `src/app/api/chat/route.ts:2151-2170`
**Issue:** `retrievalFailed` ignores `webSearchEnabled` and `ragMode`. Before the phase, an RPC error was swallowed into "no context", and with web search on the request went on to Exa-backed answers (AGENTS.md section 14: "strict mode may use Exa-powered web search"). Now any `error` status, or `degraded` with no documents, returns only the localized "knowledge base is temporarily unavailable" error. This happens even when the user enabled web search, or chose `balanced` or `flexible`, which are allowed to answer from general knowledge.

D-06 specifies the error mapping, but it does not reconcile it with section 14. The result is that a Supabase or embedding outage now takes down web-search answers as well.
**Fix:** Keep the in-band error for `strict && !webSearchEnabled`. Otherwise, log under `[Document Search]`, flag the trace (`degraded`), and continue with `context = ''` so web search or general-knowledge modes still answer. If the stricter D-06 behaviour is intended, record that explicitly as an accepted deviation from AGENTS.md section 14.

### MD-03 (Medium): Image and video generation never send the workspace, so organization users get personal-workspace context (follow-up 02-18 still open)

**File:** `src/components/ui/chat-input.tsx:1692-1741` (image), `src/components/ui/chat-input.tsx:2022-2045` (video); server side `src/app/api/generate-image/route.ts:151,211-224`, `src/app/api/generate-video/route.ts:356,410-420`
**Issue:** The routes now resolve the scope from `organizationId`, but `chat-input.tsx` never sends it (`grep organizationId src/components/ui/chat-input.tsx` returns nothing). In multi-tenant mode, a user working in an organization workspace with "use context" on gets `u:<uid>` context. Their organization's documents are never used, and documents from their personal workspace can bleed into organization-branded output. This is not a cross-tenant leak, but it is the wrong tenant for the user's current workspace and a behaviour regression from the old global search.
**Fix:** Read `useOrganizationStore.getState()` the same way the voice components do. Append `organizationId` to the image form data and JSON body, and to the video JSON body, whenever `!isPersonalMode && currentOrganization?.id`.

### MD-04 (Medium): Owner-membership repair is missing on the LiveKit token and media routes (follow-up 02-12 partially fixed)

**File:** `src/app/api/livekit/token/route.ts:49-58`; `src/app/api/generate-image/route.ts:210-224`; `src/app/api/generate-video/route.ts:410-420`
**Issue:** `repairOwnerMembership` runs before `resolveTenantScope` in chat, images, documents and ai-to-rag, but not in these three routes. An organization owner with no `organization_members` row can chat in the organization, but gets 403 `not_a_member` when starting voice: the voice components now send `?organizationId=`. The same owner gets 403 on image or video generation once MD-03 is fixed.
**Fix:** Call `await repairOwnerMembership({ requestedOrganizationId, getUser })` immediately before each `resolveTenantScope` call. Better, fold the repair into a single `resolveTenantScopeWithRepair` helper so no new entry point can forget it.

### MD-05 (Medium): Document-part references never reach retrieval for text-plus-document messages (follow-up 02-13 still open)

**File:** `src/app/api/chat/route.ts:1670-1678` (and the client collapse at `src/app/page.tsx:1556-1600`)
**Issue:** An array user message with no `image_url` part is collapsed to plain text (`lastUserMessage.content = textPrompt`) before the RAG block. As a result, `documentParts` (`route.ts:1950-1957`) is empty for the normal "text plus attached document" message. The D-12 document-part path, including its tenant predicate, is effectively dead in production. The route test reaches it only through an `image_url` part with no URL (02-13-SUMMARY:154).
**Fix:** Extract `documentParts` from the original array content before the collapse, for example from `originalMessages` or `_originalContentParts`. Alternatively, keep `document` parts when collapsing. Record the user-visible change in the plan summary.

### LO-01 (Low): Voice token TTL is parsed differently from the shared helper; a bad value silently disables voice retrieval

**File:** `src/app/api/livekit/token/route.ts:72`
**Issue:** `parseInt(env.RAG_VOICE_TOKEN_TTL_SECONDS || '3600', 10)` returns `NaN` for a non-numeric value. `mintVoiceToken` then returns `invalid_ttl`, the route only warns, and it still issues a room token with no scope metadata. Every voice turn then gets 401 and the "can't reach the knowledge base" line. `defaultVoiceTtlSeconds()` already exists and falls back to 3600.
**Fix:** `ttlSeconds: defaultVoiceTtlSeconds()`, and return a 503 when `minted.ok === false` instead of issuing a scope-less room token.

### LO-02 (Low): Chat traces are dropped on two early returns, and `generation` is always recorded as `ok`

**File:** `src/app/api/chat/route.ts:2658`, `src/app/api/chat/route.ts:2704`, `src/app/api/chat/route.ts:3936-3939`
**Issue:** When `retrievalResult` is set, the OpenRouter key-check failure (2658) and the missing model provider path (2704) return without calling `finishRagTrace()`. Neither a `[RAG Trace]` line nor an export is produced for those requests, which breaks D-20's "one line per request". The `generation` stage is also recorded with `status: 'ok'` in `onFinish` even when the stream errored or the client aborted.
**Fix:** Call `finishRagTrace()` before both returns, or wrap the handler in `try { … } finally { finishRagTrace() }`. Record `generation` as `error` or `aborted` based on the `onFinish` event, for example `isAborted`.

### LO-03 (Low): Voice keyword fallback still selects the 1536-dim `embedding` column (follow-up 02-16a still open)

**File:** `src/lib/rag/voice/keyword-fallback.ts:223`
**Issue:** The third keyword query selects `id, document_id, content, metadata, embedding` with `limit 50` per batch. With up to 5 parallel batches in organization scopes (`DOCUMENT_BATCH_SIZE` 100, `MAX_SCOPE_DOCUMENTS` 500), that is up to 250 rows of about 1536 floats each, inside a 3 s voice stage budget (D-21 voice p95 of 800 ms). `enrichVoiceCandidates` discards the field, so it is never used.
**Fix:** Drop `embedding` from the select, and regenerate the voice characterization snapshot if it records the field.

### LO-04 (Low): Paired-difference report ignores `gate_population`

**File:** `eval/src/rag_eval/paired.py:87-102` vs `eval/src/rag_eval/metrics.py:94-104`
**Issue:** When approved `production` items exist, D-25 and `aggregate()` compute `overall`, `by_language` and `by_category` on production items only. `paired_report` still pairs every gate-split item for `overall` and `language:*`. The paired table attached to `gate.json` and `gate.md` can then report `all_zero: yes` or a mean difference for a different population than the one the gate judged.
**Fix:** Pass the population into `paired_report`: filter `gated_items` to `provenance == "production"` when `report.gate_population == "production"`.

### LO-05 (Low): User query content is logged unconditionally in retrieval hot paths

**File:** `src/lib/rag/voice/keyword-fallback.ts:148`, `src/lib/rag/refs/resolve.ts:48,68`
**Issue:** `console.log('[Document Search] Voice keyword search', { keywords })` runs on every voice turn and prints words taken from the user's question. `resolveDocumentRefs` prints each `@mention` name. These lines are new or re-homed code in `src/lib/rag/`. Project rules prohibit new unconditional logs in hot paths, and D-20 keeps query text out of logs.
**Fix:** Use `logger.db(...)`, which is silenced in production, or log only counts: `{ keywordCount: searchKeywords.length }` and `{ mentionCount }`.

### LO-06 (Low): `createEnhancedRAGPrompt` interprets `$` patterns in document text

**File:** `src/lib/rag/generation/prompt.ts:20`
**Issue:** `modeConfig.systemPromptWrapper.replace('{{context}}', context)` passes document content as a replacement string. In that position `$$` becomes `$` (LaTeX `$$…$$` display math), `` $` `` and `$'` splice in wrapper text, and `$&` inserts `{{context}}`. A document containing the literal `{{basePrompt}}` also captures the base prompt, because the second `.replace` runs on the already-substituted text. The behaviour is pre-existing, but it now lives in the shared module used by chat, embed and eval, and it alters context bytes fed to the model.
**Fix:**
```ts
return modeConfig.systemPromptWrapper
  .replace('{{basePrompt}}', () => cleanedBasePrompt)
  .replace('{{context}}', () => context);
```
Replacement functions are not pattern-expanded. Substituting the base prompt first keeps document text from hijacking the placeholder. Re-freeze the prompt snapshots if any fixture contains `$`.

## Info

### IN-01: Per-request stage overrides are implemented but unreachable from the eval endpoint (D-04 gap)

**File:** `src/lib/rag/pipeline.ts:166-188`; `src/app/api/internal/rag/run/route.ts:68-81`; `src/lib/rag-eval/contracts.generated.ts:37`
**Issue:** `stageSpec` honours `stageOverrides` only for `profile === 'eval'`, but the eval route never passes them and `RagRunRequest.options` has no field for them. D-04's "per-request overrides only via the eval endpoint" is reachable only from tests. Not a necessity finding: tests use it as a seam.
**Fix:** Add `disabled_stages` and `stage_timeouts` to the Pydantic `RagRunOptions`, regenerate the Zod schemas, and pass them through. Alternatively, record that D-04's per-request part is deferred.

### IN-02: Eval route fetches assembly rows twice

**File:** `src/app/api/internal/rag/run/route.ts:24-34,95`
**Issue:** The pipeline already fetched `documents` and `document_chunks` rows for the candidates in `post_filter`. The route fetches them again to fill `document_name` and `has_image`, doubling the per-request query count that D-17 holds constant.
**Fix:** Expose the rows (or a `documentName` map) on `RetrievalResult` for the eval profile, or derive `document_name` from `result.kept` and `result.usedDocuments`.

### IN-03: A non-numeric `RAG_FINAL_RESULT_COUNT` makes the search unbounded

**File:** `src/lib/rag/pipeline.ts:455`; `src/app/api/chat/route.ts` (`parseInt(env.RAG_FINAL_RESULT_COUNT || '25')`); `src/app/api/embed/chat/route.ts:182`
**Issue:** `parseInt('abc')` returns `NaN`. `NaN * 2` is serialized as `null` in the RPC JSON, and `LIMIT NULL` is unlimited in Postgres. The behaviour is pre-existing, and `env.ts` only defaults the unset case.
**Fix:** Parse once in `loadRagConfig` with validation (1 to 100) and a logged fallback to 25.

### IN-04: Langfuse compatibility assumptions to verify live

**File:** `src/lib/rag/trace/langfuse.ts:137-145`; `eval/src/rag_eval/langfuse_api.py:351-376`
**Issue:** There are two assumptions to check against a real Langfuse project.
- The root `rag-request` observation is started with a fabricated parent span ID so that it inherits the collector's trace ID, which makes the root a child of a span that never exists. Check in a real project that the trace renders as root plus stages, not as an orphan.
- `post_scores` treats anything other than 202 or 207 as fatal. That matches the current OpenAPI spec cited in 02-RESEARCH, but older self-hosted Langfuse versions answer 200 to a single score and 400 to an array. PROJECT.md wants self-hosting to need only the base URL and keys.
**Fix:** Add both items to the ROADMAP live-verification list. Treat a 200 response as accepted.

### IN-05: `onFinish` metadata in the chat UI stream is still discarded (02-23, pre-existing)

**File:** `src/app/api/chat/route.ts:3935-3980`
**Issue:** The `metadata` object returned from `createUIMessageStream({ onFinish })` (multi-step, reasoning, webSearch, documentSources) never reaches the client. Only `ragTraceId`, sent through `messageMetadata`, does. It also reads and deletes the process-global `lastReasoningDetails`, which is shared between concurrent requests.
**Fix:** Move these fields into `toUIMessageStream({ messageMetadata })` on the `finish` part, and key the reasoning details by request rather than storing them on `globalThis`.

### IN-06: The public embed endpoint accepts caller `system` messages and any model ID (pre-existing)

**File:** `src/app/api/embed/chat/route.ts:37-43,272-275`
**Issue:** `embedChatSchema` allows `role: 'system'`, and `model` is any string. An anonymous embed caller can append system instructions that override the RAG wrapper. They can also route the request to any OpenRouter model at the operator's cost, limited only by the per-IP rate limit.
**Fix:** Restrict roles to `user | assistant`, and allow-list `model` against the configured model list, falling back to the default.

### IN-07: voice-rag debug and error leakage (pre-existing)

**File:** `src/app/api/internal/voice-rag/route.ts:78-82,85-88`
**Issue:** `debug_info` is returned whenever the query contains the substring "debug", and the 500 path echoes `error.message`. The endpoint is internal and key-protected, so the impact is low.
**Fix:** Gate `debug_info` on `NODE_ENV === 'development'` only, and return a generic 500 body.

---

_Reviewed: 2026-11-23T23:19:12Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
