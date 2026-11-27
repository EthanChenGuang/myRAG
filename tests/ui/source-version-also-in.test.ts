import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

const panel = vi.hoisted(() => ({ sources: [] as unknown[] }));

vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ theme: 'light', resolvedTheme: 'light' }) }));
vi.mock('@/components/providers/language-provider', () => ({ useLanguage: () => ({ language: 'en' }) }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  const strip = ({ initial: _i, animate: _a, exit: _e, ...rest }: Record<string, unknown>) => rest;
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    motion: {
      aside: React.forwardRef<HTMLElement, Record<string, unknown>>(function Aside(props, ref) {
        return React.createElement('aside', { ...strip(props), ref });
      }),
    },
  };
});
vi.mock('@/components/providers/sources-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/providers/sources-provider')>();
  return {
    ...actual,
    useSources: () => ({
      sources: panel.sources,
      setSources: () => {},
      isSourcesOpen: true,
      trackedSetIsSourcesOpen: () => {},
      hasAvailableSources: true,
    }),
  };
});

import { citationSourcesFor, type Source } from '@/components/providers/sources-provider';
import { CitationSourceEntry, SourcesSidebar } from '@/components/ui/sources-sidebar';

const HASH = 'a'.repeat(64);

function record(n: number, documentId: string, extra: Record<string, unknown> = {}) {
  return {
    n,
    alias: `S${n}`,
    chunkIds: [`chunk-${n}`],
    documentId,
    documentName: `Doc ${documentId}`,
    documentVersion: 1,
    page: null,
    quote: `Quote ${n}`,
    quoteHash: HASH,
    sectionPath: null,
    strategy: 'chunk-alias',
    ...extra,
  };
}

const BASE_CITATIONS = citationSourcesFor(
  { citations: [record(1, 'doc-a', { page: 4, sectionPath: ['Part one'] }), record(2, 'doc-b')] },
  { 'doc-a': 'current', 'doc-b': 'unavailable' },
  [],
  'msg-1',
);
const LISTED: Source[] = [
  { title: 'Doc listed', type: 'document', documentId: 'doc-l', provider: 'Document Database', uploadedAt: '2025-03-01T12:00:00Z', content: 'Preview text' },
  { title: 'Doc linked', type: 'document', documentId: 'doc-k', url: 'https://example.com/doc-k', provider: 'Document Database' },
  { title: 'Web page', type: 'web', url: 'https://example.com/a', provider: 'Exa' },
];

const renderEntry = (source: Source, language = 'en') =>
  renderToStaticMarkup(createElement(CitationSourceEntry, { source, language }));
const renderPanel = (sources: Source[]) => {
  panel.sources = sources;
  return renderToStaticMarkup(createElement(SourcesSidebar, { sources }));
};

describe('absent fields: markup equals the markup before this phase', () => {
  test('citation entries', async () => {
    await expect(BASE_CITATIONS.map((s) => renderEntry(s)).join('\n')).toMatchFileSnapshot('./__snapshots__/source-version-also-in.citation-baseline.html');
  });

  test('the whole panel with citation entries, listed cards, a linked card and a web source', async () => {
    await expect(renderPanel([...BASE_CITATIONS, ...LISTED])).toMatchFileSnapshot('./__snapshots__/source-version-also-in.panel-baseline.html');
  });

  test('the whole panel with listed sources only', async () => {
    await expect(renderPanel(LISTED)).toMatchFileSnapshot('./__snapshots__/source-version-also-in.listed-baseline.html');
  });
});
