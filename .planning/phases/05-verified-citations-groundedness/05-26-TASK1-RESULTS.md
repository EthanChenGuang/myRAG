# 05-26 Task 1 results: Anthropic spike (complete)

First run 2026-11-26 without the key (OpenRouter, unit-level and fallback checks). Second run the same day, in a new session, with the owner's Anthropic key available to the session as `MYRAG_ANTHROPIC_API_KEY`. The key was passed inline to each process as `ANTHROPIC_API_KEY` and was never written to a file. Branch `exec/05-26-t1`, cloud container, `npm ci --ignore-scripts`. Synthetic, domain-neutral documents only. No Supabase access of any kind.

Commands (second run):

```bash
export NODE_USE_ENV_PROXY=1 OPENAI_API_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9 NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder
curl -s "https://api.anthropic.com/v1/models?limit=100" -H "x-api-key: $MYRAG_ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"
ANTHROPIC_API_KEY="$MYRAG_ANTHROPIC_API_KEY" node --import tsx eval/out/05-26-t1/spike.mts anthropic   # 9 direct turns
ANTHROPIC_API_KEY="$MYRAG_ANTHROPIC_API_KEY" node --import tsx eval/out/05-26-t1/spike.mts a1          # A1, server web search
ANTHROPIC_API_KEY="$MYRAG_ANTHROPIC_API_KEY" node --import tsx eval/out/05-26-t1/a1-sdk.mts            # A1, AI SDK client tool, 2 steps
ANTHROPIC_API_KEY="$MYRAG_ANTHROPIC_API_KEY" node --import tsx eval/out/05-26-t1/spike.mts baseurl     # /v1 vs no /v1, real key
```

The placeholder variables only satisfy `src/lib/env.ts` validation; nothing contacts Supabase or OpenAI. `NODE_USE_ENV_PROXY=1` is needed because Node's `fetch` otherwise skips the container proxy.

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
| Anthropic `GET /v1/models` (live, with the key) | the three anthropicIds | **All listed**: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`. The list also has `claude-fable-5-2`, `-5-1`, `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, `-4-7`, `-4-6`, `claude-sonnet-4-6` and the dated 4.5 ids |

Note: OpenRouter also lists `anthropic/claude-fable-5`, `-5.1` and `-5.2`. None of them is configured, so this needs no change. They are candidates for a later mapping: the matching Anthropic ids (`claude-fable-5`, `-5-1`, `-5-2`) are listed, and all of them already match an adaptive-thinking prefix.

The configured `anthropicId` values were checked in `src/lib/env.ts`, `scripts/init-env.js`, `scripts/config-server.js` and `scripts/config-ui/index.html`. Each of the three ids appears there and nowhere differs. `.env.local` was not read.

## Step 2: per-model results

**Direct Claude path (live, `claude-citations`).** All 9 turns took the direct path: no fallback, no error, `fallbackReason` null, no trace rule. Every citation came from an Anthropic `char_location` citation, mapped to the right block, with Anthropic's `cited_text` as the quote:

| Model | Question | TTFT ms | Total ms | Citations → block (quote) | invalid |
| --- | --- | ---: | ---: | --- | ---: |
| opus-5.5 | plain | 652 | 1562 | S1 "…painted green in 1931.", S3 "…84 metres long." | 0 |
| opus-5.5 | reasoning (adaptive) | 375 | 1381 | S1 "Its lamp was replaced … in 1952.", S3 "…closed for repairs in the spring of 2019." | 0 |
| opus-5.5 | zh | 1291 | 2196 | S2 "…grows forty kinds of beans." | 0 |
| sonnet-5.5 | plain | 725 | 1120 | S1, S3 (same quotes as opus) | 0 |
| sonnet-5.5 | reasoning (adaptive) | 1743 | 2570 | S1, S3 | 0 |
| sonnet-5.5 | zh | 859 | 1983 | S2 | 0 |
| haiku-5.5 | plain | 848 | 1197 | S1, S3 | 0 |
| haiku-5.5 | reasoning (adaptive) | 1276 | 1900 | S1, S3 | **1** |
| haiku-5.5 | zh | 822 | 1241 | S2 | 0 |

- Answers were correct in every turn. The zh turns answered in Chinese, and the cited English sentence was kept as the quote.
- The haiku-5.5 reasoning turn repeated the planted note itself (*"…a note saying "see [S9]," but the documents don't include…"*). The model wrote `[S9]` as text, not as an Anthropic citation. The marker parser counted it as invalid (`invalidCitations: 1`) and made no record. The marker stays in the server stream and is hidden at render by `src/lib/chat/citation-markers.ts`, the same as on the chunk-alias path.
- No Anthropic citation named an unknown document (`unknownSources` 0 in every turn).

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

### TTFT: direct Claude vs OpenRouter (ms, one sample per cell, report-only per D-23)

| Model | Question | Direct Claude | OpenRouter (chunk-alias) |
| --- | --- | ---: | ---: |
| opus-5.5 | plain | 652 | 2539 |
| opus-5.5 | reasoning | 375 | 845 |
| opus-5.5 | zh | 1291 | 2797 |
| sonnet-5.5 | plain | 725 | 504 |
| sonnet-5.5 | reasoning | 1743 | 654 |
| sonnet-5.5 | zh | 859 | 504 |
| haiku-5.5 | plain | 848 | 1126 |
| haiku-5.5 | reasoning | 1276 | 2354 |
| haiku-5.5 | zh | 822 | 1528 |
| **median** | | **848** | **1126** |

The two columns were measured in different sessions a few hours apart, and each cell is one sample, so the comparison only shows that the direct path is in the same range. It is not a ranking. Every direct turn produced its first token far inside the first-token gate (`CLAUDE_FIRST_TOKEN_TIMEOUT_MS`). On the direct path the first text token comes after the model's text block starts; markers are added at each text-end, so they do not delay the first token.

The OpenRouter rows (first run) follow.

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

### A1: citations and tool use in one turn (live)

**Outcome: they coexist.** Two shapes were tried, both with `claude-haiku-5-5`, max_tokens 512 and one citations-enabled synthetic document.

1. **Raw Messages API with Anthropic's server web search** (`spike.mts a1`, raw SSE in `eval/out/05-26-t1/a1-raw.sse`, kept local and not committed because it holds third-party web-search text). HTTP 200. The stream had `server_tool_use` (web_search), `web_search_tool_result`, a `char_location` citation on the document (`cited_text` "The Velmora lighthouse was painted green in 1931.", title S1) and two `web_search_result_location` citations. It ended with `max_tokens`: adaptive thinking took 424 of the 761 output tokens without being asked for. Input was 15,846 tokens for one search.
2. **AI SDK path, the app's shape** (`a1-sdk.mts`, raw SSE in `eval/out/05-26-t1/a1-sdk-raw.sse`, report in `report-a1-sdk.json`). `buildClaudeCitationRequest` plus `claudeMarkerTransform`, a client `webSearch` tool returning a fixed synthetic result (it contacts nothing), and `stopWhen: stepCountIs(2)`. Two requests to `/v1/messages`, 2 steps, `tool-call` 1, `tool-result` 1, no error. The document citation in the second step mapped to S1 with the right `cited_text`. The answer used both the document and the tool result.

So research A1 ("citations coexist with tool use and multi-step on the AI SDK path") holds. Per the plan, this opens a gap-closure plan to make webSearch turns eligible (below). `CLAUDE_WEB_SEARCH_ELIGIBLE` stays `false` until that plan lands.

Points for that plan:
- Server web search returns `web_search_result_location` citations. The AI SDK surfaces them as `url` sources. `claudeMarkerTransform` handles only `document` sources and passes others through unchanged, so they would reach the UI as plain sources. The app's webSearch is the Exa client tool, so shape 2 is the one to build on, and no server tool is needed.
- A webSearch turn is multi-step. The direct path today never passes `stopWhen` or tools from the route; the plan has to add both and decide how `multi_step` eligibility changes.
- The first-token gate must allow for a first step that emits only a tool call, with no text.

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

- **No code defect found.** Checked on real streams: model ids, eligibility, ineligible turns, the first-token gate, the one fallback, the trace rule, citation mapping and `cited_text` quotes on the direct path, adaptive thinking on all three models, Chinese turns, chunk-alias mapping on OpenRouter, and invalid-marker counting on both paths.
- **Base URL without `/v1`: closed, not a defect.** With the real key, `spike.mts baseurl` streamed on both `https://api.anthropic.com/v1` (TTFT 1339 ms) and `https://api.anthropic.com` (804 ms), both `claude-citations` with S1 and S3 and no fallback. `@ai-sdk/anthropic` 3.0.143 `normalizeBaseURL` rewrites exactly `https://api.anthropic.com` to `https://api.anthropic.com/v1`. A direct check shows Anthropic answers 404 on `/messages` and 400 on `/v1/messages` for an empty body. A custom gateway URL without `/v1` would still post to `<url>/messages`. That is operator configuration, and the Config UI placeholder already shows the `/v1` form.
- **Observation, not a defect: one quote per alias.** When a block is cited twice for different sentences (zh turns: "forty kinds of beans" and "every Tuesday morning"), the record keeps the first `cited_text` only (`quotes.has` guard in `claude.ts`). That matches one `CitationRecord` per alias.
- **Observation, not a defect: restated quotes.** opus-5.5 and haiku-5.5 often write a short claim and then repeat the cited sentence word for word ("…was painted green. The Velmora lighthouse was painted green in 1931.[S1]"). The raw A1 SSE shows this text in Anthropic's own `text_delta` events, so it comes from the model, not from the transform. sonnet-5.5 did not do it. A prompt tweak could be weighed later, measured against the eval set.
- **Observation: thinking without being asked.** In A1 the 5.5 model ran adaptive thinking although the request had no `thinking` option. With `CLAUDE_MAX_OUTPUT_TOKENS = 16384` this is harmless for plain turns. It matters only for a small output cap.
- **Gap-closure plan needed: yes, one.** Make webSearch (Exa client tool) turns eligible for `claude-citations`, because A1 holds (see the points under A1). No other gap plan.

## Requests made

First run (no key):
- api.anthropic.com: 3, all 401 with a placeholder or dummy key. Nothing was billed.
- openrouter.ai chat completions: 13 (12 succeeded, 1 was a 401 before the proxy setting was fixed).
- openrouter.ai metadata: 3 GETs.
- Local: 2 connection attempts to 127.0.0.1:9.
- Subtotal: 19 external requests.

Second run (with the key):
- api.anthropic.com: 18 in total.
  - `GET /v1/models`: 1.
  - Direct Claude turns: 9.
  - A1 server web search: 1. It included 1 server-side web search.
  - A1 on the AI SDK path: 2 (two steps).
  - Base-URL turns: 2.
  - Empty-body POSTs to `/messages`, `/v1/messages` and `/nonexistent`: 3. They returned 404, 400 and 404, so nothing was generated.
- openrouter.ai: 0. No turn fell back.
- Subtotal: 18 external requests. 15 of them produced output, all with max_tokens of 512 or less, except the direct turns, which use the route's `CLAUDE_MAX_OUTPUT_TOKENS`. Those answers were short: 1–3 sentences each.

Total for Task 1: 37 external requests.
