# Testing Patterns

**Analysis Date:** 2026-03-08

## Test Framework

**Runner:**
- No test framework configured
- No test runner in `package.json` scripts
- No Jest, Vitest, or Playwright config files detected
- No test files exist in `src/` or project root

**Assertion Library:**
- Not applicable

**Run Commands:**
```bash
# No test commands available
# The following diagnostic scripts exist but are NOT automated tests:
node scripts/rag/check-rag-flow.js       # Manual RAG pipeline verification
node scripts/rag/test-rag-system.js       # Manual RAG system smoke test
node scripts/rag/decode-rag-prompt.js     # RAG prompt inspection
npm run test-rag                          # Alias for test-rag-system.js
```

## Test File Organization

**Location:**
- No test files exist in the project

**Naming:**
- Not established

## Test Structure

**No tests exist.** If adding tests, follow these recommendations based on codebase patterns:

**Recommended framework:** Vitest (aligns with the Vite/Next.js ecosystem)

**Recommended structure:**
```
src/
├── lib/
│   ├── __tests__/
│   │   ├── deployment-mode.test.ts
│   │   ├── api-middleware.test.ts
│   │   ├── utils.test.ts
│   │   └── logger.test.ts
│   └── ...
├── components/
│   └── ui/
│       └── __tests__/
│           └── button.test.tsx
└── app/
    └── api/
        └── __tests__/
            └── documents.test.ts
```

## Mocking

**Framework:** Not established

**Recommended mocking targets:**
- Supabase client (`src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`) -- mock with `vi.mock('@/lib/supabase/client')`
- OpenAI/AI SDK calls (`src/lib/document-processor.ts`)
- Environment variables (`src/lib/env.ts`) -- the singleton pattern makes this testable by mocking the module
- `fetch` calls for API integration tests
- `localStorage` for store tests (`src/lib/chat-store.ts`, `src/lib/ghost-mode-store.ts`)

**What to Mock:**
- External API calls (OpenAI, Supabase, OpenRouter, Fal.ai, Replicate)
- Browser APIs (`localStorage`, `window`, `document`)
- `next/navigation` (`useRouter`, `usePathname`)
- `next/headers` (`cookies`)

**What NOT to Mock:**
- Pure utility functions (`cn()`, `isSingleTenant()`, `getDeploymentMode()`)
- Zod schemas and validation logic
- Type definitions and interfaces
- Store logic (test with actual Zustand stores)

## Fixtures and Factories

**Test Data:**
- Not established

**Recommended fixtures based on data models:**
```typescript
// Example fixture for documents (based on src/lib/types.ts)
const mockDocument: ParsedDocument = {
  id: 'doc-123',
  filename: 'test.pdf',
  content: 'Test content',
  chunks: [],
  metadata: {},
  created_at: '2026-01-01T00:00:00Z',
};

// Example fixture for chat messages (based on src/types/chat.ts)
const mockMessage: ExtendedMessage = {
  id: 'msg-123',
  role: 'user',
  content: 'Hello',
  createdAt: new Date(),
};
```

## Coverage

**Requirements:** None enforced

**View Coverage:**
```bash
# Not configured
```

## Test Types

**Unit Tests:**
- Not present. Priority candidates for unit testing:
  - `src/lib/deployment-mode.ts` -- pure functions, easy to test
  - `src/lib/api-middleware.ts` -- Zod validation logic
  - `src/lib/utils.ts` -- `cn()` utility
  - `src/lib/query-classifier.ts` -- intent classification
  - `src/lib/bm25-scorer.ts` -- scoring algorithm
  - `src/lib/mmr-scorer.ts` -- scoring algorithm
  - `src/lib/semantic-chunker.ts` -- chunking logic
  - `src/lib/url-extractor.ts` -- URL parsing
  - `src/lib/utils/date-grouping.ts` -- date utilities
  - `src/lib/utils/sanitize-title.ts` -- string sanitization

**Integration Tests:**
- Not present. Priority candidates:
  - API route handlers (`src/app/api/documents/route.ts`, `src/app/api/upload/route.ts`)
  - RAG pipeline (`src/lib/enhanced-rag-retrieval.ts`, `src/lib/retrieval-strategies.ts`)
  - Supabase operations (`src/lib/supabase.ts`)

**E2E Tests:**
- Not present. No Playwright or Cypress configured.
- The `scripts/rag/test-rag-system.js` script serves as a manual E2E smoke test for the RAG pipeline only.

## Diagnostic Scripts (Not Tests)

The project includes manual diagnostic/verification scripts that serve as informal smoke tests:

**RAG diagnostics:**
- `scripts/rag/check-rag-flow.js` -- Verifies RAG pipeline configuration and connectivity
- `scripts/rag/test-rag-system.js` -- End-to-end RAG query test against live system
- `scripts/rag/decode-rag-prompt.js` -- Inspects and validates RAG prompt templates
- `scripts/rag/reprocess-documents.js` -- Re-processes existing documents for embedding updates

**Environment verification:**
- `scripts/init-env.js` -- Creates `.env.local` with defaults if missing

These scripts require running infrastructure (Supabase, API keys) and cannot run in CI without significant setup.

## Recommendations for Adding Tests

**Step 1: Install Vitest**
```bash
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
```

**Step 2: Create `vitest.config.ts`**
```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

**Step 3: Add scripts to `package.json`**
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

**Step 4: Start with pure utility functions** (zero mocking needed):
- `src/lib/utils.ts`
- `src/lib/deployment-mode.ts`
- `src/lib/utils/date-grouping.ts`
- `src/lib/utils/sanitize-title.ts`

---

*Testing analysis: 2026-03-08*
