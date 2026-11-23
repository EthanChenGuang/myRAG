---
last_mapped_commit: 41a47818ac26f9ea788ccb18230fb3351065c2a2
last_mapped_at: 2026-11-22
---
# Coding Conventions

**Analysis Date:** 2026-11-22

## Naming Patterns

**Files:**
- kebab-case for all TypeScript modules: `src/lib/chat-store.ts`, `src/lib/query-classifier.ts`, `src/lib/whatsapp/types.ts`
- React components also use kebab-case filenames with PascalCase exports: `src/components/ui/sidebar.tsx` exports `Header`, `ChatInput`, `CollapsibleButton`
- Next.js route files use the framework names: `src/app/api/chat/route.ts`, `src/app/api/chat/approve/route.ts`
- Scripts under `scripts/` use kebab-case `.js`: `scripts/rag/check-rag-flow.js`, `scripts/whatsapp/tests/test-formatting.js`

**Functions:**
- camelCase for functions and hooks: `validateRequest`, `withValidation` in `src/lib/api-middleware.ts`, `getQueryEmbedding` in `src/lib/document-processor.ts`
- Named function declarations for exported components and helpers: `export function Header(...)` in `src/components/ui/header.tsx`
- `React.memo(function Name(...))` and `forwardRef<Handle, Props>(function Name(...))` for memoized/ref-forwarding components, e.g. `src/components/ui/` `CopyButton`, `ChatInput`

**Variables:**
- camelCase for locals; module-level constants in SCREAMING_SNAKE_CASE: `STORAGE_BUCKET`, `CURRENT_CHAT_KEY` in `src/lib/chat-store.ts`, `DOCUMENT_URL_MAP` and `documentReferenceTool` in `src/app/api/chat/route.ts`
- Unused variables must be prefixed with `_` to satisfy the lint rule (`argsIgnorePattern: "^_"`, `varsIgnorePattern: "^_"`)

**Types:**
- PascalCase interfaces and type aliases, typically named `*Props`, `*State`, `*Store`, `*Input`: `ChatStore` and `CreateFolderInput` in `src/lib/chat-store.ts`, `ExtendedMessage` and `DBMessage` in `src/types/chat.ts`
- Prefer `interface` for object shapes (`src/types/chat.ts`); use `type` for unions and imported type-only symbols (`import type { ... }`)
- Enums are used sparingly for fixed sets: `LogLevel` in `src/lib/logger.ts`

**Event and constant identifiers:**
- Client events are namespaced strings: `ChatEvents.CHAT_CREATED = 'myrag:chat_created'` in `src/lib/chat-store.ts`

## Code Style

**Formatting:**
- No Prettier config at the repository root. The app code in `src/` uses 2-space indentation (no tab-indented files found) and single quotes for imports and strings (about 333 `src/` files import with single quotes versus about 30 with double quotes)
- Semicolons are used in most files, but not uniformly; match the surrounding file rather than reformatting
- `baileys-whatsapp/.prettierrc` is the only explicit Prettier configuration: tabs (`useTabs: true`, `tabWidth: 2`), `semi: false`, `singleQuote: true`, `jsxSingleQuote: true`, `arrowParens: "avoid"`, `printWidth: 120`, `trailingComma: "none"`. Apply these settings only inside `baileys-whatsapp/`

**Linting:**
- ESLint flat config at `eslint.config.mjs` extending `@eslint/js` recommended and `typescript-eslint` recommended
- `no-unused-vars` is `warn` with `_`-prefix ignore patterns
- `@typescript-eslint/no-explicit-any` is `warn`. The codebase still uses `any` heavily (roughly 800 occurrences under `src/`), so new code should type values explicitly and avoid adding new `any`
- `react-hooks/rules-of-hooks` is `error`; `react-hooks/exhaustive-deps` is `warn` for files under `src/**`
- Node-side files (`src/app/api/**`, `scripts/**`) turn off `no-undef` and `@typescript-eslint/no-require-imports`, so CommonJS `require` is acceptable in scripts
- `.eslintignore` ignores all files (`**/*`) so ESLint does not block Vercel builds; run `npm run lint` explicitly before handoff
- Suppression comments are rare (about 4 `eslint-disable`/`@ts-ignore` occurrences under `src/`); do not add new ones without a reason

**TypeScript:**
- Root `tsconfig.json` has `strict: true`, `target: ES2018`, `moduleResolution: bundler`, `isolatedModules: true`, and the `@/*` path alias mapped to `./src/*`
- `baileys-whatsapp/tsconfig.json` additionally enables `noUncheckedIndexedAccess` and `verbatimModuleSyntax`; code in that service must use `import type` for type-only imports

## Import Organization

**Order (observed in `src/app/api/chat/route.ts` and `src/lib/chat-store.ts`):**
1. Framework and third-party packages (`ai`, `zod/v3`, `next/server`, `zustand`, `@supabase/...`)
2. Project modules via the `@/` alias (`@/lib/supabase`, `@/lib/env`, `@/types/chat`)
3. Relative imports (`./supabase`, `./title-generator`)
4. `import type` statements are commonly grouped at the end of the import block

**Path Aliases:**
- `@/*` → `src/*` (defined in `tsconfig.json`). Prefer it over deep relative paths such as `../../../lib/...`. Use relative imports only for siblings within the same folder (e.g. `./supabase` inside `src/lib/`)

## Error Handling

**API routes (Next.js `src/app/api/**`):**
- Return structured JSON errors with `NextResponse.json({ error: '...' }, { status: N })`, for example `src/app/api/generate-image/route.ts`
- Validate request bodies with Zod through `withValidation(schema, handler)` or `validateRequest(req, schema)` from `src/lib/api-middleware.ts`. Validation failures return HTTP 400 with `{ success: false, error, details: [{ path, message }] }`
- Use `z` from `zod/v3` in API code (this import path is the established pattern in `src/app/api/chat/route.ts` and `src/lib/api-middleware.ts`)
- Streaming chat responses report errors in-band with `formatErrorSSE(message)` from `src/lib/error-stream.ts`, which emits a UI-message-stream `error` event followed by `[DONE]`. Do not emit the legacy v4 wire format

**Client and store code:**
- Zustand store actions catch Supabase errors and write a human-readable string into `error` state (`ChatStore.error` in `src/lib/chat-store.ts`) rather than throwing into components
- Domain errors extend `Error`: `WhatsAppError` in `src/lib/whatsapp/types.ts`

**Patterns:**
- Wrap `JSON.parse`/`req.json()` in try/catch and return a 400 on failure (see `validateRequest`)
- Log the failure with a bracketed prefix before returning (see Logging)

## Logging

**Framework:** `console` with a shared `logger` in `src/lib/logger.ts` (`SmartLogger`), which deduplicates repeated messages (max 2 repeats within 30 seconds) and suppresses DEBUG and ENV INFO logs outside `NODE_ENV === 'development'`

**Patterns:**
- Prefix every log line with a bracketed tag naming the subsystem: `console.log('[Document Reference Tool] ...')`, `console.error('[Nango] ...')`, `console.log('[RAG SYSTEM] ...')`, `console.error('[ToolExecutionState] ...')`
- Use `[Document Search]` for retrieval diagnostics (required by `AGENTS.md` section 6)
- Log structured data as a second argument object rather than string concatenation: `console.log('[Document Reference Tool] Document referenced:', { documentId, documentName })`
- Avoid log spam in hot paths (streaming loops, per-token handlers); the codebase already has many verbose `[DEBUG]` lines, so do not add new unconditional debug logs. Prefer `logger` for anything that should be silenced in production
- Never log API key values; log presence or length only (see the `OPENROUTER_API_KEY_STATUS` pattern in `src/app/api/chat/route.ts`)

## Comments

**When to Comment:**
- Keep comments minimal (per `AGENTS.md` section 4). Comments explain why a non-obvious workaround exists, e.g. the explanation of the v5 SSE payload in `src/lib/error-stream.ts`
- Section headers with `// ---` or `// Folder management` labels group related members inside a large interface (`src/lib/chat-store.ts`)

**JSDoc/TSDoc:**
- Used on exported utilities and public helpers with `@param` / `@returns` tags, e.g. `validateRequest` and `withValidation` in `src/lib/api-middleware.ts`
- Not required on components or internal helpers

## Function Design

**Size:** Route handlers and chat orchestration are very large (`src/app/api/chat/route.ts` exceeds 1,000 lines). Do not extend that file further when a helper module under `src/lib/` fits; new retrieval or tool logic belongs in `src/lib/`.

**Parameters:** Positional for 1-2 arguments; object or interface props for components (`ChatInputProps`, `HeaderProps`). Options objects for store actions (`CreateFolderInput`, `UpdateFolderInput`).

**Return Values:** Async functions return `Promise<T | null>` or `Promise<void>` for store actions (`createChat` returns `string | null`). Route helpers return `NextResponse`. Validation helpers return a discriminated union: `{ success: true; data } | { success: false; response }`.

## Module Design

**Exports:** Named exports are the norm. Default exports appear only for Next.js pages and layouts. Export interfaces alongside the function that uses them.

**Zustand stores:**
- Create stores with `create<State>()(...)` (`src/lib/user-settings-store.ts`) or `create<State>((set) => ...)` (`src/lib/stores/voice-store.ts`)
- Subscribe in components with selectors and `useShallow` from `zustand/react/shallow`, selecting only the fields a component needs. Example from `src/components/ui/sidebar.tsx`:
```typescript
const {
  chats,
  fetchChats,
  setCurrentChat,
} = useChatStore(
  useShallow((s) => ({
    chats: s.chats,
    fetchChats: s.fetchChats,
    setCurrentChat: s.setCurrentChat,
  }))
)
```
- Single-field selectors are fine without `useShallow`: `useChatStore((s) => s.currentChatId)`. Never call `useChatStore()` without a selector in components

**Barrel Files:** Not a dominant pattern. Import concrete modules (`@/lib/supabase`, `@/lib/whatsapp/...`). `@/translations` is the one barrel-style entry point used by routes.

**React:**
- Functional components only; the React Compiler is enabled in `next.config.js`, so avoid manual `useMemo`/`useCallback` unless a dependency genuinely needs stability
- Tailwind utility classes for styling; merge conditional classes with `cn()` from `src/lib/utils.ts` (wraps `clsx` and `tailwind-merge`)
- Animations use Framer Motion; icons come from `lucide-react` and `@tabler/icons-react`
- Radix primitives are wrapped under `src/components/ui/` (shadcn style, configured by `components.json`)

**Prompts:** `RAG_SYSTEM_PROMPT` strings must keep the `{{context}}` placeholder intact (`AGENTS.md` section 6).

**Environment variables:** Read through `env` from `src/lib/env.ts` in server code. Any new variable must be mirrored in `scripts/init-env.js` and the other model/config locations listed in `AGENTS.md` section 7.

---

*Convention analysis: 2026-11-22*
