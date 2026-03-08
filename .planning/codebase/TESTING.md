# Testing Patterns

**Analysis Date:** 2026-03-08

## Test Framework

**Runner:**
- No test framework is configured in this project
- No Jest, Vitest, Mocha, or any other test runner detected
- No `jest.config.*`, `vitest.config.*`, or similar configuration files exist
- No test-related dependencies in `package.json` (devDependencies)
- No test-related npm scripts in `package.json`

**Assertion Library:**
- None configured

**Run Commands:**
```bash
# No test commands available
# The project has no automated test infrastructure
```

## Test File Organization

**Location:**
- No test files exist anywhere in `src/`
- No `__tests__/` directories
- No `*.test.ts`, `*.test.tsx`, `*.spec.ts`, or `*.spec.tsx` files in the project source

## Current Quality Assurance

**Linting (only automated check):**
```bash
npm run lint          # ESLint with flat config
npm run lint:fix      # Auto-fix lint issues
```

**TypeScript:**
- `tsconfig.json` has `strict: true` enabled
- However, `next.config.js` sets `typescript.ignoreBuildErrors: true`, meaning type errors do not block builds

**Manual RAG Testing Scripts:**
- `npm run test-rag` (`node scripts/test-rag-system.js`) - manual RAG pipeline validation
- `node scripts/rag/decode-rag-prompt.js` - RAG prompt inspection
- `node scripts/rag/check-rag-flow.js` - RAG flow diagnostics
- These are operational scripts, not automated unit/integration tests

## Recommended Test Setup

If adding tests to this project, follow these conventions based on the existing codebase patterns:

**Suggested Framework:** Vitest (aligns with the Vite/modern tooling ecosystem, faster than Jest for TypeScript)

**Suggested File Organization:**
- Co-locate test files next to source: `src/lib/deployment-mode.test.ts`
- For components: `src/components/ui/button.test.tsx`
- For API routes: `src/app/api/documents/route.test.ts`

**Suggested Naming:**
- `*.test.ts` / `*.test.tsx` (not `.spec`)
- Mirror the source file name: `chat-store.ts` -> `chat-store.test.ts`

**Priority Test Targets (based on codebase structure):**

1. **Utility functions** (pure, easy to test):
   - `src/lib/deployment-mode.ts` - `isSingleTenant()`, `isMultiTenant()`, `getFeatureFlags()`
   - `src/lib/utils.ts` - `cn()` utility
   - `src/lib/query-classifier.ts` - query classification logic
   - `src/lib/bm25-scorer.ts` - BM25 scoring algorithm
   - `src/lib/mmr-scorer.ts` - MMR scoring algorithm
   - `src/lib/reranker-local.ts` - local reranking logic

2. **API middleware** (critical path):
   - `src/lib/api-middleware.ts` - `validateRequest()`, `withValidation()`

3. **Type conversion functions** (data integrity):
   - `src/types/chat.ts` - `toAPIMessage()`, `toDBMessages()`, `fromUIMessage()`

4. **Zustand stores** (business logic):
   - `src/lib/chat-store.ts` - chat CRUD operations
   - `src/lib/ghost-mode-store.ts` - ghost mode state machine
   - `src/lib/stores/reasoning-store.ts` - reasoning config management

5. **RAG pipeline** (core feature):
   - `src/lib/document-processor.ts` - document chunking and embedding
   - `src/lib/enhanced-rag-retrieval.ts` - retrieval strategies
   - `src/lib/semantic-chunker.ts` - semantic chunking

## Mocking

**Framework:** Not applicable (no tests exist)

**What Would Need Mocking:**
- Supabase client (`@supabase/supabase-js`) - database and auth operations
- OpenAI/OpenRouter API calls - AI model interactions
- `process.env` - environment variable configuration
- `localStorage` / `window` - browser APIs in Zustand stores
- `fetch` - for API route integration tests

## Coverage

**Requirements:** None enforced -- no test coverage tooling configured

## Test Types

**Unit Tests:**
- Not present

**Integration Tests:**
- Not present

**E2E Tests:**
- Not present
- No Playwright, Cypress, or similar E2E framework configured

**Manual Testing:**
- RAG diagnostic scripts serve as manual integration checks
- `npm run config` provides visual configuration validation
- Development server (`npm run dev`) used for manual UI testing

---

*Testing analysis: 2026-03-08*
