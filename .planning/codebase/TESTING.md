# Testing Patterns

**Analysis Date:** 2026-06-01

## Test Framework

**Runner:**
- None installed. No `jest.config.*`, `vitest.config.*`, or equivalent config found in the repository.
- No `@testing-library/react`, `jest`, `vitest`, `mocha`, or similar packages appear in `package.json`.

**Assertion Library:**
- Not applicable — no test framework present.

**Run Commands:**
```bash
# No test runner configured.
# The closest equivalent is the RAG diagnostic suite:
node scripts/rag/check-rag-flow.js       # Validates RAG_SYSTEM_PROMPT env var
node scripts/rag/decode-rag-prompt.js    # Decodes and inspects system prompt
node scripts/rag/check-url-metadata.js  # Checks URL metadata pipeline
node scripts/rag/reprocess-documents.js # Re-runs document processing pipeline
npm run test-rag                         # Alias: node scripts/test-rag-system.js (if present)
npm run lint                             # ESLint — closest automated quality gate
```

## Test File Organization

**Location:** No test files detected. No `*.test.*` or `*.spec.*` files found anywhere under `src/` or `scripts/`.

**Naming:** No established pattern — none exist.

**Structure:** Not applicable.

## Test Structure

**Suite Organization:** No formal test suites exist.

**Patterns:** No automated unit, integration, or e2e test patterns established.

## Mocking

**Framework:** None.

**Patterns:** No mocking infrastructure in place.

**What to Mock (recommendations for future test suite):**
- External AI provider calls (OpenRouter, OpenAI, Anthropic)
- Supabase client methods (`from()`, `select()`, `insert()`, `rpc()`)
- `fetch` calls to external services (Fal.ai, Runway, Meshy, WhatsApp)
- `crypto`, `uuid`, and `nanoid` for deterministic IDs

**What NOT to Mock (recommendations):**
- `src/lib/utils.ts` (`cn()` function) — pure, no side effects
- `src/lib/bm25-scorer.ts`, `src/lib/mmr-scorer.ts` — pure scoring algorithms
- `src/lib/deployment-mode.ts` — thin env-read wrappers

## Fixtures and Factories

**Test Data:** No fixture or factory files exist.

**Location:** No established convention.

## Coverage

**Requirements:** None enforced — no coverage tooling configured.

**View Coverage:**
```bash
# Not available — no test runner configured
```

## Test Types

**Unit Tests:** Not present. Candidates for unit testing include:
- `src/lib/bm25-scorer.ts` — scoring pure functions
- `src/lib/mmr-scorer.ts` — reranking algorithm
- `src/lib/chat-title-utils.ts` — title generation helpers
- `src/lib/url-extractor.ts` — URL parsing logic
- `src/lib/api-middleware.ts` — `validateRequest()` and `withValidation()` HOF

**Integration Tests:** Not present. Candidates include:
- RAG pipeline end-to-end: document upload → chunk → embed → search
- API route handlers via `next-test-api-route-handler` or similar
- Supabase RLS policy validation

**E2E Tests:** Not configured. No Playwright or Cypress setup detected (`.playwright-mcp/` exists but is MCP tooling, not an E2E suite).

## Manual / Diagnostic Testing

The project substitutes formal tests with a set of Node.js diagnostic scripts:

**RAG diagnostics (`scripts/rag/`):**
- `check-rag-flow.js` — validates `RAG_SYSTEM_PROMPT` contains `{{context}}` placeholder
- `decode-rag-prompt.js` — decodes URI-encoded prompt for manual inspection
- `check-url-metadata.js` — checks URL metadata extraction pipeline
- `reprocess-documents.js` — re-processes documents through chunking/embedding

**Admin diagnostics (`scripts/config-ui/admin/`):**
- `check-admin.js` — verifies `check_admin_status` and `is_admin` DB functions

**Manual test flow for new chat features:**
1. `npm run dev` — start dev server
2. Open `http://localhost:3000` — test in browser
3. `npm run config` — open config dashboard at `http://localhost:3333`
4. Check browser console + terminal for `[TAG]: message` log prefixes

## Common Patterns (Recommended When Tests Are Added)

**Async Testing:**
```typescript
// Recommended pattern using vitest (preferred for Next.js 16):
import { describe, it, expect, vi } from 'vitest';

it('creates chat title from tool call', async () => {
  const result = await generateChatTitleFromToolCall(mockToolCallPart);
  expect(result).toMatch(/^[A-Z]/);
});
```

**Error Testing:**
```typescript
// Test that API middleware rejects invalid bodies
it('returns 400 on schema mismatch', async () => {
  const result = await validateRequest(mockReq, schema);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.response.status).toBe(400);
  }
});
```

**Mocking Supabase (recommended approach):**
```typescript
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }) },
    from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() }))
  }))
}));
```

## Setup Recommendation

To add a test suite aligned with the existing stack:

1. Install: `npm install -D vitest @vitejs/plugin-react @testing-library/react @testing-library/user-event`
2. Add `vitest.config.ts` at root alongside `next.config.js`
3. Create `src/__tests__/` or co-locate `*.test.ts` files next to source
4. Start with pure lib functions: `bm25-scorer.ts`, `mmr-scorer.ts`, `api-middleware.ts`
5. Add `"test": "vitest"` to `package.json` scripts

---

*Testing analysis: 2026-06-01*
