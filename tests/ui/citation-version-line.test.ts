import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { FIXED_TEXTS } from '@/lib/rag/lang/texts.generated';
import { citationSourcesFor } from '@/components/providers/sources-provider';
import { CitationSourceEntry } from '@/components/ui/sources-sidebar';

const HASH = 'a'.repeat(64);
const citation = (n: number, documentId: string, extra: Record<string, unknown> = {}) => ({
  n, alias: `S${n}`, chunkIds: [`chunk-${n}`], documentId, documentName: `Doc ${documentId}`, documentVersion: 3,
  page: 2, quote: `Quote ${n}`, quoteHash: HASH, sectionPath: null, strategy: 'chunk-alias', ...extra,
});
const ANSWER_ID = '7d4a2c8e-1f3b-4c5d-9e6f-0a1b2c3d4e5f';
const meta = (citations: unknown[], extra: Record<string, unknown> = {}) => ({ answerId: ANSWER_ID, citationStrategy: 'chunk-alias', citations, ...extra });
const entries = (metadata: unknown, ui = 'en') =>
  citationSourcesFor(metadata, undefined, [], 'm1').map((source) =>
    renderToStaticMarkup(createElement(CitationSourceEntry, { source, language: ui })),
  );

describe('CitationSourceEntry version line (UI-SPEC 6.7)', () => {
  test('label and date: both parts in the answer language, the date in a time element, between title and page line', () => {
    const [html] = entries(meta([citation(1, 'doc-a', { versionLabel: 'Versione 3', effectiveFrom: '2026-01-01' })], { answerLanguage: 'it' }));
    expect(html).toContain('data-citation-version');
    expect(html).toContain('<span>Versione 3</span>');
    expect(html).toContain('In vigore dal <time dateTime="2026-01-01" class="tabular-nums">2026-01-01</time>');
    expect(html).toContain('lang="it"');
    expect(html!.indexOf('</h4>')).toBeLessThan(html!.indexOf('data-citation-version'));
    expect(html!.indexOf('data-citation-version')).toBeLessThan(html!.indexOf('p. 2'));
  });

  test('only a label, only a date, or neither', () => {
    const [labelOnly] = entries(meta([citation(1, 'doc-a', { versionLabel: 'B-2' })]));
    expect(labelOnly).toContain('<span>B-2</span>');
    expect(labelOnly).not.toContain('<time');
    const [dateOnly] = entries(meta([citation(1, 'doc-a', { effectiveFrom: '2026-02-03' })]));
    expect(dateOnly).toContain('<time dateTime="2026-02-03" class="tabular-nums">2026-02-03</time>');
    expect(dateOnly).not.toContain('Version 3');
    const [neither] = entries(meta([citation(1, 'doc-a')]));
    expect(neither).not.toContain('data-citation-version');
  });

  test('with no Phase 5.2 field the entry is today\'s markup', () => {
    const [html] = entries(meta([citation(1, 'doc-a')], { answerLanguage: 'zh' }));
    expect(html).not.toContain('lang=');
    expect(html).not.toContain('data-citation-version');
  });

  test('the older document of a version conflict shows Older version with the clock icon; the latest does not', () => {
    const checks = { version_conflict: { document_ids: ['doc-old', 'doc-new'], latest_document_id: 'doc-new', group_rule: 'title_match', mixed_versions: true } };
    const [older, latest] = entries(meta([citation(1, 'doc-old', { versionLabel: 'Version 1' }), citation(2, 'doc-new', { versionLabel: 'Version 2' })], { checks }));
    expect(older).toContain(FIXED_TEXTS.en.labels.older_version!);
    expect(older).toContain('lucide-clock');
    expect(latest).not.toContain(FIXED_TEXTS.en.labels.older_version!);
  });

  test('the older document without a label shows its integer version', () => {
    const checks = { version_conflict: { document_ids: ['doc-old', 'doc-new'], latest_document_id: 'doc-new', group_rule: 'title_match' } };
    const [older] = entries(meta([citation(1, 'doc-old')], { checks }));
    expect(older).toContain('Version 3');
  });

  test('a label over 40 characters is truncated with the full text in title', () => {
    const long = 'L'.repeat(41);
    const source = citationSourcesFor(meta([citation(1, 'doc-a')]), undefined, [], 'm1')[0]!;
    const html = renderToStaticMarkup(createElement(CitationSourceEntry, { source: { ...source, citation: { ...source.citation!, versionLabel: long } }, language: 'en' }));
    expect(html).toMatch(new RegExp(`<span class="[^"]*truncate[^"]*" title="${long}">${long}</span>`));
  });

  test('markup and javascript: in a version label are text', () => {
    const [html] = entries(meta([citation(1, 'doc-a', { versionLabel: '<img src=x onerror=1>' })]));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    const [js] = entries(meta([citation(1, 'doc-a', { versionLabel: 'javascript:alert(1)' })]));
    expect(js).not.toMatch(/<a\b|href=/);
  });
});
