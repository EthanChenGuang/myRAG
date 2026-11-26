# 05-26 Task 1 results: Anthropic spike (partial: the API key was not reachable)

Run 2026-11-26 on branch `exec/05-26-t1`, cloud container, `npm ci --ignore-scripts`. Synthetic, domain-neutral documents only. No Supabase access of any kind.

## Blocker: `ANTHROPIC_API_KEY` was not in the process environment

The cloud environment lists `ANTHROPIC_API_KEY` among its variables, but the variable was not set in this container's shell (`[ -n "$ANTHROPIC_API_KEY" ]` was false). A request to `api.anthropic.com` without it returns 401, and the proxy injects no credential for that host. The variable was most likely added after this container started; environment variables take effect when a session starts. **Every step that needs a real Anthropic response is still open:** the model list (step 1), the direct Claude streams (step 2) and the A1 coexistence request (step 3b). The driver below already contains those runs. They switch on when the key is present:

```bash
export NODE_USE_ENV_PROXY=1 OPENAI_API_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9 NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder
curl -s https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"   # step 1
node --import tsx eval/out/05-26-t1/spike.mts anthropic   # step 2: 9 direct turns
node --import tsx eval/out/05-26-t1/spike.mts a1          # step 3b: raw SSE -> eval/out/05-26-t1/a1-raw.sse
```

The placeholder variables only satisfy `src/lib/env.ts` validation; nothing contacts Supabase or OpenAI. `NODE_USE_ENV_PROXY=1` is needed because Node's `fetch` otherwise skips the container proxy, and OpenRouter then answers 401 "Missing Authentication header".

## Driver

`eval/out/05-26-t1/spike.mts` (committed with `git add -f`, because `eval/out/` is gitignored). The chat route cannot run in-process without Supabase, so the driver runs the route's generation sequence on the real modules:

1. `createCitationSession` with route-shaped `facts`, then `attach({ blocks })`. The blocks are labelled by `createCitationLabeler`.
2. On a `claude-citations` turn: `claudeSystemPrompt`, `startClaude`, `toUIMessageStream`, then `firstTokenGate` with `CLAUDE_FIRST_TOKEN_TIMEOUT_MS` and `errorStatusOf`.
3. On a fallback: `session.fallback(reason)`, then OpenRouter `streamText` with `decorateSystemPrompt(createEnhancedRAGPrompt(...))` and `session.transforms()`.
4. `finishMetadata()`. The trace rule is built exactly as `route.ts:4384` builds it.

There are three synthetic blocks: Harbor notes (S1), Garden records (S2) and Bridge log (S3). S3 contains a planted `see [S9]`.

## Step 1: model ids

| Location | Ids | Result |
| --- | --- | --- |
| Mapping (env.ts, init-env.js and the other five locations; `check-config.mjs` enforces equality) | `anthropic/claude-opus-5.5` → `claude-opus-5-5`, `anthropic/claude-sonnet-5.5` → `claude-sonnet-5-5`, `anthropic/claude-haiku-5.5` → `claude-haiku-5-5` | `anthropicIdFor` resolves all three. The unmapped `anthropic/claude-sonnet-4.5` gives `no_anthropic_id` |
| OpenRouter `GET /api/v1/models` (live) | the three OpenRouter ids | **All listed**, which settles research A6 for the OpenRouter side. All three also streamed answers (below) |
| Anthropic `GET /v1/models` | the three anthropicIds | **Not verified** (401 without the key) |

Note: OpenRouter also lists `anthropic/claude-fable-5`, `-5.1` and `-5.2`. None of them is configured, so this needs no change. They are candidates for a later mapping.

## Step 2: per-model results

**Direct Claude path: not run (no key).** Its citation mapping, `cited_text` quotes, adaptive thinking and TTFT are unverified on real streams.

**OpenRouter, chunk-alias strategy, same questions (live).** All 9 turns used `strategy: chunk-alias`, and every marker resolved to the correct block, with that block's text as the quote:

| Model | Question | TTFT ms | Total ms | Citations → block | invalid |
| --- | --- | ---: | ---: | --- | ---: |
| opus-5.5 | plain | 2539 | 2552 | S1 Harbor notes, S3 Bridge log | 0 |
| opus-5.5 | reasoning (effort low) | 845 | 1997 | S1, S3 | **1** |
| opus-5.5 | zh | 2797 | 2812 | S2 Garden records | 0 |
| sonnet-5.5 | plain | 504 | 833 | S1, S3 | 0 |
| sonnet-5.5 | reasoning | 654 | 1335 | S1, S3 | 0 |
| sonnet-5.5 | zh | 504 | 934 | S2 | 0 |
| haiku-5.5 | plain | 1126 | 1336 | S1, S3 | 0 |
| haiku-5.5 | reasoning | 2354 | 2374 | S1, S3 | 0 |
| haiku-5.5 | zh | 1528 | 1753 | S2 | 0 |

TTFT is one sample per cell (report-only, D-23). The Anthropic column of the TTFT comparison is empty until the key is available.

**Invalid markers are dropped on a real stream.** In the opus-5.5 reasoning turn the model repeated the planted reference: *"The bridge log also says "see [S9]", but no source labelled S9 appears…"*. S9 names no block of the request, so it was not turned into a record and was counted (`invalidCitations: 1`). The labeler had neutralized the S9 in the block text with a zero-width space (`[S` U+200B `9]`), so the model wrote a new marker itself. A unit-level check confirms the same behaviour: `ingestFullText('… [S1]. … [S7].')` gives aliases `['S1']` and `invalidCitations: 1`.

## Step 3: webSearch and MCP turns are ineligible

Code reading:
- `route.ts:1960-1966` passes `webSearch: webSearchEnabled` and `mcp: useMcpForRequest || lastAssistantHasToolCall(rawMessages)` as facts.
- `claudeTurnEligibility` returns `web_search` while `CLAUDE_WEB_SEARCH_ELIGIBLE = false`, and `mcp` for MCP turns.

Unit-level call, for all three mapped models with the switch on and a placeholder key:

| Facts | Eligibility | Session strategy after `attach` |
| --- | --- | --- |
| plain | eligible (`claude-opus-5-5` / `claude-sonnet-5-5` / `claude-haiku-5-5`) | — |
| reasoning | eligible: all three ids match an adaptive-thinking prefix | — |
| webSearch | `web_search` | `chunk-alias` (OpenRouter) |
| mcp | `mcp` | `chunk-alias` (OpenRouter) |
| multiStep | `multi_step` | — |
| attachments | `attachments` | — |

**A1 (citations and server web search in one request): not run (no key).** The request is ready in `spike.mts a1`. It uses `claude-haiku-5-5`, max_tokens 512, one citations-enabled synthetic text document and a `web_search_20250305` tool with `max_uses: 1`. It saves the raw SSE and reports whether `citations_delta`, `server_tool_use` and `web_search_tool_result` all appear. `CLAUDE_WEB_SEARCH_ELIGIBLE` stays `false`, and no gap-closure plan is opened until A1 is recorded.

## Step 4: fallback with an unreachable `ANTHROPIC_BASE_URL`

`anthropicBaseUrl: http://127.0.0.1:9` was used with a placeholder key. Port 9 refuses the connection, so no request left the machine.

```json
"path": "anthropic->openrouter (error, after 49 ms)",
"strategy": "chunk-alias",
"fallbackReason": "error",
"traceRules": ["citation_strategy_fallback:error"],
"citations": [{"alias":"S1","documentName":"Harbor notes.txt"},{"alias":"S3","documentName":"Bridge log.txt"}],
"invalidCitations": 0
```

**Pass.** The turn fell back exactly once, in 49 ms. A connection error has no HTTP status, so the reason is `error`. The OpenRouter answer then streamed in 1.47 s TTFT with correct chunk-alias citations. With a placeholder key against the real host, the gate falls back with `status_401` (`citation_strategy_fallback:status_401`), which also confirms the status mapping on a real Anthropic error response.

## Defects and follow-ups

- **No code defect found** in the parts that could be exercised: eligibility, ineligible turns, the first-token gate, the one fallback, the trace rule, chunk-alias citation mapping and invalid-marker dropping on live OpenRouter streams.
- **Base URL without `/v1` (open question, not shown to be a defect).** This container sets `ANTHROPIC_BASE_URL=https://api.anthropic.com`, the Anthropic SDK convention, with no `/v1`. The direct path passes the value to `@ai-sdk/anthropic` unchanged, and that provider expects `.../v1`, so a deployment that inherits such a value would post to `/messages`. With a placeholder key both forms return 401, because auth is checked before routing, so whether this means "every turn falls back with 404" cannot be shown without a real key. The Config UI placeholder already says `https://api.anthropic.com/v1`. Rerun `spike.mts baseurl` with the key; if `withoutV1` falls back with `status_404`, a small gap-closure plan should normalize the value, for example by appending `/v1` when the path is empty.
- **Gap-closure plan needed now:** none. Whether webSearch turns can become eligible depends on A1.
- **To finish Task 1:** start a new session so the stored variable is present (or make the key otherwise available), then run the three commands above plus `spike.mts baseurl`. That is about 12 Anthropic requests and 1–3 OpenRouter fallbacks.

## Requests made

- api.anthropic.com: 3, all 401 with a placeholder or dummy key (1 `GET /v1/models`, 2 `POST /messages` in the base-URL check). No real key was used and nothing was billed.
- openrouter.ai chat completions: 13. 12 succeeded (9 comparison turns, 1 fallback turn, 2 base-URL fallback turns); 1 was rejected with 401 before the proxy setting was fixed.
- openrouter.ai metadata: 3 GETs (`/key` twice for the proxy check, `/models` once).
- Local: 2 connection attempts to 127.0.0.1:9 (the fallback test).

Total: 19 external requests.
