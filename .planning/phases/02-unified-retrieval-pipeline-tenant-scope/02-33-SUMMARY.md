---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 33
subsystem: ui
tags: [typescript, react-19, tsc-ratchet, sidebar, translations]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: tsc ratchet baseline and typegen step (02-01), embed and page type fixes (02-32)
provides:
  - Zero tsc errors in src/components (providers, settings, MCP tools hook, tooltip, sidebar, text-size modal, video button)
  - Sidebar reducer UPDATE_SEARCH_QUERY action that now stores the query
  - textSettings translation key
affects: [ci-tsc-ratchet]

requirements-completed: [PIPE-01]

actuals:
  tokens: 15000
  tasks: 2
  commits: 3
plan_head_before: 2495420ec06906ac16b2a66b8f23401794c9390b
plan_head_after: 35fa8af884284477361fc911c2ca38f6730ee101

tech-stack:
  added: []
  patterns:
    - "React 19 useRef timers declared as useRef<T | undefined>(undefined)"
    - "Translation lookup reads through a Partial<Record<TranslationKeys, unknown>> view and returns only string values"

key-files:
  created:
    - tests/ui/sidebar-reducer.test.ts
  modified:
    - src/components/providers/auth-provider.tsx
    - src/components/providers/language-provider.tsx
    - src/components/providers/model-provider.tsx
    - src/components/ui/mcp-tools/hooks/useMCPToolsModal.ts
    - src/components/ui/settings/SettingsModal.tsx
    - src/components/ui/settings/components/DebouncedSelect.tsx
    - src/components/ui/settings/hooks/useSettingsModal.ts
    - src/components/ui/portal-tooltip.tsx
    - src/components/ui/sidebar-handlers.ts
    - src/components/ui/sidebar-reducer.ts
    - src/components/ui/video-generation-button.tsx
    - src/translations/en.ts

key-decisions:
  - "Folder is imported from @/types/folder (its actual home), not @/lib/chat-store as the plan hinted"
  - "SidebarState gains a searchQuery field so UPDATE_SEARCH_QUERY has something to update"

metrics:
  duration: ~25min
  completed: 2026-11-23
---

# Phase 2 Plan 33: Component type fixes Summary

Removed all 23 remaining tsc errors under src/components (React 19 useRef initial values, typed auth callback, translation-key typing, tooltip cloneElement props, sidebar reducer action union), with a reducer test written first.

## Tasks

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | Providers, settings hooks and MCP tools hook | b6784fb |
| 2 (RED) | Failing sidebar reducer tests (fail on assertions) | 2c14da7 |
| 2 (GREEN) | Tooltip, sidebar, text-size modal, video button | 35fa8af |

## What changed

- auth-provider: `onAuthStateChange` callback typed with `AuthChangeEvent` and `Session | null`.
- language-provider: `t` reads the language table through a `Partial<Record<TranslationKeys, unknown>>` view and returns the localized value only when it is a non-empty string, else the English string, else the key.
- model-provider: `detectReasoningSupport` return type widened to include `'none'` (matches the Model interface and AGENTS.md section 7).
- useMCPToolsModal, DebouncedSelect, useSettingsModal: `useRef<T | undefined>(undefined)`.
- SettingsModal: tab definitions typed with `label: TranslationKeys`, so `t(label)` type-checks.
- portal-tooltip: `children` typed as `React.ReactElement<TooltipChildProps>` so `cloneElement` and `children.props` handlers are typed.
- sidebar-handlers: `Folder` imported from `@/types/folder`.
- sidebar-reducer: `UPDATE_SEARCH_QUERY` added to the action union, `searchQuery` added to state, collapsed-folder Set typed as `Set<string>`.
- mobile-text-size-modal: no edit needed; the `textSettings` key added to en.ts resolves its error.
- video-generation-button: the four configure-only configs pass `localSourceImageData` instead of the `File`.

## Intended behaviour changes

1. Sidebar reducer: `UPDATE_SEARCH_QUERY` was unreachable (missing from the union) and its case returned state unchanged. It now stores `query` in a new `searchQuery` state field, and `CLEAR_SEARCH` resets it to `''`. The reducer hook is not imported anywhere else yet, so there is no runtime impact today. Covered by tests/ui/sidebar-reducer.test.ts.
2. `textSettings` translation: the mobile text-size modal title used a missing key and rendered the raw key text. It now renders "Text Settings" (other languages fall back to English via `t`).
3. Video generation button: configure-only configs (aspect ratio, resolution, duration, audio toggles) passed the raw `File` as `sourceImage`; the config type expects `SourceImageData`. They now pass the already-uploaded `localSourceImageData`, the same value `buildConfig` uses.
4. `t()` now ignores non-string translation entries (the `aspectRatios` and `resolutionOptions` objects) and falls back to English or the key. Nothing calls `t` with those keys.

## Deviations from Plan

None beyond the points above. Folder lives in `src/types/folder.ts`, not in chat-store as the plan's read_first suggested; used the real location.

## Verification

- `npx tsc --noEmit` reports 0 errors under `src/components/`.
- `npx vitest run`: 30 files, 215 tests pass.
- `npx next typegen` then `node scripts/ci/tsc-ratchet.mjs`: ok, 99 errors total, 51 files improved.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

Commits b6784fb, 2c14da7 and 35fa8af present; tests/ui/sidebar-reducer.test.ts exists.
