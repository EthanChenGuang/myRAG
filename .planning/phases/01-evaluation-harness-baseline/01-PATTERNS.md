# Phase 1: Evaluation Harness & Baseline - Pattern Map

**Mapped:** 2026-11-23
**Files analyzed:** 30 (new; the only modified files are `package.json`, `.gitignore`, `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js` and `scripts/config-ui/index.html`)
**Analogs found:** 9 / 30 (most of this phase is greenfield: Python, CI, PGlite harness)

Tracked-source gate: all analogs below were checked as tracked (`git ls-files` confirmed for voice-rag route, voice-chat route, `scripts/init-env.js`, `voice-agent/Dockerfile`, `voice-agent/package.json`, `.gitignore`). No `.github/` and no existing test runner exist.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/app/api/internal/rag/run/route.ts` | route | request-response | `src/app/api/internal/voice-rag/route.ts` | role-match (auth must NOT be copied) |
| `src/lib/rag-eval/auth.ts` | utility | request-response | `voice-rag/route.ts` L18-31 (inverted) | partial |
| `src/lib/rag-eval/legacy-post-filter.ts` | utility | transform | inline logic in `src/app/api/chat/route.ts` L2170-2250, L2512-2577 | source-of-truth (replicate) |
| `src/lib/rag-eval/trace.ts` + `contracts.generated.ts` | model | transform | `src/lib/api-middleware.ts` (Zod `zod/v3`) | partial |
| `eval/harness/pglite-supabase.mts`, `fake-edge.mts`, `fixture-embedder.mts`, `run-smoke.mts` | service/harness | request-response, batch | none (RESEARCH Patterns 1, 2, 8) | no analog |
| `rag-sidecar/src/rag_sidecar/{main,auth,settings}.py` | service | request-response | none in Python; auth shape from RESEARCH Pattern 10 | no analog |
| `rag-sidecar/src/rag_sidecar/contracts/*.py`, `export_schemas.py` | model | transform | none | no analog |
| `rag-sidecar/Dockerfile` | config | n/a | `voice-agent/Dockerfile` | role-match (structure only) |
| `eval/src/rag_eval/{metrics,matching,gate,report,runner,split}.py`, `judge/`, `draft/` | service | batch | `scripts/rag/check-rag-flow.js` (CLI script style only) | weak |
| `scripts/gen-zod.mjs` | utility | transform | none (RESEARCH Pattern 4) | no analog |
| `scripts/check-config.mjs`, `scripts/rag/env-manifest.json` | utility | file-I/O | `scripts/rag/check-rag-flow.js` | role-match |
| `tests/*.test.ts`, `vitest.config.ts`, `tests/setup-env.ts` | test | request-response | none (no runner exists) | no analog (RESEARCH Pattern 5) |
| `.github/workflows/{pr-smoke,nightly}.yml` | config | n/a | none | no analog |
| `package.json` (scripts), `.gitignore` | config | n/a | self | exact |
| `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, `scripts/config-ui/index.html` (add `RAG_EVAL_SECRET`, `RAG_EVAL_ENDPOINT_ENABLED`, sidecar vars) | config | n/a | existing `RAG_BEHAVIOR_MODE` entries | exact |

## Pattern Assignments

### `src/app/api/internal/rag/run/route.ts` (route, request-response)

**Analog:** `src/app/api/internal/voice-rag/route.ts`

**Imports and runtime** (L1-8):
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
// Use Node.js runtime
export const runtime = 'nodejs';
```

**Structure to copy** (L16-38): single `export async function POST(req: NextRequest)`, try/catch, numbered comment-free steps, bracketed log prefix, `NextResponse.json({ error }, { status })`:
```typescript
if (!env.MYRAG_INTERNAL_API_KEY) {
    console.error('[Internal RAG] MYRAG_INTERNAL_API_KEY not configured on server');
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
}
if (apiKey !== env.MYRAG_INTERNAL_API_KEY) {   // DO NOT COPY: not constant time
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
```
Deviation required: use `x-rag-eval-secret`, SHA-256 both sides + `crypto.timingSafeEqual`; 404 when `NODE_ENV==='production' && RAG_EVAL_ENDPOINT_ENABLED!=='true'`; 503 when `RAG_EVAL_SECRET` unset (RESEARCH Pattern 3). Use bracketed prefix `[RAG Eval]`.

**Error handling** (L446-449):
```typescript
} catch (error: any) {
    console.error('[Internal RAG] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
}
```
(type the catch as `unknown`; no new `any`).

**Validation:** copy `validateRequest`/`withValidation` from `src/lib/api-middleware.ts` L10-75 (Zod `zod/v3`, 400 with `{ success: false, error, details: [{path,message}] }`). Wrap the handler after the auth check so unauthenticated callers never reach body parsing. The request schema is the generated Zod from the Pydantic request model.

**Retrieval call to mirror:** `enhancedRetrieveChunks(query, options)` from `src/lib/enhanced-rag-retrieval.ts` L40-48; options `{ maxResults?, enableTemporalBoost, enableFinancialBoost, requireTemporalMatch, fallbackToLowerThreshold, organizationId, userId }`. Call it with the same flags as chat route L2117-2125 (see RESEARCH Pattern 3).

---

### `src/lib/rag-eval/legacy-post-filter.ts` (utility, transform)

**Analog:** `src/app/api/chat/route.ts` L2170-2250 (Filter 1, context assembly), L2512-2540 (Filter 2), L2572-2577 (refusal). Planner/executor must read those ranges directly; the verbatim fragments to replicate and sentinel-test are in RESEARCH Pattern 3:
```typescript
const queryTerms = normalize(queryText).split(/\s+/)
  .filter(term => term.length > 3)
  .map(term => term.replace(/[^a-z0-9]/g, ''));
if (chunk.similarity > 0.65 || isRelevantByName || (hasImage && chunk.similarity > 0.25)) {
```
Keep the Chinese empty-term quirk (`"x".includes("")` is true). Pure functions only; no route edits. Add a sentinel test that reads `route.ts` as text and asserts the literal fragments.

---

### `src/lib/rag-eval/contracts.generated.ts` and `trace.ts` (model, transform)

**Analog:** `src/lib/api-middleware.ts` import convention: `import { z } from 'zod/v3';` (L2). Generated file must replace `from "zod"` with `from "zod/v3"` and carry a `// GENERATED by scripts/gen-zod.mjs ... do not edit` header. Never hand-write Zod mirrors.

---

### `rag-sidecar/Dockerfile` (config)

**Analog:** `voice-agent/Dockerfile` (21 lines): single-stage `node:20-slim`, `WORKDIR /app`, copy manifests first for layer caching, then source, then `CMD`:
```dockerfile
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "start"]
```
Copy only the layering idea (deps layer before source). Everything else follows RESEARCH Pattern 10 (uv, `python:3.12-slim`, `uv sync --frozen --no-install-project`, non-root user, `HEALTHCHECK` on `/health`). Sibling services keep their own Dockerfile and manifest, so `rag-sidecar/` is self-contained.

---

### `scripts/check-config.mjs` + `scripts/rag/env-manifest.json` (utility, file-I/O)

**Analog:** `scripts/rag/check-rag-flow.js` (Node CLI diagnostic in `scripts/rag/`, plain console output, exit code). It loads env with `require('dotenv').config({ path: '.env.local' })`; the new script should be `.mjs`, read the four tracked files as text, treat `.env.local` as optional, and `process.exit(1)` on violations. Design is RESEARCH Pattern 7 (`knownGaps` ratchet).

**Location references for the var-presence regex `(?<![A-Z0-9_])NAME(?![A-Z0-9_])`** (verified shapes for `RAG_BEHAVIOR_MODE`):
- `scripts/init-env.js:319` `RAG_BEHAVIOR_MODE=strict`
- `src/lib/env.ts:160` `RAG_BEHAVIOR_MODE: process.env.RAG_BEHAVIOR_MODE || 'strict',`
- `scripts/config-server.js:521,1267,1580` `RAG_BEHAVIOR_MODE=${getEnvValue('RAG_BEHAVIOR_MODE') || 'strict'}`

---

### Config sync for new vars (`RAG_EVAL_SECRET`, `RAG_EVAL_ENDPOINT_ENABLED`, sidecar secret/URL)

**Analog:** `RAG_BEHAVIOR_MODE` in the four files above plus `scripts/config-ui/index.html`. Add each new var to all of: `scripts/init-env.js` (template line), `src/lib/env.ts` (inside `this.envVars = {...}` around L160, `process.env.X || ''` form), `scripts/config-server.js` (all three template blocks, using `getEnvValue('X')`), `scripts/config-ui/index.html`. Note `env.ts` builds a frozen snapshot at import and throws when `OPENAI_API_KEY`/`SUPABASE_SERVICE_ROLE_KEY` are empty outside production, so test setup must set placeholders first.

---

### `package.json` scripts

**Analog:** existing `scripts` block (L5-18): `"test-rag": "node scripts/test-rag-system.js"` points at a missing file (EVAL-11). Repoint it to the smoke tier, e.g. `tsx eval/harness/run-smoke.mts`, and add `test`, `typecheck:new`, `check-config`, `gen-zod`. No `"type": "module"` in root, so harness entry points must be `.mts`.

### `.gitignore`

**Analog:** existing file (sections like `# local env files` / `.env*.local`). Add `eval/golden/private/` and `eval/out/` plus Python `.venv`, `__pycache__`.

## Shared Patterns

### Logging prefix
**Source:** `src/app/api/internal/voice-rag/route.ts` L23, L447 (`console.error('[Internal RAG] ...')`)
**Apply to:** the eval route, harness, legacy-post-filter. Never log secret values; no per-token or per-chunk logs.

### Structured JSON errors
**Source:** `src/lib/api-middleware.ts` L19-34 and voice-rag route
**Apply to:** the eval route. 400 `{ success:false, error, details }` for validation; `{ error }` with status for auth/config failures.

### Env access
**Source:** `src/lib/env.ts` (`env.X`)
**Apply to:** the eval route reads `RAG_EVAL_SECRET` / `RAG_EVAL_ENDPOINT_ENABLED` through `env`; in tests set `process.env` then `vi.resetModules()` before importing.

### Streaming errors (reference only)
**Source:** `src/lib/error-stream.ts` `formatErrorSSE` (L11-14). Relevant to characterization tests that assert the route's in-band error format; the eval route itself is plain JSON, not SSE.

### Naming and style
kebab-case modules, `@/` alias, single quotes, 2-space indent in `src/` (the voice-rag analog uses 4 spaces; use 2 in new files), no new `any`, unused vars prefixed `_`.

## No Analog Found

Planner should use RESEARCH.md patterns directly:

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `eval/harness/*.mts` (PGlite, fake PostgREST, fake embeddings, runner) | harness | request-response | No in-process DB or fake-edge code exists; RESEARCH Patterns 1, 2, 8 and Code Examples |
| `rag-sidecar/**` Python | service | request-response | No Python in the repo; RESEARCH Pattern 10 |
| `eval/src/rag_eval/**` | service | batch | No Python; RESEARCH Patterns 6, 9 |
| `scripts/gen-zod.mjs` | utility | transform | RESEARCH Pattern 4 (deref + `oneOf`->`anyOf` + `zod/v3`) |
| `tests/**`, `vitest.config.ts` | test | request-response | No TS test runner exists (only `baileys-whatsapp` uses Jest, separate package); RESEARCH Pattern 5 mock list; pin `vite@7.3.8` |
| `.github/workflows/*.yml` | config | n/a | No `.github/` directory; RESEARCH Pattern 11 |
| `supabase/*.sql` loading shim | config | batch | Load repo SQL unmodified (RESEARCH Pattern 1); never copy function bodies |

## Metadata

**Analog search scope:** `src/app/api/internal/`, `src/lib/api-middleware.ts`, `src/lib/env.ts`, `src/lib/enhanced-rag-retrieval.ts`, `src/lib/error-stream.ts`, `scripts/`, `scripts/rag/`, `voice-agent/`, `package.json`, `.gitignore`
**Files scanned:** about 12 read, root and `scripts/` listings
**Pattern extraction date:** 2026-11-23
