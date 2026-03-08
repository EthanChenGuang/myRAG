# Coding Conventions

**Analysis Date:** 2026-03-08

## Naming Patterns

**Files:**
- Components: PascalCase for React components (`ChatMessage.tsx`, `ModelSelector.tsx`) but kebab-case filenames dominate (`chat-message.tsx`, `model-selector.tsx`, `ghost-mode-store.ts`)
- Stores: kebab-case with `-store` suffix (`chat-store.ts`, `web-search-store.ts`, `ghost-mode-store.ts`, `reasoning-store.ts`)
- API routes: `route.ts` inside kebab-case directories following Next.js App Router conventions (`src/app/api/chat/route.ts`, `src/app/api/documents/route.ts`)
- Utilities: kebab-case (`date-grouping.ts`, `sanitize-title.ts`, `deployment-mode.ts`)
- Types: kebab-case (`src/types/chat.ts`, `src/types/folder.ts`, `src/types/events.ts`)
- Providers: kebab-case with `-provider` suffix (`auth-provider.tsx`, `model-provider.tsx`, `language-provider.tsx`)
- Hooks: camelCase with `use` prefix for files (`useShareChat.ts`) or kebab-case (`use-mobile-detection.ts`) -- inconsistent

**Functions:**
- Use camelCase: `fetchChats`, `createChat`, `toggleWebSearch`, `getDeploymentMode`
- Boolean getters use `is` prefix: `isSingleTenant()`, `isMultiTenant()`, `isAuthEnabled`
- Event handlers use `handle` prefix: `handleGhostModeToggle`, `handleModelDropdownClosedChange`
- Async operations use descriptive verbs: `fetchModelsFromAPI`, `createBatchEmbeddings`, `searchSimilarChunks`

**Variables:**
- camelCase for local variables and state: `currentChatId`, `isLoading`, `headerLogoText`
- UPPER_SNAKE_CASE for constants: `STORAGE_BUCKET`, `MAX_FILE_SIZE`, `ALLOWED_TYPES`, `CURRENT_CHAT_KEY`
- Environment variables: `NEXT_PUBLIC_` prefix for client-side, plain uppercase for server-side

**Types/Interfaces:**
- PascalCase: `ChatStore`, `ReasoningConfig`, `ExtendedMessage`, `ContentPart`
- Use `interface` for object shapes, `type` for unions and aliases
- Export types alongside implementations in same file (e.g., `src/types/chat.ts`)

## Code Style

**Formatting:**
- No Prettier configured -- formatting is manual/editor-based
- 2-space indentation (observed across all files)
- Single quotes for imports in TypeScript files
- Semicolons used inconsistently (some files omit trailing semicolons in Supabase client files)

**Linting:**
- ESLint 9 flat config at `eslint.config.mjs`
- TypeScript ESLint recommended rules
- `react-hooks/rules-of-hooks`: error
- `react-hooks/exhaustive-deps`: warn
- `no-unused-vars`: warn (with `_` prefix ignore for args and vars)
- `@typescript-eslint/no-explicit-any`: warn (not error -- `any` is used frequently)
- Node-specific overrides for API routes and scripts: `no-undef` off, `@typescript-eslint/no-require-imports` off

**TypeScript:**
- Strict mode enabled in `tsconfig.json`
- `ignoreBuildErrors: true` in `next.config.js` (TypeScript errors do not block builds)
- React Compiler enabled (`reactCompiler: true` in `next.config.js`)
- Path alias: `@/*` maps to `./src/*`

## Import Organization

**Order:**
1. External packages (`react`, `next`, `zustand`, `ai`, `@supabase/*`, `@radix-ui/*`)
2. Internal library imports (`@/lib/*`)
3. Component imports (`@/components/*`)
4. Type imports (`@/types/*`)
5. Relative imports (same directory)

**Path Aliases:**
- `@/*` resolves to `./src/*` -- use this for all internal imports
- Example: `import { cn } from '@/lib/utils'`

**Patterns:**
- Use `import type` for type-only imports: `import type { AuthUser } from '@/lib/supabase-auth'`
- Named exports preferred over default exports (except for pages/layouts)
- Barrel re-exports not commonly used

## Error Handling

**API Routes:**
- Wrap entire handler in try/catch
- Return structured JSON errors with `NextResponse.json()`:
```typescript
return NextResponse.json(
  { success: false, error: 'descriptive message', details: errorInfo },
  { status: 400 }
);
```
- Use Zod validation via `src/lib/api-middleware.ts` (`validateRequest` and `withValidation` helpers)
- Log errors with `console.error()` or `logger.error()` before returning error response

**Client-side:**
- Use try/catch around async operations (fetch, Supabase calls)
- Log errors with `console.error()` -- no user-facing toast pattern standardized
- Silently swallow certain errors in cookie handling (Supabase SSR server components)

**Patterns to follow:**
```typescript
// API route pattern
export async function POST(request: NextRequest) {
  try {
    // ... business logic
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Context description:', error);
    return NextResponse.json(
      { success: false, error: 'User-facing message' },
      { status: 500 }
    );
  }
}
```

## Logging

**Framework:** Custom `SmartLogger` singleton at `src/lib/logger.ts` plus `devLog` utility at `src/lib/dev-logger.ts`

**SmartLogger (`src/lib/logger.ts`):**
- Singleton with deduplication to prevent log spam
- Domain-specific methods: `logger.startup()`, `logger.env()`, `logger.db()`, `logger.mcp()`, `logger.api()`, `logger.admin()`
- General methods: `logger.error()`, `logger.warn()`, `logger.info()`, `logger.debug()`
- `logger.error()` always prints; `logger.debug()` only in development
- Backwards-compatible helper exports: `logStartup`, `logEnv`, `logDb`, `logMcp`, `logApi`, `logError`, `logWarn`, `logInfo`, `logDebug`

**devLog (`src/lib/dev-logger.ts`):**
- Client-side development logging
- `devLog.log()` for dev-only, `devLog.verbose()` for opt-in verbose, `devLog.error()` always
- `devLog.perf()` for performance measurement

**When to use which:**
- API routes / server logic: Use `logger` from `@/lib/logger`
- Client components: Use `devLog` from `@/lib/dev-logger` or `console.log` (many files still use raw console)
- Avoid excessive logging in production; use the SmartLogger deduplication

## Comments

**When to Comment:**
- JSDoc-style comments on exported functions with `@param`, `@returns`, `@throws` tags (seen in `src/lib/deployment-mode.ts`, `src/lib/api-middleware.ts`)
- Inline `// Debug:` comments (many left as stubs from removed logging -- see `src/components/providers/auth-provider.tsx`)
- Section dividers with comments in large files (e.g., `// Desktop Layout`, `// Mobile + Tablet Layout`)
- `// TODO`, `// FIXME` used sparingly

**JSDoc/TSDoc:**
- Used on utility/library functions, especially in `src/lib/`
- Not commonly used on React components or hooks

## Function Design

**Size:** No enforced limits. Many component files are very large (4000-5000+ lines for `page.tsx`, `chat-input.tsx`, `chat-message.tsx`, `chat route.ts`)

**Parameters:**
- Destructure props in function signatures for React components
- Use typed interfaces for complex parameter objects
- Optional parameters use `?` suffix

**Return Values:**
- API routes return `NextResponse.json()` with `{ success, data }` or `{ success, error }` shape
- Store actions return `Promise<void>` or `Promise<string | null>` for create operations
- Boolean utility functions return plain `boolean`

## Module Design

**Exports:**
- Named exports strongly preferred: `export function`, `export const`, `export interface`
- Default exports only for Next.js pages/layouts and the Framer Motion features bundle
- Singletons use class with `getInstance()` pattern: `EnvironmentConfig`, `SupabaseManager`, `SmartLogger`

**Barrel Files:**
- Not used -- import directly from source files

## State Management

**Pattern:** Zustand stores with the following conventions:
- Create store with `create<StoreType>()` from `zustand`
- Define store interface before implementation
- Export the hook: `export const useChatStore = create<ChatStore>(...)`
- Access in components with `useShallow` selector from `zustand/react/shallow`:
```typescript
const { currentChatId, chats } = useChatStore(
  useShallow((s) => ({ currentChatId: s.currentChatId, chats: s.chats }))
);
```

**Store locations:**
- Feature stores in `src/lib/`: `chat-store.ts`, `web-search-store.ts`, `file-upload-store.ts`, `ghost-mode-store.ts`, `user-settings-store.ts`, `admin-store.ts`, `document-mention-store.ts`
- Grouped stores in `src/lib/stores/`: `reasoning-store.ts`, `organization-store.ts`

## Component Patterns

**Client Components:**
- Mark with `'use client'` directive at top of file
- Use React Context for cross-cutting concerns (`AuthProvider`, `ModelProvider`, `LanguageProvider`, `TextSizeProvider`, `FontProvider`, `SourcesProvider`, `ArtifactProvider`)
- Providers nested in `src/app/client-layout.tsx`

**UI Components:**
- shadcn/ui pattern at `src/components/ui/` using Radix primitives + `cva` for variants + `cn()` for class merging
- `forwardRef` pattern for composable primitives (e.g., `Button`)
- Tailwind CSS for all styling; no CSS modules
- Dark mode via CSS variables and `dark:` Tailwind prefix

**Styling utility:**
- `cn()` from `src/lib/utils.ts` (combines `clsx` + `tailwind-merge`)
- Use for all conditional class names

## Validation

**Schema validation:** Zod (`zod/v3` -- note the `/v3` import path)
- API request validation via `src/lib/api-middleware.ts`
- Tool input schemas defined with `z.object()` in AI SDK tool definitions
- Example:
```typescript
const schema = z.object({
  documentId: z.string(),
  relevance: z.number().min(0).max(100),
});
```

## Internationalization

**Pattern:** Custom translation system in `src/translations/`
- Type-safe translation keys derived from English source (`src/translations/en.ts`)
- `useLanguage()` hook provides `t()` function
- 18 languages supported
- Access: `const { t } = useLanguage(); t('newChat')`

---

*Convention analysis: 2026-03-08*
