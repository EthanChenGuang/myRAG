---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 30
subsystem: api
tags: [mcp, typescript, ai-sdk, modelcontextprotocol, vitest]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "plan 02-01 test and tsc ratchet scaffolding"
provides:
  - "MCP transports, factory, universal client, discovery, routers, health route and approve route type-check with zero errors"
  - "tests/mcp: fake MCP server helper plus transport, universal-client, discovery/health and approve-route tests"
affects: [tsc-ratchet baseline, chat API MCP routing]

actuals:
  tokens: 31000
  tasks: 3
  commits: 6
plan_head_before: e308307fe9a17df0009fbdc60faacadf928e2603
plan_head_after: 088769bccc1ad96758e77398b9a70ed2a531f6fb

tech-stack:
  added: []
  patterns:
    - "node:http fake MCP endpoint (streamable-http + SSE) for transport tests"
    - "SDK headers always passed via requestInit"

key-files:
  created:
    - tests/mcp/helpers/fake-mcp-server.ts
    - tests/mcp/transports.test.ts
    - tests/mcp/universal-client.test.ts
    - tests/mcp/discovery.test.ts
    - tests/mcp/approve-params.test.ts
  modified:
    - src/app/api/chat/approve/route.ts
    - src/app/api/mcp/health/route.ts
    - src/lib/mcp/transport-factory.ts
    - src/lib/mcp/transports/sse-transport.ts
    - src/lib/mcp/transports/streamable-http-transport.ts
    - src/lib/mcp/universal-client.ts
    - src/lib/mcp/universal-discovery.ts
    - src/lib/mcp/production-router.ts
    - src/lib/mcp/smart-router.ts
    - src/lib/mcp/query-patterns/index.ts

key-decisions:
  - "Exported RoutedTool (Tool plus legacy parameters schema) from production-router so chat API consumers keep their typing; avoids raising the chat route's baselined error count"
  - "Query-pattern registry typed with McpServerPatternsBase (the class that really has match) instead of editing base.ts"
  - "Approve route client status logging uses UniversalMcpClient.getConnectionStatus via a duck-typed helper, so the fallback wrapper client path is also safe"

requirements-completed: [PIPE-01]

coverage:
  - id: D1
    description: "MCP area (approve route, health route, src/lib/mcp) has zero tsc errors"
    requirement: PIPE-01
    verification:
      - kind: other
        ref: "npx tsc --noEmit -p tsconfig.json | grep -E '^src/lib/mcp/|^src/app/api/chat/approve|^src/app/api/mcp/health' (0 lines)"
        status: pass
      - kind: other
        ref: "node scripts/ci/tsc-ratchet.mjs (ok: 188 errors, 10 files improved)"
        status: pass
    human_judgment: false
  - id: D2
    description: "SDK-drift runtime bugs fixed with tests"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "npx vitest run tests/mcp (4 files, 14 tests passed)"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-11-23
---

# Phase 2 Plan 30: MCP area type errors and SDK drift Summary

Both MCP transports, the discovery client factory, the health route and the approve route now type-check against the current MCP SDK and AI SDK, and the runtime bugs hidden behind those errors are fixed and covered by 14 new vitest tests running against a local fake MCP server.

## Accomplishments

- 42 plan-scope errors (13 approve route, 1 health route, 28 under src/lib/mcp) reduced to 0; the ratchet passes with 188 errors total.
- tests/mcp covers: transport interface and connect/list/call/close for both transport kinds, header delivery, `getAiSdkTools`, discovery client creation and category inference, the health route, and the approve route.

## Intended behaviour changes

| Fix | Before | After | Test |
| --- | --- | --- | --- |
| SSE and streamable-http headers | SSE passed a non-existent `headers` option (silently ignored); streamable-http passed none | Configured transport headers go through `requestInit.headers` and reach every request (GET stream and POSTs) | `tests/mcp/transports.test.ts` "sends the configured custom headers" (both kinds) |
| McpTransport members | Transports lacked `getClient`; interface lacked `getSdkTransport` that universal-client calls | Both implemented and typed (`Client`, `Transport`) | `transports.test.ts` "satisfies the McpTransport interface" |
| `getAiSdkTools` | Called `createMCPClient(transport)` and read `.tools` on a Promise (always TypeError, swallowed per server) | `await createMCPClient({ transport })` then `tools()` | `tests/mcp/universal-client.test.ts` |
| Duplicate `inputSchema` key | Two keys; the last (`toolDef.parameters \|\| {}`) won | Earlier key removed, value unchanged | covered by transport list tests |
| Discovery `experimental_createMCPClient` | Undefined name: ReferenceError caught as "server down" | Imports `createMCPClient`; `clients` map declared | `tests/mcp/discovery.test.ts` (status healthy, client stored, on-demand creation) |
| Discovery tool parameters | Wrote `inputSchema`, leaving required `parameters` undefined | `parameters` = `toolDef.parameters \|\| toolDef.inputSchema \|\| {}` | discovery test "maps the tool schema to parameters" |
| Health route | Called non-existent `client.connect()`, always failed into `lastError` | Uses `discoverAllTools()` (which connects), then reads connection health | discovery test "MCP health route" |
| Approve route `paramsToUse` | ReferenceError in the empty-result log masked the real error and failed the approval | Logs `persistentState?.tool_params \|\| toolCall.params` | `tests/mcp/approve-params.test.ts` "does not throw a ReferenceError" |
| Approve route client diagnostics | Read `endpoint`/`connected`/`tools` that do not exist on the client | Uses `getConnectionStatus()`; `debugInfo.activeClientEndpoint` now lists server names (never endpoint URLs) instead of always `unknown` | approve test "public connection getters" |
| Approve route SSE headers | Ignored `headers` option | `requestInit.headers` | type-checked, same SDK path as transports |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Tool results text/message/response fields**
- **Issue:** The plan says to read results through the content array instead of top-level fields. In that code path (`formattedResult` has no content array) top-level `text`/`message`/`response` are the intended recovery fields for malformed results, and the content-array text path already runs afterwards.
- **Fix:** Kept the behaviour, typed the malformed result explicitly. A test confirms content-array text reaches the response.
- **Commit:** 088769b

**2. [Rule 3 - Blocking] chat route ratchet regression**
- **Issue:** Replacing the unresolvable `CoreTool` made `src/app/api/chat/route.ts` read `.parameters` on a strict `Tool`, raising its error count from 35 to 37 (baseline cannot be edited).
- **Fix:** Added exported `RoutedTool` (Tool plus optional legacy `parameters` Zod schema) as the type of `EnhancedMcpTools.tools`.
- **Commit:** 088769b

**3. [Rule 3 - Blocking] query-patterns base.ts**
- **Issue:** `McpServerPatterns` lacks `match`. Instead of editing base.ts (outside plan files), `index.ts` is typed with `McpServerPatternsBase`.
- **Commit:** 643355f

## Deferred Issues

- `UniversalMcpDiscovery.analyzeQueryIntent` seeds `categoryScores` with upper-case keys while `INTENT_PATTERNS` uses lower-case keys, so category scores become NaN. Pre-existing, no tsc error, out of scope.
- `getAiSdkTools` passes the already-started SDK transport to `createMCPClient`, which starts it again. The SDK may reject the second start; errors are caught and logged per server, as before. Needs a live-server check.

## Threat Flags

None. Headers are passed only through SDK options; no header values are logged; tests use placeholder values.

## Known Stubs

None.

## Self-Check: PASSED
