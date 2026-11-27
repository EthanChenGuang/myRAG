import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';

const sourcesState = vi.hoisted(() => ({ sources: [] as unknown[], open: false }));

vi.mock('@/components/providers/auth-provider', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ theme: 'light', resolvedTheme: 'light' }) }));
vi.mock('@/components/ui/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/providers/text-size-provider', () => ({ useTextSize: () => ({ textSize: 'default' }) }));
vi.mock('@/components/providers/font-provider', () => ({ useFont: () => ({ fontFamily: 'inter' }) }));
vi.mock('@/components/providers/artifact-provider', () => ({ useArtifact: () => ({ openArtifact: () => {} }) }));
vi.mock('@/components/providers/model-provider', () => ({ useModel: () => ({ selectedModel: 'test/model' }) }));
vi.mock('@/components/providers/language-provider', () => ({
  useLanguage: () => ({ language: 'en', setLanguage: () => {}, t: (key: string) => key }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock('@/components/ui/markdown', async () => {
  const { default: ReactMarkdown } = await import('react-markdown');
  return {
    Markdown: ({ children, components }: { children?: string; components?: Record<string, unknown> }) =>
      createElement(ReactMarkdown as never, { components }, children),
  };
});
vi.mock('@/components/providers/sources-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/providers/sources-provider')>();
  return {
    ...actual,
    useSources: () => ({
      sources: sourcesState.sources,
      setSources: () => {},
      isSourcesOpen: sourcesState.open,
      trackedSetIsSourcesOpen: () => {},
      hasAvailableSources: false,
    }),
  };
});

const { citationSourcesFor } = await import('@/components/providers/sources-provider');
type Source = import('@/components/providers/sources-provider').Source;
const { CitationSourceEntry, SourcesSidebar } = await import('@/components/ui/sources-sidebar');
const { CitationChip } = await import('@/components/ui/citation-chip');
const { ChatMessage } = await import('@/components/ui/chat-message');
const { SharedChatLayout } = await import('@/components/ui/shared-chat-layout');
const { citationDisplayEntries } = await import('@/lib/citations/display');
const { toAnswerRecord } = await import('@/lib/answers/read');
const { useAnswerRecordsStore } = await import('@/lib/stores/answer-records-store');

const HASH = 'c'.repeat(64);
const ANSWER_ID = '3b1f8e2a-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const STALE = 'Stale sentence held by the browser';
const WITHDRAWN_AT = '2026-11-25T12:00:00.000Z';

function citation(n: number, documentId: string, extra: Record<string, unknown> = {}) {
  return {
    n,
    alias: `S${n}`,
    chunkIds: [`chunk-${n}`],
    documentId,
    documentName: `file-${n}.pdf`,
    documentVersion: 1,
    page: null,
    quote: `${STALE} ${n}`,
    quoteHash: HASH,
    sectionPath: null,
    strategy: 'chunk-alias',
    ...extra,
  };
}

const flagged = (n: number, documentId: string, extra: Record<string, unknown> = {}) =>
  citation(n, documentId, { quote: '', withdrawn: true, ...extra });

const renderEntry = (source: Source, language = 'en') =>
  renderToStaticMarkup(createElement(CitationSourceEntry, { source, language }));

function attributeValues(html: string, name: 'title' | 'aria-label'): string[] {
  return [...html.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((match) => match[1]);
}

function expectNoStaleText(html: string) {
  expect(html).not.toContain(STALE);
  expect(html).not.toContain('<blockquote');
  for (const value of [...attributeValues(html, 'title'), ...attributeValues(html, 'aria-label')]) {
    expect(value).not.toContain(STALE);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  sourcesState.sources = [];
  sourcesState.open = false;
});

describe('withdrawn availability from the server record', () => {
  test('toAnswerRecord reports withdrawn for a document with a withdrawn citation, ahead of the lookup', () => {
    const row = {
      id: ANSWER_ID,
      citations: [flagged(1, 'doc-a'), citation(2, 'doc-a'), citation(3, 'doc-b'), citation(4, 'doc-c')],
      created_at: WITHDRAWN_AT,
      updated_at: WITHDRAWN_AT,
    } as never;
    const record = toAnswerRecord(row, new Date(WITHDRAWN_AT), { 'doc-a': 'current', 'doc-b': 'current' }, { feedbackEnabled: false });
    expect(record.documents).toEqual({ 'doc-a': 'withdrawn', 'doc-b': 'current', 'doc-c': 'unavailable' });
  });
});

describe('citationDisplayEntries withdrawn rule', () => {
  test('the citation flag gives an empty quote, no link and withdrawn with its date', () => {
    const [entry] = citationDisplayEntries([flagged(1, 'doc-a', { withdrawnAt: WITHDRAWN_AT })] as never, { 'doc-a': 'current' });
    expect(entry).toMatchObject({ quote: '', linkDocumentId: null, unavailable: false, withdrawn: true, withdrawnAt: WITHDRAWN_AT });
  });

  test('the availability map alone hides a quote the browser still holds', () => {
    const [entry] = citationDisplayEntries([citation(1, 'doc-a')] as never, { 'doc-a': 'withdrawn' });
    expect(entry).toMatchObject({ quote: '', linkDocumentId: null, unavailable: false, withdrawn: true, withdrawnAt: null });
  });

  test('other citations keep today’s values with withdrawn false', () => {
    const [current, unavailable] = citationDisplayEntries([citation(1, 'doc-a'), citation(2, 'doc-b')] as never, {
      'doc-a': 'current',
      'doc-b': 'unavailable',
    });
    expect(current).toMatchObject({ quote: `${STALE} 1`, linkDocumentId: 'doc-a', unavailable: false, withdrawn: false, withdrawnAt: null });
    expect(unavailable).toMatchObject({ quote: `${STALE} 2`, linkDocumentId: null, unavailable: true, withdrawn: false });
  });
});

describe('CitationSourceEntry for a withdrawn citation', () => {
  test('stale quote text never reaches the markup, a title or an aria-label', () => {
    const [entry] = citationSourcesFor({ citations: [citation(1, 'doc-a')] }, { 'doc-a': 'withdrawn' }, [], 'm-1');
    expect(entry.documentId).toBeUndefined();
    expect(entry.citation).toMatchObject({ quote: '', unavailable: false, withdrawn: true, withdrawnAt: null });
    const html = renderEntry(entry);
    expectNoStaleText(html);
    expect(html).toContain('data-citation-withdrawn="true"');
    expect(html).toContain('border-dashed');
    expect(html).toContain('Source withdrawn');
    expect(html).toContain('This source was withdrawn after the answer was written. Its text is no longer available.');
    expect(html).not.toMatch(/updated or removed/);
    expect(html).not.toContain('Withdrawn on');
    expect(html).toContain('bg-gray-500/15');
    expect(html).not.toContain('bg-[#FF6417]/15');
  });

  test('withdrawnAt adds the localized date sentence', () => {
    const [entry] = citationSourcesFor({ citations: [flagged(1, 'doc-a', { withdrawnAt: WITHDRAWN_AT })] }, undefined, []);
    const html = renderEntry(entry);
    expect(html).toContain(`Withdrawn on ${new Date(WITHDRAWN_AT).toLocaleDateString('en')}.`);
  });

  test('a blank name falls back to the withdrawn string as the title', () => {
    const [entry] = citationSourcesFor({ citations: [flagged(1, 'doc-a', { documentName: ' ' })] }, undefined, []);
    expect(renderEntry(entry)).toMatch(/<h4[^>]*>Source withdrawn<\/h4>/);
  });

  test('a long name keeps break-words on the title', () => {
    const name = `${'a'.repeat(200)}.pdf`;
    const [entry] = citationSourcesFor({ citations: [flagged(1, 'doc-a', { documentName: name })] }, undefined, []);
    expect(renderEntry(entry)).toMatch(new RegExp(`<h4 class="[^"]*break-words[^"]*">${name}</h4>`));
  });

  test('zh and it render their copy, other languages fall back to en', () => {
    const [entry] = citationSourcesFor({ citations: [flagged(1, 'doc-a', { withdrawnAt: WITHDRAWN_AT })] }, undefined, []);
    const zh = renderEntry(entry, 'zh');
    expect(zh).toContain('来源已撤回');
    expect(zh).toContain('该来源在回答生成后已被撤回，其内容不再提供。');
    expect(zh).toContain('撤回于');
    const it = renderEntry(entry, 'it');
    expect(it).toContain('Fonte ritirata');
    expect(it).toContain('Ritirata il');
    expect(renderEntry(entry, 'fr')).toContain('Source withdrawn');
  });

  test('markup and script in a document name render as text', () => {
    const [img, js] = citationSourcesFor(
      { citations: [flagged(1, 'doc-a', { documentName: '<img src=x onerror=alert(1)>' }), flagged(2, 'doc-b', { documentName: 'javascript:alert(1)' })] },
      undefined,
      [],
    );
    const html = renderEntry(img) + renderEntry(js);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('href=');
  });
});

describe('CitationChip', () => {
  const chip = (withdrawn?: boolean) =>
    renderToStaticMarkup(createElement(CitationChip, { n: 2, messageId: 'm-1', buildSources: () => [], ...(withdrawn === undefined ? {} : { withdrawn }) }));

  test('a withdrawn chip keeps its number, turns grey and names the withdrawn source', () => {
    const html = chip(true);
    expect(html).toContain('data-citation-chip="2"');
    expect(html).toMatch(/>2<\/button>/);
    expect(html).toContain('aria-label="Show source 2 (withdrawn)"');
    expect(html).toContain('title="Show source 2 (withdrawn)"');
    expect(html).toContain('bg-gray-500/15');
    expect(html).toContain('hover:bg-gray-500/25');
    expect(html).toContain('focus-visible:ring-2');
    expect(html).not.toContain('bg-[#FF6417]/15');
  });

  test('without the prop the chip is unchanged', () => {
    expect(chip()).toBe(chip(false));
    const html = chip();
    expect(html).toContain('aria-label="Show source 2"');
    expect(html).toContain('bg-[#FF6417]/15');
    expect(html).not.toContain('bg-gray-500/15');
  });
});

const TEXT = 'First claim [S1]. Second claim [S2].';

function chatMessage(metadata: Record<string, unknown>) {
  return createElement(ChatMessage as never, {
    message: { id: 'm-1', role: 'assistant', parts: [], content: [{ type: 'text', text: TEXT }], metadata },
    isLastMessage: false,
  }) as ReactNode as never;
}

describe('ChatMessage and shared chats', () => {
  test('the availability map in the answer-records store turns the chip neutral', () => {
    // Server rendering reads the store's initial state, so the record is placed there for this test.
    const initial = useAnswerRecordsStore.getInitialState().records;
    initial[ANSWER_ID] = { answerId: ANSWER_ID, documents: { 'doc-1': 'withdrawn', 'doc-2': 'current' } } as never;
    onTestFinished(() => {
      delete initial[ANSWER_ID];
    });
    const html = renderToStaticMarkup(
      chatMessage({ answerId: ANSWER_ID, citationStrategy: 'chunk-alias', citations: [citation(1, 'doc-1'), citation(2, 'doc-2')] }),
    );
    expect(html).toContain('aria-label="Show source 1 (withdrawn)"');
    expect(html).toContain('aria-label="Show source 2"');
    expect(html).not.toContain(STALE);
  });

  test('a shared chat applies the flag stored in the message metadata', () => {
    const html = renderToStaticMarkup(
      createElement(SharedChatLayout, {
        chat: {
          title: 'Chat A',
          created_at: WITHDRAWN_AT,
          updated_at: WITHDRAWN_AT,
          messages: [
            {
              id: 'm-1',
              role: 'assistant',
              parts: [],
              content: [{ type: 'text', text: TEXT }],
              metadata: { answerId: ANSWER_ID, citationStrategy: 'chunk-alias', citations: [flagged(1, 'doc-1'), citation(2, 'doc-2')] },
            },
          ],
        },
      }),
    );
    expect(html).toContain('aria-label="Show source 1 (withdrawn)"');
    expect(html).toContain('aria-label="Show source 2"');
  });
});

describe('document entries of a withdrawn document', () => {
  const used = (title: string, extra: Partial<Source> = {}): Source => ({
    title,
    type: 'document',
    documentId: 'doc-a',
    provider: 'Document Database',
    content: `${STALE} preview`,
    snippet: `${STALE} snippet`,
    explicitly_referenced: true,
    ...extra,
  });

  test('citationSourcesFor marks the entry withdrawn and drops its text and link', () => {
    const result = citationSourcesFor(
      { citations: [citation(1, 'doc-a')] },
      { 'doc-a': 'withdrawn' },
      [used('file-a.pdf', { url: 'https://example.com/file-a' })],
    );
    const entry = result[1];
    expect(entry).toMatchObject({ title: 'file-a.pdf', cited: true, withdrawn: true, explicitly_referenced: true });
    expect(entry.content).toBeUndefined();
    expect(entry.snippet).toBeUndefined();
    expect(entry.url).toBeUndefined();
  });

  test('the panel shows the frame in place of the snippet, keeps the pills and never links', () => {
    sourcesState.open = true;
    const sources = citationSourcesFor(
      { citations: [citation(1, 'doc-a')] },
      { 'doc-a': 'withdrawn' },
      [used(''), used('javascript:alert(1)', { documentId: 'doc-b' }), used('<img src=x onerror=alert(1)>', { documentId: 'doc-c' })],
    );
    const withdrawnB = { ...sources[2], withdrawn: true, url: 'javascript:alert(1)' };
    const withdrawnC = { ...sources[3], withdrawn: true };
    const html = renderToStaticMarkup(createElement(SourcesSidebar, { sources: [sources[0], sources[1], withdrawnB, withdrawnC] }));
    expectNoStaleText(html);
    expect(html).toContain('data-source-withdrawn="true"');
    expect(html).toContain('Referenced');
    expect(html).toContain('Cited');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect((html.match(/border-dashed/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(html).toMatch(/<h3[^>]*>Source withdrawn/);
  });
});
