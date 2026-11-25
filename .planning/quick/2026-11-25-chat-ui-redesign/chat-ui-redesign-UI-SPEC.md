---
phase: "quick"
slug: "chat-ui-redesign"
surface: "Web chat (src/app/page.tsx): top bar, message list, composer dock, user bubble, assistant action row, source and citation pills, sidebar chat rows, settings button; light and dark; phone (iPhone 15) and desktop (1280px)"
status: approved
reviewed_at: 2026-11-25
shadcn_initialized: true
preset: "none recorded (components.json: style new-york, base colour neutral, CSS variables, lucide icons)"
created: "2026-11-25"
---

# Chat UI redesign: UI design contract

> Visual and interaction contract for the chat surface. Written with the `frontend-design` skill in the
> gsd-ui-researcher role (no interactive questions; the owner's brief is the decision record). Branch
> `feat/mobile-chat-glass-layout`.

**Owner brief (decisions, not options).** A polished chat app on the level of the Claude mobile app: capsule (pill)
controls, a calm warm-neutral palette, generous spacing, thin-stroke lucide icons, soft translucent glass bars at the top
and bottom, and a bottom-pinned composer with a rounded card and pill controls. The product keeps its name and its own
colours; the accent stays in the existing orange family. No Anthropic or Claude marks, fonts, illustrations or assets.

**Domain neutrality.** No copy, example or placeholder names a subject area. The only copy this contract touches is the
existing translated disclaimer and placeholder.

---

## 0. Findings that shape this contract

1. **The composer floats mid-screen on iPhone because three safe-area paddings stack.** The dock wrapper has `pb-safe`
   (`env(safe-area-inset-bottom)`, or `max(…, 20px)` outside Safari), `.chat-input-container` adds
   `calc(env(safe-area-inset-bottom) + 25px)` and `min-height: calc(100px + env(...))` in WebKit, and an opaque disclaimer
   strip sits under it, with a second copy of the disclaimer from `page.tsx` on non-Safari browsers. About 120px of empty
   band results. One dock owns the inset once (section 5.2).
2. **`* { transform: translateZ(0) }` on phones with DPR ≥ 2** (`globals.css`, "High DPI mobile screens") gives every element a
   transform, so every `position: fixed` element is positioned against its nearest ancestor instead of the viewport, and
   `backdrop-filter` samples a flattened layer. Removed; the glass and the pinned dock depend on it.
3. **iOS ignores `interactive-widget`.** Chrome on Android honours `interactive-widget=resizes-content`, so a fixed bottom
   dock lands on the keyboard by itself. iOS Safari and iOS Chrome keep the layout viewport and shrink only the visual
   viewport, so the dock needs the gap between the two (section 5.3).
4. **Two viewport metas.** `layout.tsx` exports a viewport and `client-layout.tsx` hard-codes a second
   `<meta name="viewport">` with `maximum-scale=1`; zoom is disabled twice. One source remains (layout.tsx), with zoom on.
5. **`chat-message.tsx` renders both the user bubble and the assistant message and is being edited by the parallel
   `feat/chat-followup-chips` PR.** Bubble and action-row styling is therefore applied from the chat stylesheet through the
   existing class hooks (`.chat-message.rounded-[20px]`, the 32px action buttons), with no edit to that file.
6. **Colours are hard-coded in hundreds of places** (`#FFF1E5`, `#212121`, `#EFE1D5`, `#FFE0D0`). The canvas colours are
   the product's own and stay; the redesign introduces tokens for the chat surface and calms the peach tints on chrome.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | shadcn (new-york), used for menus and tooltips already in place |
| Preset | not applicable |
| Component library | radix |
| Icon library | lucide-react 0.471 |
| Font | Instrument Sans (UI chrome) via `next/font/google`; message text keeps the reader-selected font (FontProvider, default Inter) |

### Font choice (frontend-design)

- **Instrument Sans** for chrome: model pill, composer text and placeholder, disclaimer, sidebar rows, settings sheet. It is an
  open (OFL) grotesk with a slightly condensed, calm rhythm and soft terminals; at 13 to 16px it reads warmer than Inter
  without the geometric coldness of a pure grotesque, which is the feel of a humanist chat chrome. Weights 400, 500, 600.
- Assistant answers and the user bubble keep the reader's font setting (Inter by default, Merriweather and others selectable). An open serif
  for long-form answers (Source Serif 4) is the natural next step but needs `chat-message.tsx`; deferred until the
  follow-up-chips PR lands (finding 5).
- Rejected: Inter for chrome (the default of every generated interface), any licensed face.

## Component Inventory

Enumerated by `ls src/components/ui/*.tsx` on 2026-11-25. Components this contract touches:

| Component | Import path | Notes |
|-----------|-------------|-------|
| Header | `@/components/ui/header` | Top bar; gets the glass class and pill buttons |
| ChatInput | `@/components/ui/chat-input` | Composer card, pill controls, compact disclaimer |
| MobileToolbarFixed | `@/components/ui/mobile-toolbar-fixed` | Settings trigger on phones (sliders icon) |
| UserMenu | `@/components/ui/user-menu` | Avatar circle |
| SourcesButton, CitationChip | `@/components/ui/sources-button`, `@/components/ui/citation-chip` | Source and related pills (styled from the chat stylesheet) |
| Sidebar | `@/components/ui/sidebar` | Chat rows (styled from the chat stylesheet) |

---

## Spacing Scale

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Icon-to-label gaps, disclaimer offset |
| sm | 8px | Gap between pills, dock bottom padding with keyboard open |
| md | 16px | Screen side gutter on phones, bubble horizontal padding |
| lg | 24px | Gap between messages, list end clearance |
| xl | 32px | Desktop gutters |
| 2xl | 48px | Space above the empty-state heading on desktop |

Exceptions: 12px dock side padding on phones (card edge sits 12px from the glass edge, 16px text inset inside the card);
10px bubble vertical padding (optical centring of one 16px line in a 40px bubble).

### Radius scale

| Token | Value | Usage |
|-------|-------|-------|
| pill | 9999px | Every icon button, model selector, send button, source and citation chips, avatar |
| card | 24px | Composer card (matches the animated border `rx`) |
| bubble | 22px | User bubble |
| row | 12px | Sidebar chat rows, menu items |

## Typography

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body (composer text, bubble) | 16px | 400 | 1.5 |
| Label (model pill, sidebar rows) | 15px / 14px | 600 / 400 | 1.3 |
| Caption (disclaimer) | 11px | 400 | 16px |
| Heading (empty state) | 26px phone / 34px desktop | 600 | 1.2, tracking -0.02em, `text-wrap: balance` |

16px composer text is a floor: iOS zooms into inputs under 16px.

## Color

Tokens live on `:root` and `.dark` in `src/app/chat-shell.css` with the `--chat-` prefix.

| Role | Light | Dark | Usage |
|------|-------|------|-------|
| Dominant (60%) canvas | `#FFF1E5` | `#212121` | Page and list background (the product's own) |
| Secondary (30%) surface | `#FFFAF6` | `#2C2B29` | Composer card |
| Bubble | `#F3E2D3` | `#323130` | User bubble |
| Ink | `#2B2521` | `#ECE7E2` | Primary text and icons |
| Ink muted | `#6B5F56` | `#B4ACA5` | Secondary text, idle icons |
| Ink faint | `#7A6D63` | `#9C948D` | Placeholder, disclaimer (≥ 4.5:1 on surface) |
| Hairline | `rgba(110, 70, 40, 0.14)` | `rgba(255, 236, 220, 0.10)` | Bar borders, card border |
| Hover fill | `rgba(110, 70, 40, 0.08)` | `rgba(255, 236, 220, 0.08)` | Pill hover |
| Accent (10%) | `#F2611A` | `#FF7A33` | Send button fill, focus ring, caret |
| Glass top | `rgba(255, 241, 229, 0.72)` | `rgba(33, 33, 33, 0.68)` | Top bar fill under blur |
| Glass bottom | canvas at 0 → 0.85 alpha | same | Dock fade |
| Destructive | `#DC2626` | `#F87171` | Stop button only |

Accent reserved for: send button fill, keyboard focus ring, text caret, active voice state. Never for idle icons or text.

---

## Component specs

### 5.1 Top bar (glass)

- Fixed at the top across the content column (`lg:left-64` when the sidebar is open, as today).
- Height: 56px plus `env(safe-area-inset-top)`, padding-top `env(safe-area-inset-top)`, side padding 12px (phone),
  20px (desktop).
- Fill: glass top token with `backdrop-filter: blur(20px) saturate(180%)` (and `-webkit-` prefix); 0.5px hairline bottom
  border and a 1px soft shadow `0 1px 0 hairline`.
- Fallback: `@supports not (backdrop-filter …)` and `prefers-reduced-transparency: reduce` use the canvas colour at full
  opacity.
- Phone row: sidebar toggle (40px pill, `PanelLeft` 20px) · model pill (36px high, 14px side padding, 15px/600 label,
  `ChevronDown` 14px) centred · settings pill (40px, `SlidersHorizontal` 20px) · avatar (36px circle).
- Desktop row: sidebar toggle and new-chat pills (36px) · model pill · right group of 36px pills (text size, theme, share,
  upload, private chat) without the bordered box · avatar.
- Pills: transparent at rest, hover fill token, pressed `scale(0.96)`, focus-visible 2px accent ring offset 2px.

### 5.2 Composer dock (glass bottom)

- One fixed dock for both the empty state and the conversation on phones (`.chat-dock`), bottom 0, full width.
- Owns the bottom inset once: `padding-bottom: max(8px, env(safe-area-inset-bottom))`; with the keyboard open the inset is
  8px (the home indicator is under the keyboard).
- Fill: a 48px gradient fade from transparent to canvas above the card, and a blurred backdrop (`blur(16px)`) masked with
  the same gradient so messages dissolve under the dock instead of being cut. Fallback without `backdrop-filter`: the
  gradient alone, ending in opaque canvas.
- Card: surface token, 24px radius, hairline border, shadow `0 8px 24px -12px rgba(60, 30, 10, 0.28)` (dark:
  `rgba(0,0,0,0.5)`), padding 6px. Textarea 16px, 12px 14px padding, max 40% of the viewport before it scrolls.
- Controls row: upload and tools pills (36px, outline hairline), dictate pill (36px, ghost), send / voice pill (36px, accent
  fill, white icon `ArrowUp` 18px). Stop is the destructive pill.
- Disclaimer: one line, caption style, ink faint, centred, 4px under the card, `text-overflow: ellipsis` when the locale's
  sentence is long. Present on every width; on desktop it stays the existing longer sentence.
- Desktop (≥ 640px): empty state keeps the centred composer under the heading; conversation keeps the bottom dock with the
  same card and fade, limited to the 52rem column.

### 5.3 Keyboard behaviour

- `viewport` export: `interactiveWidget: 'resizes-content'`, zoom allowed. Chrome on Android resizes the layout viewport, so
  the fixed dock sits on the keyboard with no script.
- `useKeyboardInset()` (new hook, mounted once by the chat page) listens to `visualViewport` resize and scroll and writes
  `--chat-kb-inset = max(0, innerHeight - visualViewport.height - visualViewport.offsetTop)` and
  `data-chat-keyboard="open|closed"` on `<html>`. A value under 80px counts as closed (toolbar collapse, not a keyboard).
- The dock is lifted with `bottom: var(--chat-kb-inset)`, not a transform: a transform would make the dock the containing
  block of the fixed menus and sheets that ChatInput renders inside it. On Android the value stays 0.
- The top bar follows a panned visual viewport with `translate3d(0, var(--chat-vv-top), 0)` so it stays visible on iOS.
- `--chat-dock-h` (ResizeObserver on the dock) feeds the list's bottom padding, so the last message always clears the
  dock, the keyboard included.

### 5.4 Message list

- Scrolls under both bars. Top padding `56px + safe-top + 8px`; bottom padding `--chat-dock-h + 24px`.
- The old 180px bottom mask (`chat-messages-fade-mask`) is replaced by the dock's own fade.
- Auto-scroll logic unchanged.

### 5.5 Message bubbles

- User: bubble token, 22px radius, 10px 16px padding, width as today (content width), reader font at the reader's size.
- Assistant: no bubble (unchanged layout). Action row icon buttons become 32px pills with the hover fill token; icons stay
  lucide 16 to 18px.

### 5.6 Source and related rows

- Sources button and citation chips: pill radius, hairline outline, 13px/500 label, hover fill token. No colour change to
  groundedness badges (their meaning is colour-coded elsewhere).

### 5.7 Sidebar entry

- Chat rows: 12px radius, 40px min height, 14px label, hover fill token, selected row bubble token.
- Sidebar top icon buttons (new chat, search, close): 36px pills.

### 5.8 Settings button

- Phone: the sliders pill in the top bar opens the existing toolbar sheet (theme, text size, share, documents).
- Desktop: settings live in the right pill group and the avatar menu, unchanged in content.

## Motion

| Moment | Spec |
|--------|------|
| Dock follows the keyboard | No transition: `visualViewport` reports during the system keyboard animation, the dock tracks it |
| Pill press | `scale(0.96)` 120ms ease-out |
| Pill hover | background-color 150ms |
| Reduced motion | press and hover transitions off (`prefers-reduced-motion: reduce`) |

No entrance animations are added. The animated composer border is an existing, configurable feature and stays.

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA | Send (existing icon button, `aria-label` unchanged) |
| Empty state heading | Existing translated `mainPrompt` / configured welcome text |
| Empty state body | none (the composer is the next step) |
| Error state | unchanged (in-band stream errors) |
| Disclaimer | Existing `mobileDisclaimer` (phone) and `disclaimer` (desktop) keys |

## UI Considerations

| Category | Element(s) | Status | Resolution / Reason |
|----------|------------|--------|---------------------|
| empty | Chat page without messages | ✅ covered | Heading centred in the space above the dock; composer pinned at the bottom on phones |
| long-text | Composer with many lines | ✅ covered | Textarea grows to 40vh then scrolls; dock height feeds list padding |
| long-text | Disclaimer in long locales | ✅ covered | Single line with ellipsis |
| overflow | Long conversation | ✅ covered | List scrolls under both glass bars; last message clears the dock |
| keyboard | Phone keyboard open | 🧪 backstop | Mechanism in 5.3; cannot be emulated in headless Chromium, needs a device check |
| fallback | No backdrop-filter / reduced transparency | ✅ covered | Opaque canvas fill |

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none added | not required |

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS (no new copy)
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [x] Dimension 6 Registry Safety: PASS
- [x] Dimension 7 Inventory Provenance: PASS

**Approval:** approved 2026-11-25 (owner brief; self-checked against the frontend-design calibration list: the canvas is the
product's existing peach, not the generic cream, and the accent is the product's orange, used only on the four elements
listed).
