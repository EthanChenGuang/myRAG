# Coding Conventions

**Analysis Date:** 2026-06-01

## Naming Patterns

**Files:**
- `kebab-case` for all library modules: `chat-store.ts`, `user-settings-store.ts`, `api-middleware.ts`, `document-processor.ts`
- `kebab-case` for most UI components: `chat-message.tsx`, `chat-input.tsx`, `document-dashboard.tsx`
- One exception: `CopyButton.tsx` (PascalCase) exists but is non-standard — follow kebab-case for new files
- API routes always named `route.ts` inside their directory: `src/app/api/chat/route.ts`
- Hooks prefixed `use-`: `use-organization.ts`, `use-audio-settings.ts`, `use-touch-device.ts`
- Stores suffixed `-store`: `chat-store.ts`, `admin-store.ts`, `web-search-store.ts`

**Functions:**
- `camelCase` for all functions and async functions: `fetchChats`, `createChat`, `updateChatTitle`
- Named exports preferred over default exports: `export function Spinner(...)`, `export async function GET(...)`
- Page/layout components use `export default`: `src/app/page.tsx`, `src/app/layout.tsx`
- React components: PascalCase names, named exports: `export function UserMenu(...)`, `export function ShareChatButton(...)`
- Custom hooks: `use` prefix + camelCase: `useCurrentOrganization()`, `useOrganizations()`

**Variables:**
- `camelCase` for local variables and parameters
- `SCREAMING_SNAKE_CASE` for module-level constants: `const STORAGE_BUCKET = 'chat-images'`, `const CURRENT_CHAT_KEY = 'currentChatId'`
- `_prefixed` for intentionally-unused parameters (ESLint `argsIgnorePattern: "^_"`)

**Types:**
- `PascalCase` for interfaces and type aliases: `interface ChatStore`, `type DeploymentMode`
- Component Props: `interface {ComponentName}Props` co-located in the same file
- Context types: `type {Name}ContextType` or `interface {Name}ContextType`
- Store state interface split into data shape (`UserSettings`) + store interface (`UserSettingsState extends UserSettings`)
- Generic Record types used for flexible metadata: `Record<string, any>`
- Exported type-only imports use `import type { ... }` syntax: `import type { Folder } from '@/types/folder'`

## Code Style

**Formatting:**
- No Prettier config detected — formatting is maintained by ESLint + TypeScript strictness
- Single quotes for strings (consistent across `src/`)
- 2-space indentation (TypeScript files)
- Trailing semicolons used throughout

**Linting:**
- ESLint 9 flat config: `eslint.config.mjs`
- TypeScript-ESLint recommended rules enabled
- `no-unused-vars`: warn (not error), ignores `_`-prefixed identifiers
- `@typescript-eslint/no-explicit-any`: warn (not error) — `any` appears in codebase but is treated as smell
- React Hooks rules: `react-hooks/rules-of-hooks` is error; `react-hooks/exhaustive-deps` is warn
- API routes and scripts use `commonjs` source type; browser code uses `module`
- TypeScript `strict: true` mode enforced via `tsconfig.json`

## Import Organization

**Order (conventional, not enforced by tool):**
1. React and framework: `import React, { ... } from 'react'`; `import { NextRequest } from 'next/server'`
2. Third-party libraries: `import { create } from 'zustand'`; `import { z } from 'zod/v3'`
3. Internal `@/` aliases: `import { cn } from '@/lib/utils'`; `import { env } from '@/lib/env'`
4. Relative imports: `import { generateTitle } from './title-generator'`
5. Type-only imports last: `import type { Chat } from './supabase'`

**Path Aliases:**
- `@/*` maps to `./src/*` (configured in `tsconfig.json`)
- Use `@/lib/...`, `@/components/...`, `@/types/...` for cross-directory imports
- Use relative paths only for imports within the same directory

**Zod version:**
- Always import from `'zod/v3'` (not `'zod'` directly): `import { z } from 'zod/v3'`

## Error Handling

**API routes (`src/app/api/`):**
- Wrap entire handler in `try/catch`
- Return structured JSON errors: `NextResponse.json({ error: 'message' }, { status: N })`
- Auth failures: `{ error: 'Not authenticated' }` with `status: 401`
- Validation failures: `{ error: 'Invalid request data', details: [...] }` with `status: 400`
- DB/server errors: `{ error: 'Database error' }` with `status: 500`
- Use `withValidation()` from `src/lib/api-middleware.ts` for Zod-validated routes

**Library code (`src/lib/`):**
- Check `error instanceof Error` before accessing `.message`: `error instanceof Error ? error.message : 'Unknown error'`
- Catch blocks use `catch (error)` (not `catch (e)` — except `catch (e)` appears occasionally in older code)
- Re-throw or surface errors via logger, not silently swallowed

**Streaming errors:**
- Use `formatErrorSSE()` from `src/lib/error-stream.ts` to emit AI SDK v5-compatible SSE error events
- Never use legacy v4 wire format (`3:"msg"`) in streaming responses

**Zod validation:**
- Use `schema.safeParse()` (not `.parse()`) to avoid thrown exceptions
- Check `result.success` before accessing `result.data`

## Logging

**Framework:** Custom `SmartLogger` singleton (`src/lib/logger.ts`)

**Preferred approach:**
```typescript
import { logger } from '@/lib/logger';
// or named helper functions:
import { logError, logInfo, logDebug } from '@/lib/logger';

logger.debug('Component', 'message', optionalData);
logger.error('Component', 'message', error);
logger.info('Component', 'message');
```

**Patterns:**
- Component name is first arg: `logger.debug('UploadUtils', ...)`, `logger.error('Nango', ...)`
- DEBUG logs suppressed in production automatically
- Log deduplication built-in — avoids spam for repeated identical messages
- `console.log` / `console.error` used directly in some API routes (legacy pattern; new code should use `logger`)
- Streaming path: avoid any logging inside `streamText()` callbacks to prevent performance issues

## Comments

**When to Comment:**
- JSDoc blocks on public utility functions and types: `/** @returns ... */`, `/** @param ... */`
- Block comments for non-obvious logic sections: `// Debounce rapid events`
- TODO comments are used sparingly (4 total in `src/`): `// TODO: Add MCP tools detection when implemented`
- Inline comments preferred over block comments for single-line explanations

**JSDoc/TSDoc:**
- Used on exported lib functions (`src/lib/deployment-mode.ts`, `src/lib/api-middleware.ts`, `src/lib/logger.ts`)
- Not required on component props or store methods — TypeScript types serve as documentation there
- `@returns` and `@throws` used where behavior is non-obvious

## Function Design

**Size:** Large functions exist in API routes (chat `route.ts` is 4255 lines) — this is a known concern. New utility functions should be focused, <100 lines.

**Parameters:** Destructured objects preferred for multi-param functions:
```typescript
export function Spinner({ className, size = "md" }: SpinnerProps) { ... }
```

**Return Values:**
- Discriminated unions for success/failure: `{ success: true; data: T } | { success: false; response: NextResponse }`
- Async functions return typed `Promise<T>`: `Promise<string | null>`, `Promise<void>`
- Avoid `Promise<any>` — use specific types where possible

## Module Design

**Exports:**
- Named exports preferred: `export function`, `export const`, `export interface`
- Default exports used only for Next.js page/layout components (`export default function Page()`)
- Re-export via barrel `index.ts` for sub-modules: `src/lib/nango/index.ts`, `src/components/config-ui/connectors/index.ts`

**Barrel Files:** Used selectively for sub-directories only — not for top-level `src/lib/` or `src/components/ui/`

## State Management

**Zustand:**
- Store definition: `create<StoreInterface>()((set, get) => ({ ... }))` 
- Persist middleware: `create<T>()(persist((set, get) => ..., { name: 'storage-key' }))`
- Store consumption: **always** use `useShallow` from `zustand/react/shallow` to select slices:
  ```typescript
  import { useShallow } from 'zustand/react/shallow';
  const { currentChatId, chats } = useChatStore(
    useShallow((s) => ({ currentChatId: s.currentChatId, chats: s.chats }))
  );
  ```
- Never subscribe to the entire store: `useChatStore()` without selector is forbidden

**React Context:**
- Used for cross-cutting concerns: Auth, Theme, Language, TextSize, Font, Artifact, Sources
- Pattern: `createContext<ContextType | undefined>(undefined)` + guard in `useX()` hook
- Providers live in `src/components/providers/`

## 'use client' Directive

- Required on: page components with state/effects, all components in `src/components/providers/`, hooks using browser APIs
- API routes never use it (Node.js runtime)
- Server components (no directive) used for layouts and data-fetch wrappers where possible

---

*Convention analysis: 2026-06-01*
