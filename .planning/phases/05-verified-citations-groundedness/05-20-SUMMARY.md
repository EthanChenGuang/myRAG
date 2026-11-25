---
phase: 05-verified-citations-groundedness
plan: 20
subsystem: chat-ui
tags: [citations, chips, sources-panel, snapshots, translations, zustand]

requires:
  - phase: 05-verified-citations-groundedness
    provides: marker grammar (05-03), citationDisplayEntries (05-09), answer metadata on messages and the answer-records store (05-15)
provides:
  - "src/lib/chat/citation-markers.ts: renderCitationMarkers, isCitationAware, citeAliasFromHref, CITE_HREF_PREFIX"
  - "src/translations/answer-quality.ts: answerQualityStrings(language) for chips and the sources panel (en, zh, it; en fallback)"
  - "src/lib/stores/citation-focus-store.ts: useCitationFocusStore {focus, focusCitation, clear, syncChat}"
  - "src/components/providers/sources-provider.tsx: exported Source and SourceCitation types, citationSourcesFor"
  - "src/components/ui/sources-sidebar.tsx: CitationSourceEntry and the citation group in the panel"
  - "src/components/ui/citation-chip.tsx: CitationChip"
affects: [05-23]

actuals:
  tasks: 3
  commits: 6

key-files:
  created:
    - src/lib/chat/citation-markers.ts
    - src/translations/answer-quality.ts
    - src/lib/stores/citation-focus-store.ts
    - src/components/ui/citation-chip.tsx
    - tests/lib/citation-markers.test.ts
    - tests/ui/citation-sources.test.ts
    - tests/ui/citation-chat-message.test.ts
  modified:
    - src/components/providers/sources-provider.tsx
    - src/components/ui/sources-sidebar.tsx
    - src/components/ui/chat-message.tsx

requirements-completed: [GEN-02, GEN-03]

duration: ~1.5h
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 20: citation chips and sources-panel snapshots

**Validated citation markers now show as superscript numbered chips in the answer. Clicking a chip opens the existing sources panel at that citation, which shows the number, document name, page or section, and the snapshot quote. Every other `[S…]` marker is hidden once the answer finishes, and every marker is hidden while a citation-aware answer streams. The panel renders only from the message metadata snapshot and the answer record's document status; it never reads a chunk. Messages without citation metadata render as before.**

## Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1. Pure marker rendering and strings (D-04, D-20) | `7edccf2` test: 20 of 33 cases failed on assertions against stubs (the passing 13 are the "not aware, unchanged" guards and the isCitationAware false cases) | `8fae536` feat |
| 2. Sources panel entries from snapshots (D-03, D-06, D-20) | `cf72c04` test: 11 of 14 failed on assertions against stubs | `845fb75` feat |
| 3. Chips in the message and panel opening (D-04, D-20) | - | `277716e` feat (with a render test), `f1f8b2c` fix (design review) |

## What it does

### Marker rendering (`src/lib/chat/citation-markers.ts`)

- `isCitationAware(metadata)` is true when the metadata has a `citations` array, a non-empty `answerId` or a `citationStrategy`.
- `renderCitationMarkers(text, {citations, phase})`:
  - `citations: undefined` means the message is not citation-aware: the same string comes back in every phase;
  - in the `final` phase, markers found by the shared `findCitationMarkers` grammar become `[n](#cite-S<k>)` links for aliases in the validated list. The number is the citation's `n`. A marker with several aliases becomes adjacent chips, and unknown aliases are dropped. A marker left with no valid alias is removed, with whitespace tidied the same way as `stripCitationMarkers`;
  - a chip attaches to the preceding word (the space before it is removed), as superscript numbers do;
  - in the `streaming` phase every marker is removed, and so is a trailing partial marker (`[S1`, `【S`);
  - fenced code blocks (``` and ~~~, an unclosed fence protects the rest) and inline code spans of any backtick length are never touched.
- `citeAliasFromHref(href)` returns the alias of a `#cite-S<k>` href, else null.

### Strings (`src/translations/answer-quality.ts`)

`answerQualityStrings(language)` returns the panel heading, the "Cited" label, the "updated or removed" note, the chip aria label and the page label in en, zh and it. Lookup is own-property, so `__proto__` and other locales get en. Plan 05-23 adds the badge and feedback strings to this module.

### Sources panel

- `Source` (exported from `sources-provider.tsx`) has two new optional fields: `citation {n, alias, quote, page, sectionPath, unavailable, messageId?}` and `cited`.
- `citationSourcesFor(metadata, documents, existing, messageId)`:
  - validates the metadata's citations with `pickAnswerMetadata` and returns `existing` unchanged (same array) when there are none;
  - builds one document entry per citation in `n` order through `citationDisplayEntries`;
  - an entry has `documentId` only while the record says the document is `current`. A document that is `unavailable`, or missing from the record's map, has no `documentId` and `unavailable: true`. With no record at all (shared or ghost chat), the entry shows the snapshot with no `documentId` and no note;
  - keeps every existing entry and sets `cited: true` on document entries whose id was cited. Web, tool and other document entries are the same objects. Earlier citation entries are rebuilt, not duplicated.
- `useCitationFocusStore` keeps `{chatId, messageId, n}`. `syncChat(chatId)` clears the focus when the chat changes, and the sidebar calls it on `currentChatId`.
- The sidebar shows a "Cited in This Answer" group above the existing list when citation entries are present. Each `CitationSourceEntry` shows the number, name, page and section path, and the quote in a tinted quote block, all as React text nodes. Unavailable documents also get the localized note. The focused entry is highlighted and scrolled into view (instant under reduced motion). Cited documents in the existing list get a "Cited" pill. Without citation entries the list renders exactly as before.

### Chat message (`chat-message.tsx`, `citation-chip.tsx`)

- For assistant messages that are citation-aware, `TextPartRenderer` passes the text through `renderCitationMarkers`. It uses the `streaming` phase for the `streaming` placeholder or while `isStreaming`, and `final` otherwise.
- The markdown `a` renderer maps a `#cite-` href whose alias is in the validated list to `CitationChip`. A `#cite-` href for any other alias renders as plain text, so the model cannot forge a chip. Every other link, and every link in a message that is not citation-aware, renders as before.
- `CitationChip` is a `<sup><button>` with the number, the localized aria label, a visible focus ring, a larger invisible hit area and `data-sources-toggle` (so the panel's click-outside handler does not close it on the same click). On click it rebuilds the sources from the message's own parts (documents, tool links and web results) through `citationSourcesFor`, sets the focus, and opens the panel through `trackedSetIsSourcesOpen(true, 'CitationChip_USER_CLICK')`.
- For the last message, the existing effects that fill the panel add the citation entries and the cited flags when the message is citation-aware. The answer record's `documents` map is read from `useAnswerRecordsStore` with a single-field selector. For messages that are not citation-aware the effects' inputs are constant, so they run as before.
- `SourcesButtonContainer` is unchanged: it still shows only for web or tool sources. The cited flags reach it through the provider's sources.

## Behaviour changes

- With `RAG_CITATIONS=false` and `RAG_CLAUDE_CITATIONS=false` (the defaults) no message carries citation metadata, so the message text, links and sources panel render exactly as before.
- With a switch on: no raw `[S…]` text is shown, validated markers are chips, and the panel can show every citation from its snapshot.

## Tests that failed before the fix

- `tests/lib/citation-markers.test.ts`: 20 of 33 failed against the stubs (chip links, unknown alias removal, full-width forms, code spans, streaming hiding, the three locales, the fallback).
- `tests/ui/citation-sources.test.ts`: 11 of 14 failed against the stubs (entries, link/note rules, no-record case, focus store, text-node rendering, localized note).
- `tests/ui/citation-chat-message.test.ts` (written with Task 3, checked against the pre-Task-3 `chat-message.tsx`): 3 of 4 failed (chips rendered, markers hidden while streaming, forged `#cite-` link). The "not citation-aware renders as before" guard passed on both.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | 0 diagnostics |
| `npx vitest run` | 266 files, 4227 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 166 pass, 0 fail (after `uv sync` in rag-sidecar; before it, the sidecar module launcher's 2 subtests failed because the sidecar venv was missing) |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1446 pass, 4 fail, 4 skipped (all pre-existing, below) |
| check-rag-boundary and its node test | ok (1174 files); 38 pass |
| `node scripts/check-config.mjs` | ok, 135 variables |
| check-workflows.py | OK |
| Python suites, `gen:schemas`, `test-rag` | not required: no Python, contract, retrieval, ingest or golden-set change |

### Pre-existing failures

- `tests/rag-db/ingest-mode-routing.test.mts`: 4 subtests fail because the sidecar cannot download `cl100k_base.tiktoken` from `openaipublic.blob.core.windows.net` (`SSLError ... CERTIFICATE_VERIFY_FAILED`). This is the known cold-cache failure (also in 05-13 and 05-15); this plan does not touch that code.
- The 4 skips are the known `ingestion-ledger-pg` root skip.

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | Direction for the two new surfaces, the chip and the panel entry: kept inside the existing visual world (the `#FF6417` accent, rounded translucent cards in the sidebar), with a quiet numeric chip and the quote as the visual centre of the entry | pass |
| Impeccable | `reference/craft-floor.md` and `reference/polish.md` (launcher not used). Fixed: the one-sided quote rule became a tinted quote block; the uppercase eyebrow label became a plain heading; the chip hit area was enlarged; `tabular-nums` on numbers; reduced-motion variants added | pass |
| web-design-guidelines | Final review of every touched UI file against `references/command.md` | pass (all findings resolved) |

web-design-guidelines findings:

- src/components/ui/sources-sidebar.tsx:CitationSourceEntry — Animation: honour `prefers-reduced-motion` — fixed (`motion-reduce:transition-none`; the scroll uses `behavior: 'auto'` under reduced motion)
- src/components/ui/sources-sidebar.tsx:CitationSourceEntry — Accessibility: hierarchical headings — fixed (group heading `h3`, entry titles `h4`)
- src/components/ui/sources-sidebar.tsx:CitationSourceEntry — Accessibility: `scroll-margin-top` on anchors — fixed (`scroll-mt-4`)
- src/components/ui/sources-sidebar.tsx:CitationSourceEntry — Accessibility: decorative icons need `aria-hidden` — fixed (number badge and Info icon)
- src/components/ui/sources-sidebar.tsx:CitationSourceEntry — Content handling: long content — fixed (`break-words`, `min-w-0`, `whitespace-pre-wrap` on the quote)
- src/components/ui/citation-chip.tsx:CitationChip — Focus states: `outline-none` needs a replacement — fixed (`focus-visible:ring-2`)
- src/components/ui/citation-chip.tsx:CitationChip — Animation: explicit transition properties and reduced motion — fixed (`transition-colors`, `motion-reduce:transition-none`)
- src/components/ui/citation-chip.tsx:CitationChip — Touch: `touch-action: manipulation` — fixed (`touch-manipulation`)
- src/components/ui/citation-chip.tsx:CitationChip — Accessibility: icon-like button needs a label — fixed (localized `aria-label` and `title`)
- src/translations/answer-quality.ts — Content & copy: Title Case headings — fixed (en "Cited in This Answer")
- src/components/ui/chat-message.tsx — none for the changed lines (the `a` renderer and the TextPartRenderer props only)

## Deviations

- **No document link target exists.** The app has no document viewer route: `/api/documents/[id]` only has DELETE and PATCH, and click-through to the source page is deferred (UX-02). So "the link uses documentId only while current" is applied to the data. A current document's entry carries `documentId` (rendered as `data-document-id`). An unavailable document's entry has none and shows the note. No `href` is rendered for either. When a viewer route exists, the link goes on that `documentId`.
- **Test helper location.** `citationSourcesFor` lives in `sources-provider.tsx`, as the plan allows, and the entry component `CitationSourceEntry` is exported from `sources-sidebar.tsx` so the text-node rendering can be tested with `renderToStaticMarkup`.
- **Extra test file.** `tests/ui/citation-chat-message.test.ts` was added to render `ChatMessage` with mocked providers.
- **Unused string removed.** A `sectionLabel` string was dropped because nothing showed it.
- No migration, env variable, contract, Python or package change.

## Decisions for STATE

- A chip number is the citation's `n`; the chip attaches to the preceding word.
- A `#cite-` link becomes a chip only when its alias is in the validated list and the message is citation-aware; otherwise it renders as plain text.
- Citation entries come first in the panel under their own heading. Existing entries are kept, and cited documents are flagged with a "Cited" pill.
- Focus is per `{chatId, messageId, n}` and is cleared on chat switch.

## Operator actions

- None. The human check in Task 3 (with `RAG_CITATIONS=true`: chips after finish, the panel entry, the "updated or removed" note after deleting the document, and unchanged rendering with the switch off) is still a live verification item.

## Deferred

- Click-through to the document or page (UX-02); see the first deviation.
- The groundedness badge and the feedback controls (plan 05-23, same strings module).
