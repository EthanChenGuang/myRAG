import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

const panel = vi.hoisted(() => ({ sources: [] as unknown[] }));

vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ theme: 'light', resolvedTheme: 'light' }) }));
vi.mock('@/components/providers/language-provider', () => ({ useLanguage: () => ({ language: 'en' }) }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  const strip = (props: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(props).filter(([key]) => !['initial', 'animate', 'exit'].includes(key)));
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

import { documentSourceFields } from '@/components/providers/sources-provider';
import { citationDisplayEntries } from '@/lib/citations/display';
import { listHasSupersededEntry, sourceAlsoInView, sourceVersionView } from '@/components/ui/sources-sidebar';
import { answerQualityStrings } from '@/translations/answer-quality';

const doc = (extra: Partial<Source> = {}): Source => ({ title: 'Doc one', type: 'document', documentId: 'doc-1', provider: 'Document Database', ...extra });
const names = (n: number, prefix = 'file') =>
  Array.from({ length: n }, (_, i) => ({ documentId: `${prefix}-${i}`, filename: `${prefix}-${i}.txt`, chunkId: `c-${i}` }));

describe('sourceVersionView', () => {
  test('nothing for a non-document source, an invalid version or a non-boolean isCurrent', () => {
    expect(sourceVersionView({ ...doc({ version: 2, isCurrent: false }), type: 'web' }, true)).toBeNull();
    expect(sourceVersionView({ ...doc({ version: 2, isCurrent: false }), type: 'tool_link' }, true)).toBeNull();
    for (const version of [0, -1, 1.5, Number.NaN, '2' as unknown as number, undefined]) {
      expect(sourceVersionView(doc({ version, isCurrent: false }), true)).toBeNull();
    }
    expect(sourceVersionView(doc({ version: 2 }), true)).toBeNull();
    expect(sourceVersionView(doc({ version: 2, isCurrent: 'false' as unknown as boolean }), true)).toBeNull();
    expect(sourceVersionView(doc({ isCurrent: false }), true)).toBeNull();
  });

  test('Superseded for isCurrent false; Current only when the list has a superseded entry', () => {
    expect(sourceVersionView(doc({ version: 2, isCurrent: false }), false)).toMatchObject({ marker: 'superseded', version: 2 });
    expect(sourceVersionView(doc({ version: 3, isCurrent: true }), true)).toMatchObject({ marker: 'current', version: 3 });
    expect(sourceVersionView(doc({ version: 3, isCurrent: true }), false)).toBeNull();
  });

  test('the phrase follows the valid dates', () => {
    const view = (effectiveFrom: string | null | undefined, effectiveTo: string | null | undefined) =>
      sourceVersionView(doc({ version: 2, isCurrent: false, effectiveFrom, effectiveTo }), false);
    expect(view('2025-01-01', '2025-06-30')).toMatchObject({ phrase: 'versionFromTo', from: '2025-01-01', to: '2025-06-30' });
    expect(view('2025-01-01', null)).toMatchObject({ phrase: 'versionFrom', from: '2025-01-01', to: null });
    expect(view(undefined, '2025-06-30')).toMatchObject({ phrase: 'versionUntil', from: null, to: '2025-06-30' });
    expect(view(null, undefined)).toMatchObject({ phrase: 'versionOnly', from: null, to: null });
    expect(view('2025-02-30', 'not a date')).toMatchObject({ phrase: 'versionOnly' });
    expect(view('2025-01-01T00:00:00Z', 7 as unknown as string)).toMatchObject({ phrase: 'versionOnly' });
  });

  test('a citation entry reads its fields from the citation', () => {
    const [entry] = citationSourcesFor({ citations: [record(1, 'doc-a', { documentVersion: 2, isCurrent: false })] }, { 'doc-a': 'current' }, []);
    expect(sourceVersionView(entry, false)).toMatchObject({ marker: 'superseded', version: 2 });
  });

  test('listHasSupersededEntry looks at document entries with a valid tag only', () => {
    expect(listHasSupersededEntry([doc({ version: 1, isCurrent: true })])).toBe(false);
    expect(listHasSupersededEntry([doc({ version: 1, isCurrent: false })])).toBe(true);
    expect(listHasSupersededEntry([{ ...doc({ version: 1, isCurrent: false }), type: 'web' }])).toBe(false);
    expect(listHasSupersededEntry([doc({ isCurrent: false })])).toBe(false);
  });
});

describe('sourceAlsoInView', () => {
  test('drops items without a filename and the entry itself, first occurrence wins, received order', () => {
    const view = sourceAlsoInView(
      doc({
        alsoIn: [
          { documentId: 'doc-3', filename: 'third.txt', chunkId: 'c3' },
          { documentId: 'doc-1', filename: 'self.txt', chunkId: 'c1' },
          { documentId: 'doc-2', filename: '', chunkId: 'c2' },
          { documentId: 'doc-4', filename: 'fourth.txt', chunkId: 'c4' },
          { documentId: 'doc-3', filename: 'third-again.txt', chunkId: 'c5' },
          { documentId: 'doc-5', chunkId: 'c6' } as unknown as { documentId: string; filename: string; chunkId: string },
        ],
      }),
    );
    expect(view).toEqual({ names: ['third.txt', 'fourth.txt'], total: 2, more: 0 });
  });

  test('nothing when absent, not an array, empty, only the entry itself, or not a document', () => {
    expect(sourceAlsoInView(doc())).toBeNull();
    expect(sourceAlsoInView(doc({ alsoIn: 'x' as unknown as [] }))).toBeNull();
    expect(sourceAlsoInView(doc({ alsoIn: [] }))).toBeNull();
    expect(sourceAlsoInView(doc({ alsoIn: [{ documentId: 'doc-1', filename: 'self.txt', chunkId: 'c' }] }))).toBeNull();
    expect(sourceAlsoInView({ ...doc({ alsoIn: names(2) }), type: 'web' })).toBeNull();
  });

  test('at most 50 names, the rest counted', () => {
    const view = sourceAlsoInView(doc({ alsoIn: names(60) }));
    expect(view?.names).toHaveLength(50);
    expect(view?.total).toBe(60);
    expect(view?.more).toBe(10);
  });
});

describe('field plumbing', () => {
  test('documentSourceFields copies only the version and also-in fields that are set', () => {
    expect(documentSourceFields({ id: 'x', name: 'n' })).toEqual({});
    expect(
      documentSourceFields({ version: 2, isCurrent: false, effectiveFrom: '2025-01-01', effectiveTo: null, alsoIn: names(1), other: 1 }),
    ).toEqual({ version: 2, isCurrent: false, effectiveFrom: '2025-01-01', effectiveTo: null, alsoIn: names(1) });
    expect(documentSourceFields(null)).toEqual({});
  });

  test('display entries and citation sources carry the record fields; the own document is not listed', () => {
    const rec = record(1, 'doc-a', {
      documentVersion: 2,
      isCurrent: false,
      effectiveFrom: '2025-01-01',
      alsoIn: [
        { documentId: 'doc-a', filename: 'self.txt', chunkId: 'c0' },
        { documentId: 'doc-z', filename: 'other.txt', chunkId: 'c9' },
      ],
    });
    const [entry] = citationDisplayEntries([rec as never], { 'doc-a': 'current' });
    expect(entry).toMatchObject({ version: 2, isCurrent: false, effectiveFrom: '2025-01-01' });
    expect(entry.alsoIn).toEqual([{ documentId: 'doc-z', filename: 'other.txt', chunkId: 'c9' }]);
    const [source] = citationSourcesFor({ citations: [rec] }, { 'doc-a': 'current' }, []);
    expect(source.citation).toMatchObject({ version: 2, isCurrent: false, effectiveFrom: '2025-01-01', alsoIn: [{ documentId: 'doc-z' }] });
  });

  test('a record without the fields adds none of them', () => {
    const [entry] = citationDisplayEntries([record(1, 'doc-a', { documentVersion: null }) as never], {});
    // withdrawn and withdrawnAt are always present since 06.3-06 (D-36); no version or also-in field is added.
    expect(Object.keys(entry).sort()).toEqual(['documentName', 'linkDocumentId', 'n', 'page', 'quote', 'sectionPath', 'unavailable', 'withdrawn', 'withdrawnAt']);
  });
});

describe('rendering', () => {
  const [superseded, currentCited] = citationSourcesFor(
    {
      citations: [
        record(1, 'doc-a', { page: 4, documentVersion: 2, isCurrent: false, effectiveFrom: '2025-01-01', effectiveTo: '2025-06-30', alsoIn: names(3) }),
        record(2, 'doc-b', { documentVersion: 3, isCurrent: true }),
      ],
    },
    { 'doc-a': 'unavailable', 'doc-b': 'current' },
    [],
    'msg-1',
  );

  test('a superseded citation shows the tag after the location, before the quote, and no amber note', () => {
    const html = renderEntry(superseded);
    expect(html).toContain('Superseded');
    expect(html).toContain('<time dateTime="2025-01-01">Jan 1, 2025</time>');
    expect(html).toContain('<time dateTime="2025-06-30">Jun 30, 2025</time>');
    expect(html).toMatch(/Version 2, in effect <time[^>]*>[^<]+<\/time> to <time/);
    expect(html.indexOf('p. 4')).toBeLessThan(html.indexOf('Superseded'));
    expect(html.indexOf('Superseded')).toBeLessThan(html.indexOf('<blockquote'));
    expect(html).not.toMatch(/updated or removed/);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  test('an unavailable citation without a tag keeps the amber note', () => {
    const [plain] = citationSourcesFor({ citations: [record(1, 'doc-a')] }, { 'doc-a': 'unavailable' }, []);
    expect(renderEntry(plain)).toMatch(/updated or removed/);
  });

  test('the current citation is tagged only next to a superseded entry', () => {
    const alone = renderToStaticMarkup(createElement(CitationSourceEntry, { source: currentCited, language: 'en' }));
    expect(alone).not.toContain('Current');
    const paired = renderToStaticMarkup(createElement(CitationSourceEntry, { source: currentCited, language: 'en', listHasSuperseded: true }));
    expect(paired).toContain('Current');
    expect(paired).toContain('Version 3');
    expect(paired).not.toContain('Superseded');
  });

  test('the also-in line closes the citation entry as native details', () => {
    const html = renderEntry(superseded);
    expect(html).toMatch(/<details class="group mt-2"><summary[^>]*>.*Also in 3 other documents<\/span><\/summary>/);
    expect(html.indexOf('</blockquote>')).toBeLessThan(html.indexOf('<details'));
    expect(html).toContain('aria-label="Other documents with the same passage"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('<li class="break-words" translate="no">file-0.txt</li>');
    expect(html).not.toContain('open=""');
  });

  test('singular, overflow and localized strings', () => {
    expect(renderEntry({ ...doc(), citation: { ...superseded.citation!, alsoIn: names(1) } })).toContain('Also in 1 other document<');
    const many = renderEntry({ ...doc(), citation: { ...superseded.citation!, alsoIn: names(1234) } });
    expect(many).toContain('Also in 1,234 other documents');
    expect(many).toContain('and 1,184 more');
    expect((many.match(/<li class="break-words"/g) ?? []).length).toBe(50);
    expect(renderEntry(superseded, 'zh')).toContain('已被取代');
    expect(renderEntry(superseded, 'zh')).toContain('另有 3 份文档包含相同内容');
    expect(renderEntry(superseded, 'it')).toContain('Sostituita');
    expect(renderEntry(superseded, 'it')).toContain('Anche in altri 3 documenti');
    expect(renderEntry(superseded, 'fr')).toContain('Superseded');
  });

  test('a file name with markup stays text', () => {
    const html = renderEntry({ ...doc(), citation: { ...superseded.citation!, alsoIn: [{ documentId: 'x', filename: '<img src=x onerror=alert(1)>', chunkId: 'c' }] } });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  test('listed cards: tag under the title, also-in after the link for a linked card, last in the text column otherwise', () => {
    const html = renderPanel([
      doc({ documentId: 'doc-old', title: 'Old', version: 1, isCurrent: false, effectiveTo: '2024-12-31', alsoIn: names(2, 'old'), uploadedAt: '2025-03-01T12:00:00Z' }),
      doc({ documentId: 'doc-new', title: 'New', url: 'https://example.com/new', version: 2, isCurrent: true, alsoIn: names(2, 'new') }),
    ]);
    const oldItem = html.slice(html.indexOf('data-source-id="doc-old"'), html.indexOf('data-source-id="doc-new"'));
    expect(oldItem).toContain('Version 1, in effect until <time dateTime="2024-12-31">');
    expect(oldItem.indexOf('Superseded')).toBeLessThan(oldItem.indexOf('Uploaded:'));
    expect(oldItem.indexOf('Document Source')).toBeLessThan(oldItem.indexOf('<details class="group mt-2">'));
    const newItem = html.slice(html.indexOf('data-source-id="doc-new"'));
    expect(newItem).toContain('Current');
    const linkEnd = newItem.indexOf('</a>');
    const details = newItem.indexOf('<details class="group px-5 pt-2">');
    expect(details).toBeGreaterThan(linkEnd);
    expect(newItem.slice(0, linkEnd)).not.toContain('<details');
  });

  test('old stored sources and web or tool sources with the fields render as before', () => {
    const stored = JSON.parse(JSON.stringify([...BASE_CITATIONS, ...LISTED])) as Source[];
    const before = renderPanel(stored);
    expect(before).not.toContain('<details');
    expect(before).not.toContain('<time');
    const web = { ...LISTED[2], version: 2, isCurrent: false, alsoIn: names(2) } as Source;
    const withFields = renderPanel([...BASE_CITATIONS, LISTED[0], LISTED[1], web]);
    expect(withFields).not.toContain('<details');
    expect(withFields).not.toContain('Superseded');
  });
});

describe('strings', () => {
  test('en, zh and it carry every new key; another language uses en', () => {
    for (const language of ['en', 'zh', 'it']) {
      const s = answerQualityStrings(language);
      expect(typeof s.versionSuperseded).toBe('string');
      expect(typeof s.versionCurrent).toBe('string');
      expect(s.versionOnly(2)).toContain('2');
      for (const key of ['versionFromTo', 'versionFrom', 'versionUntil'] as const) expect(s[key](2)).toContain('2');
      expect(s.versionFromTo(2)).toMatch(/\{from\}.*\{to\}/);
      expect(s.alsoInSummary('3', 3)).toContain('3');
      expect(typeof s.alsoInListLabel).toBe('string');
      expect(s.alsoInMore('4')).toContain('4');
    }
    expect(answerQualityStrings('de').versionSuperseded).toBe('Superseded');
    expect(answerQualityStrings('en').alsoInSummary('1', 1)).toBe('Also in 1 other document');
    expect(answerQualityStrings('it').alsoInSummary('1', 1)).toBe('Anche in 1 altro documento');
  });
});
