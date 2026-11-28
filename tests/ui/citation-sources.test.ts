import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test } from 'vitest';
import { citationSourcesFor, type Source } from '@/components/providers/sources-provider';
import { CitationSourceEntry } from '@/components/ui/sources-sidebar';
import { useCitationFocusStore } from '@/lib/stores/citation-focus-store';

const HASH = 'a'.repeat(64);

function citation(n: number, alias: string, documentId: string, extra: Record<string, unknown> = {}) {
  return {
    n,
    alias,
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

const METADATA = {
  answerId: '7d4a2c8e-1f3b-4c5d-9e6f-0a1b2c3d4e5f',
  citationStrategy: 'chunk-alias',
  citations: [
    citation(2, 'S4', 'doc-b', { sectionPath: ['Intro', 'Scope'] }),
    citation(1, 'S1', 'doc-a', { page: 4 }),
  ],
};

const USED_DOC: Source = { title: 'Doc A file', type: 'document', documentId: 'doc-a', provider: 'Document Database' };
const OTHER_DOC: Source = { title: 'Doc C', type: 'document', documentId: 'doc-c', provider: 'Document Database' };
const WEB: Source = { title: 'Web page', type: 'web', url: 'https://example.com/a', provider: 'Exa' };
const TOOL: Source = { title: 'Tool link', type: 'tool_link', url: 'https://example.com/t', provider: 'Tool', toolName: 'search' };

describe('citationSourcesFor', () => {
  test('builds document entries in n order with their snapshot and marks cited documents', () => {
    const existing = [USED_DOC, OTHER_DOC, WEB, TOOL];
    const result = citationSourcesFor(METADATA, { 'doc-a': 'current', 'doc-b': 'unavailable' }, existing, 'msg-1');

    expect(result).toHaveLength(6);
    const [first, second, ...rest] = result;
    expect(first).toMatchObject({
      type: 'document',
      title: 'Doc doc-a',
      documentId: 'doc-a',
      cited: true,
      citation: { n: 1, alias: 'S1', quote: 'Quote 1', page: 4, sectionPath: null, unavailable: false, messageId: 'msg-1' },
    });
    expect(second).toMatchObject({
      type: 'document',
      title: 'Doc doc-b',
      cited: true,
      citation: { n: 2, alias: 'S4', quote: 'Quote 2', page: null, sectionPath: ['Intro', 'Scope'], unavailable: true },
    });
    expect(second.documentId).toBeUndefined();

    expect(rest[0]).toEqual({ ...USED_DOC, cited: true });
    expect(rest[1]).toBe(OTHER_DOC);
    expect(rest[2]).toBe(WEB);
    expect(rest[3]).toBe(TOOL);
  });

  test('a document missing from the record counts as unavailable', () => {
    const [entry] = citationSourcesFor({ citations: [citation(1, 'S1', 'doc-x')] }, {}, []);
    expect(entry.documentId).toBeUndefined();
    expect(entry.citation?.unavailable).toBe(true);
  });

  test('without a record (shared or ghost chat) the snapshot shows without link or note', () => {
    const result = citationSourcesFor(METADATA, undefined, []);
    expect(result.map((s) => s.citation?.n)).toEqual([1, 2]);
    for (const entry of result) {
      expect(entry.documentId).toBeUndefined();
      expect(entry.citation?.unavailable).toBe(false);
    }
  });

  test('a message without citations returns the existing sources unchanged', () => {
    const existing = [USED_DOC, WEB];
    expect(citationSourcesFor({ ragTraceId: 't' }, undefined, existing)).toBe(existing);
    expect(citationSourcesFor(undefined, { 'doc-a': 'current' }, existing)).toBe(existing);
  });

  test('malformed citation entries are dropped, valid ones kept', () => {
    const result = citationSourcesFor({ citations: [{ n: 'x' }, citation(1, 'S1', 'doc-a')] }, { 'doc-a': 'current' }, []);
    expect(result).toHaveLength(1);
    expect(result[0].citation?.alias).toBe('S1');
  });

  test('rebuilding from sources that already hold citation entries does not duplicate them', () => {
    const once = citationSourcesFor(METADATA, { 'doc-a': 'current' }, [USED_DOC, WEB]);
    const twice = citationSourcesFor(METADATA, { 'doc-a': 'current' }, once);
    expect(twice).toEqual(once);
  });
});

describe('useCitationFocusStore', () => {
  beforeEach(() => useCitationFocusStore.getState().clear());

  test('keeps the focused citation and clears it on a chat switch', () => {
    const store = useCitationFocusStore.getState();
    store.syncChat('chat-1');
    store.focusCitation({ chatId: 'chat-1', messageId: 'm1', n: 2 });
    expect(useCitationFocusStore.getState().focus).toEqual({ chatId: 'chat-1', messageId: 'm1', n: 2 });

    useCitationFocusStore.getState().syncChat('chat-1');
    expect(useCitationFocusStore.getState().focus).not.toBeNull();

    useCitationFocusStore.getState().syncChat('chat-2');
    expect(useCitationFocusStore.getState().focus).toBeNull();
  });

  test('clear removes the focus', () => {
    useCitationFocusStore.getState().focusCitation({ chatId: null, messageId: 'm1', n: 1 });
    useCitationFocusStore.getState().clear();
    expect(useCitationFocusStore.getState().focus).toBeNull();
  });
});

describe('CitationSourceEntry', () => {
  const render = (source: Source, language = 'en', focused = false) =>
    renderToStaticMarkup(createElement(CitationSourceEntry, { source, language, focused }));

  const [current, unavailable] = citationSourcesFor(
    {
      citations: [
        citation(1, 'S1', 'doc-a', { page: 4, quote: '<b>bold</b> **not markdown** <img src=x onerror=alert(1)>', documentName: '<i>Name</i>' }),
        citation(2, 'S2', 'doc-b', { sectionPath: ['Intro', 'Scope'] }),
      ],
    },
    { 'doc-a': 'current', 'doc-b': 'unavailable' },
    [],
    'msg-1',
  );

  test('shows number, name, page and quote as literal text', () => {
    const html = render(current);
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt; **not markdown** &lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;i&gt;Name&lt;/i&gt;');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<img');
    expect(html).toMatch(/>1</);
    expect(html).toContain('p. 4');
  });

  test('a current document carries its id and no note', () => {
    const html = render(current);
    expect(html).toContain('data-document-id="doc-a"');
    expect(html).not.toMatch(/updated or removed/);
  });

  test('an unavailable document shows the note with the snapshot and no document id', () => {
    const html = render(unavailable);
    expect(html).toMatch(/updated or removed/);
    expect(html).toContain('Quote 2');
    expect(html).toContain('Intro');
    expect(html).toContain('Scope');
    expect(html).not.toContain('data-document-id');
    expect(html).not.toContain('href=');
  });

  test('the note is localized', () => {
    expect(render(unavailable, 'zh')).toContain('该文档此后已被更新或删除');
    expect(render(unavailable, 'it')).toContain('aggiornato o rimosso');
    expect(render(unavailable, 'fr')).toMatch(/updated or removed/);
  });

  test('the focused entry is marked', () => {
    expect(render(current, 'en', true)).toContain('data-focused="true"');
    expect(render(current, 'en', false)).not.toContain('data-focused="true"');
  });

  test('an entry has a stable anchor for scrolling', () => {
    expect(render(current)).toContain('data-citation-n="1"');
    expect(render(current)).toContain('data-message-id="msg-1"');
  });
});
