# Coding Conventions

**Analysis Date:** 2026-03-08

## Naming Patterns

**Files:**
- Components: kebab-case `.tsx` files (e.g., `src/components/ui/chat-message.tsx`, `src/components/ui/ghost-mode-indicator.tsx`)
- Exception: PascalCase for some components (e.g., `src/components/ui/CopyButton.tsx`) -- not preferred, kebab-case is the dominant pattern
- Library modules: kebab-case `.ts` files (e.g., `src/lib/chat-store.ts`, `src/lib/deployment-mode.ts`)
- Stores: `*-store.ts` suffix (e.g., `src/lib/chat-store.ts`, `src/lib/ghost-mode-store.ts`, `src/lib/web-search-store.ts`)
- Hooks: `use-*.ts` prefix with kebab-case (e.g., `src/hooks/use-mobile-detection.ts`, `src/lib/hooks/use-audio-settings.ts`)
- Exception: camelCase hook in `src/hooks/useShareChat.ts` -- not preferred
- Types: kebab-case `.ts` files in `src/types/` (e.g., `src/types/chat.ts`, `src/types/folder.ts`)
- API routes: `route.ts` inside directory-based routing (e.g., `src/app/api/chat/route.ts`)

**Functions:**
- Use camelCase for all functions: `fetchChats`, `createChat`, `getStoredChatId`
- React components use PascalCase: `Header`, `ChatMessage`, `Button`
- Boolean getters use `is`/`has` prefix: `isSingleTenant()`, `isMultiTenant()`, `hasUnsavedGhostMessages`
- Store hooks use `use` prefix with PascalCase store name: `useChatStore`, `useReasoningStore`, `useGhostModeStore`

**Variables:**
- camelCase for local variables and state: `currentChatId`, `isLoading`, `searchQuery`
- UPPER_SNAKE_CASE for constants: `STORAGE_BUCKET`, `CURRENT_CHAT_KEY`, `BREAKPOINTS`
- Environment variables: `NEXT_PUBLIC_*` for client-accessible, plain `UPPER_SNAKE` for server-only

**Types:**
- PascalCase for interfaces and types: `ChatStore`, `MobileDetectionResult`, `ContentPart`
- Interface names describe the shape directly (no `I` prefix): `ChatMessageProps`, `HeaderProps`, `ButtonProps`
- Type exports use `type` keyword for type-only imports: `import type { Chat } from '@/lib/supabase'`

## Code Style

**Formatting:**
- No Prettier config detected -- formatting is handled implicitly by ESLint and editor settings
- Semicolons are used consistently
- Single quotes for string literals (TypeScript/JSX)
- 2-space indentation (observed in all source files)
- Trailing commas in multi-line objects/arrays

**Linting:**
- ESLint 9 flat config at `eslint.config.mjs`
- TypeScript-ESLint recommended rules enabled
- `no-unused-vars`: warn (with `_` prefix ignore pattern for args and vars)
- `@typescript-eslint/no-explicit-any`: warn (not error -- `any` is used liberally throughout)
- React hooks rules enforced: `rules-of-hooks` (error), `exhaustive-deps` (warn)
- Node globals allowed in API routes and scripts (`no-undef: off`)
- Run: `npm run lint` or `npm run lint:fix`

**TypeScript:**
- Strict mode enabled in `tsconfig.json`
- `typescript.ignoreBuildErrors: true` in `next.config.js` -- builds proceed despite TS errors
- React Compiler enabled (`reactCompiler: true` in `next.config.js`)
- Target: ES2017, Module: ESNext, Module Resolution: bundler

## Import Organization

**Order:**
1. External packages (React, Next.js, third-party libraries)
2. Internal absolute imports using `@/` alias
3. Relative imports (rare, mostly within same directory)
4. Type-only imports using `import type { ... }`

**Path Aliases:**
- `@/*` maps to `./src/*` (configured in `tsconfig.json`)
- Always use `@/` for cross-directory imports: `@/lib/utils`, `@/components/ui/button`, `@/types/chat`
- Relative imports only within the same module/directory

**Examples from `src/app/page.tsx`:**
```typescript
import { useChat } from '@ai-sdk/react';           // External
import { DefaultChatTransport, type UIMessage } from 'ai';  // External
import { ChatInput } from '@/components/ui/chat-input';     // Internal component
import { cn } from '@/lib/utils';                           // Internal utility
import { useChatStore } from '@/lib/chat-store';            // Internal store
import { useShallow } from 'zustand/react/shallow';         // External (Zustand)
import type { Chat } from '@/lib/supabase';                 // Type-only import
```

## Error Handling

**API Routes:**
- Wrap handler body in `try/catch` blocks
- Return structured JSON errors with `success: false` and descriptive `error` message
- Use appropriate HTTP status codes (400 for validation, 500 for server errors)
- Log errors with `console.error()` before returning
- Pattern from `src/app/api/documents/[id]/route.ts`:
```typescript
try {
  // ... operation
  return new Response(JSON.stringify({ success: true }), { status: 200 });
} catch (error) {
  console.error('Error deleting document:', error);
  return new Response(
    JSON.stringify({ error: 'Failed to delete document' }),
    { status: 500, headers: { 'Content-Type': 'application/json' } }
  );
}
```

**Validation:**
- Use Zod schemas for request body validation via `src/lib/api-middleware.ts`
- `withValidation(schema, handler)` HOF wraps route handlers with automatic validation
- `validateRequest(req, schema)` for inline validation returning discriminated union
- Zod imported from `'zod/v3'` (AI SDK 5 compatibility)

**Client-side:**
- Errors surfaced via store state (`error: string | null` pattern in Zustand stores)
- `console.error()` for logging; no centralized error boundary observed

## Logging

**Framework:** Two logging utilities coexist:

1. **`src/lib/logger.ts`** - `SmartLogger` class with deduplication and log levels (`ERROR`, `WARN`, `INFO`, `DEBUG`)
   - Deduplicates repeated log messages (30-second window, max 2 duplicates)
   - Methods: `logger.debug()`, `logger.startup()`, `logger.error()`
   - Server-side focused

2. **`src/lib/dev-logger.ts`** - `devLog` object for development logging
   - `devLog.log()` - dev-only logging
   - `devLog.verbose()` - requires `NEXT_PUBLIC_VERBOSE_LOGGING=true`
   - `devLog.error()` - always logs
   - `devLog.warn()` - dev-only
   - `devLog.perf()` - performance timing (verbose mode)
   - `devLog.lifecycle()` - component lifecycle (requires explicit flag)

**Patterns:**
- Prefix log messages with `[ModuleName]` brackets: `[ReasoningStore]`, `[Document Reference Tool]`
- Use `console.error` directly in catch blocks
- Avoid log spam: use `devLog` or `logger` instead of raw `console.log` in production paths
- Many raw `console.log` calls still exist in API routes (e.g., `src/app/api/chat/route.ts` lines 75-79)

## Comments

**When to Comment:**
- JSDoc-style comments on utility functions and classes (`src/lib/deployment-mode.ts`, `src/lib/api-middleware.ts`)
- Inline comments for non-obvious logic or "why" explanations
- TODO/FIXME comments for known gaps (explored in CONCERNS.md)
- Keep comments minimal per project guidelines

**JSDoc/TSDoc:**
- Used on exported utility functions with `@param` and `@returns` tags
- Not used on React components (props interfaces serve as documentation)
- Example from `src/lib/deployment-mode.ts`:
```typescript
/**
 * Check if the application is running in single-tenant mode
 * @returns true if in single-tenant mode
 */
export function isSingleTenant(): boolean {
```

## Function Design

**Size:**
- No enforced limit; some files are very large (page.tsx: 4685 lines, chat-message.tsx: 5586 lines, chat/route.ts: 4226 lines)
- Utility modules are kept small and focused (e.g., `src/lib/utils.ts`: 7 lines, `src/lib/deployment-mode.ts`: 105 lines)

**Parameters:**
- Destructured object parameters for React components: `({ className, variant, size, ...props })`
- Zustand stores use `(set, get)` creator pattern
- API handlers receive `(request: NextRequest)` or `(request: NextRequest, { params })` for dynamic routes
- In Next.js 16, `params` is a Promise and must be awaited: `const { id } = await params;`

**Return Values:**
- API routes return `NextResponse.json()` or `new Response(JSON.stringify(...))`
- Store actions return `Promise<void>` or `Promise<string | null>` for creation
- Utility functions return typed values

## Module Design

**Exports:**
- Named exports preferred over default exports for components and utilities
- Default export used sparingly (e.g., `export default devLog` in `src/lib/dev-logger.ts`)
- React components: `export function ComponentName() {}` or `const Component = React.forwardRef(...)` + named export
- Stores export the hook directly: `export const useChatStore = create<ChatStore>(...)`

**Barrel Files:**
- Not used in this codebase -- import directly from specific files
- No `index.ts` barrel files in `src/lib/` or `src/components/ui/`

## State Management

**Zustand Stores:**
- Pattern: `create<StoreType>((set, get) => ({ ... }))`
- Located in `src/lib/*-store.ts` and `src/lib/stores/*.ts`
- Always use `useShallow` from `zustand/react/shallow` when selecting multiple properties:
```typescript
const { currentChatId, chats } = useChatStore(
  useShallow((s) => ({ currentChatId: s.currentChatId, chats: s.chats }))
);
```
- Store interfaces defined above the `create` call
- LocalStorage persistence done manually with `getItem`/`setItem` (not Zustand middleware)

**React Context:**
- Providers in `src/components/providers/` for cross-cutting concerns: auth, model, theme, language, text-size, font, sources, artifacts, markdown
- Pattern: `createContext` + `useContext` + custom `useXxx` hook
- Located at `src/components/providers/{name}-provider.tsx`

## Component Patterns

**Client Components:**
- Marked with `'use client'` directive at top of file (98 client component files)
- No `'use server'` directives detected -- server actions not used

**Shadcn/ui Base Components:**
- Located in `src/components/ui/` with CVA (class-variance-authority) for variants
- Use `cn()` utility from `src/lib/utils.ts` for class merging (clsx + tailwind-merge)
- `React.forwardRef` pattern for primitive UI components (`Button`, `Input`, etc.)

**Styling:**
- Tailwind CSS 3.4 with `tailwindcss-animate` plugin
- `cn()` for conditional/merged classes
- Inline style objects for dynamic values (e.g., theme-dependent colors in `src/components/ui/header.tsx`)
- Framer Motion for animations (`motion` components, `AnimatePresence`)

## Singleton Patterns

- `EnvironmentConfig` in `src/lib/env.ts`: private constructor + `getInstance()`
- `SupabaseManager` in `src/lib/supabase.ts`: same singleton pattern
- Used for one-time initialization of config and database connections

---

*Convention analysis: 2026-03-08*
