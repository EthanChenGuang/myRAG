---
last_mapped_commit: 41a47818ac26f9ea788ccb18230fb3351065c2a2
last_mapped_at: 2026-11-22
---
# Testing Patterns

**Analysis Date:** 2026-11-22

## Test Framework

**Runner:**
- No test runner is configured for the main Next.js app (`/home/user/myRAG/package.json` has no `test` script and no Jest/Vitest dependency)
- `baileys-whatsapp/` declares Jest 29 with `ts-jest` and `@types/jest`, configured in `baileys-whatsapp/jest.config.js`. Its test glob is `**/Tests/test.*.+(ts|tsx|js)` under `<rootDir>/src`, but no files match that pattern in the repository, so `npm test` there currently runs zero tests
- `voice-agent/` has no test script (`voice-agent/package.json` scripts: `dev`, `build`, `start`, `config`)
- Config: `baileys-whatsapp/jest.config.js`
- Assertion Library: Jest built-in `expect` (via `@types/jest` in `baileys-whatsapp/`)

**Run Commands:**
```bash
cd baileys-whatsapp && npm test          # Jest (currently no matching test files)
npm run lint                             # ESLint over the repo (root)
npx tsc --noEmit                         # Type-check root project (tsconfig.json)
npm run test-rag                         # node scripts/test-rag-system.js (manual RAG check)
node scripts/rag/check-rag-flow.js       # RAG flow diagnostics
node scripts/rag/test-rag-system.js      # RAG diagnostics
node scripts/rag/decode-rag-prompt.js    # Inspect RAG prompt
cd baileys-whatsapp && npm run lint      # tsc && eslint src
```
- No watch-mode or coverage script is defined anywhere in the repository

## Test File Organization

**Location:**
- Root app: no co-located or separate `*.test.*` / `*.spec.*` files exist under `src/`
- Scripts-based tests live in `scripts/whatsapp/tests/` (`test-numbers.js`, `test-numbers-auto.js`, `test-formatting.js`) and `baileys-whatsapp/test-webhook.js`, `baileys-whatsapp/test-server.cjs`

**Naming:**
- Standalone scripts use `test-*.js` in kebab-case. They are executed with `node`, not a test runner
- Diagnostic scripts under `scripts/rag/` use verb names (`check-rag-flow.js`, `decode-rag-prompt.js`, `reprocess-documents.js`) and are the documented health checks in `AGENTS.md`

**Structure:**
```
scripts/whatsapp/tests/
├── test-formatting.js     # Pure function check: formatResponseForWhatsApp
├── test-numbers.js        # Phone-number normalization checks
└── test-numbers-auto.js   # Automated variant
```

## Test Structure

**Script pattern (observed in `scripts/whatsapp/tests/test-formatting.js`):**
```javascript
#!/usr/bin/env node

/**
 * Test WhatsApp message formatting with numbers
 */

// Test the formatting function directly
function formatResponseForWhatsApp(response) {
  const formatted = response
    .replace(/```[\s\S]*?```/g, (match) => { /* ... */ })
    .trim();
  return formatted;
}
```
- Tests are self-contained: they copy the function under test rather than importing it from `src/`. When changing the production function, update the copy or refactor it into an importable module first
- Output is logged to the console; there is no assertion library or non-zero exit on failure

**Patterns:**
- Setup: inline constants; no shared fixtures or `beforeEach`
- Teardown: none
- Assertions: manual comparisons with `console.log` output for inspection

## Mocking

**Framework:** None configured for the root app. `baileys-whatsapp/jest.config.js` maps `axios` to its resolved module path (`moduleNameMapper`), which is the only mocking-related config present.

**Patterns:**
- No existing mock files, `__mocks__` directories, or `jest.mock` calls were found in the repository
- Environment-dependent modules are reached through `src/lib/env.ts`, which is a singleton (`EnvironmentConfig.getInstance()`); to vary configuration in a script, set `process.env` values before importing it

**What to Mock:**
- External AI providers (OpenRouter, OpenAI, Anthropic), Supabase, Nango, LiveKit, and WhatsApp transports. Calls go through SDK clients (`@openrouter/ai-sdk-provider`, `@supabase/supabase-js`, `@nangohq/node`, `livekit-server-sdk`), so mock at the client boundary

**What NOT to Mock:**
- Pure utilities such as `cn` (`src/lib/utils.ts`), `formatErrorSSE` (`src/lib/error-stream.ts`), and `validateRequest` schema logic (`src/lib/api-middleware.ts`). These are deterministic and should run for real
- Zod schemas: test them with real inputs

## Fixtures and Factories

**Test Data:**
- No factory library is in use. Use inline literal objects. Keep values as placeholders, never real phone numbers or customer data (`AGENTS.md` section 4, rule 7)
- Sample WhatsApp payload data may exist in `baileys-whatsapp/Example/`; treat it as sample data only, and do not copy real identifiers from it

**Location:**
- Fixtures are not centralized. Put any new fixture next to the test that uses it

## Coverage

**Requirements:** None enforced. No `coverageThreshold` is set in Jest config, and no coverage script exists.

**View Coverage:**
```bash
cd baileys-whatsapp && npx jest --coverage   # Only meaningful once test files exist
```

## Test Types

**Unit Tests:**
- Effectively none in the root app. The only unit-style checks are the standalone scripts above and the Jest setup in `baileys-whatsapp/` with no active tests

**Integration Tests:**
- Manual RAG diagnostics via `scripts/rag/*` and `scripts/test-rag-system.js`, which hit the configured Supabase project and models; they require `.env.local` and are not safe for CI without credentials

**E2E Tests:**
- Not used. No Playwright, Cypress, or similar config exists

## Verification Before Hand-off

Because automated tests are sparse, the required verification set from `AGENTS.md` section 15 is:
1. `npm run lint` at the repo root
2. `npx tsc --noEmit` at the repo root (strict mode)
3. `cd baileys-whatsapp && npm run lint` when touching the WhatsApp service
4. The relevant `scripts/rag/*` or `scripts/whatsapp/tests/*` script for the changed domain

## Common Patterns

**Adding a new test (recommended, since no runner exists in the root app):**
- Add Vitest or Jest deliberately as a new dev dependency rather than ad hoc. If Jest is chosen, reuse `baileys-whatsapp/jest.config.js` conventions and place files under `src/**/__tests__/` or the `Tests/test.*.ts` glob already declared
- For pure modules, test directly: `validateRequest` with a `NextRequest` built from `new Request(url, { method: 'POST', body: JSON.stringify(...) })` and assert on `success` and `response.status`

**Async Testing:**
- Scripts use `async` functions invoked at the top level; no harness-level async support is configured

**Error Testing:**
```typescript
// Pattern to follow for validation tests (src/lib/api-middleware.ts)
const result = await validateRequest(req, schema);
expect(result.success).toBe(false);
// result.response.status === 400 and body.details lists { path, message }
```

---

*Testing analysis: 2026-11-22*
