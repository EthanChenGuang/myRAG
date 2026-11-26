import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BoilerplateRulesConfigSchema } from '@/lib/rag-eval/contracts.generated';
import { boilerplateConfig, setBoilerplateConfigForTests } from '@/lib/rag/ingest/prepare/boilerplate-config';
import { lineKey, readPageLines } from '@/lib/rag/ingest/prepare/page-lines';

const ROOT = path.resolve(__dirname, '../../..');
const CONFIG_PATH = path.join(ROOT, 'config/rag/boilerplate-rules.json');
const RECORDED = path.join(ROOT, 'eval/fixtures/ingest/recorded/long-table-en.docling.json');

const validConfig = {
  schema_version: 1,
  rules_version: 7,
  page_share: 0.5,
  edge_lines: 2,
  max_line_tokens: 10,
  min_pages: 2,
  fragment_max_length: 8,
  fragment_page_share: 0.4,
  review_share: 0.3,
};

afterEach(() => setBoilerplateConfigForTests(null));

describe('boilerplate-rules.json', () => {
  it('holds numbers only and parses with the generated schema', () => {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(raw)) {
      expect(typeof value, key).toBe('number');
      expect(Number.isFinite(value as number), key).toBe(true);
    }
    const parsed = BoilerplateRulesConfigSchema.parse(raw);
    expect(parsed.rules_version).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(parsed.rules_version)).toBe(true);
  });

  it('is rejected by the schema with an unknown key', () => {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
    expect(() => BoilerplateRulesConfigSchema.parse({ ...raw, extra_threshold: 1 })).toThrow();
  });
});

describe('boilerplateConfig', () => {
  it('returns the file values and the same object on later calls', () => {
    const first = boilerplateConfig();
    const raw = BoilerplateRulesConfigSchema.parse(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
    expect(first).toEqual(raw);
    expect(boilerplateConfig()).toBe(first);
  });

  it('installs a validated override and removes it with null', () => {
    const original = boilerplateConfig();
    setBoilerplateConfigForTests(validConfig);
    expect(boilerplateConfig()).toEqual(validConfig);
    setBoilerplateConfigForTests(null);
    expect(boilerplateConfig()).toBe(original);
  });

  it('throws on a value outside the bounds', () => {
    expect(() => setBoilerplateConfigForTests({ ...validConfig, page_share: 1.5 })).toThrow();
    expect(() => setBoilerplateConfigForTests({ ...validConfig, edge_lines: 0 })).toThrow();
    expect(() => setBoilerplateConfigForTests({ ...validConfig, max_line_tokens: 2.5 })).toThrow();
  });
});

describe('lineKey', () => {
  it('ignores numbers and spacing', () => {
    expect(lineKey('Sheet 12 of 40')).toBe(lineKey('Sheet 3 of 7'));
    expect(lineKey('  alpha   beta\tgamma ')).toBe(lineKey('alpha beta gamma'));
    expect(lineKey('alpha 1')).not.toBe(lineKey('alpha'));
  });

  it('folds full-width and half-width spellings', () => {
    expect(lineKey('ＡＢＣ　１２')).toBe(lineKey('ABC 99'));
  });

  it('gives the empty key for blank lines', () => {
    expect(lineKey('')).toBe('');
    expect(lineKey(' \t  ')).toBe('');
  });
});

describe('readPageLines: docling shape', () => {
  it('reads the recorded document', () => {
    const raw: unknown = JSON.parse(readFileSync(RECORDED, 'utf8'));
    const result = readPageLines(raw);
    expect(result).not.toBeNull();
    expect(result?.pageCount).toBe(2);
    expect(result?.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(result?.pages[0]?.keys).toHaveLength(2);
    expect(result?.pages[1]?.keys).toHaveLength(1);
    const texts = (raw as { texts: Array<{ text: string }> }).texts;
    expect(result?.pages[0]?.keys).toEqual([lineKey(texts[0]!.text), lineKey(texts[1]!.text)]);
  });

  it('holds page numbers and keys only', () => {
    const result = readPageLines(JSON.parse(readFileSync(RECORDED, 'utf8')));
    expect(Object.keys(result ?? {}).sort()).toEqual(['pageCount', 'pages']);
    for (const page of result?.pages ?? []) expect(Object.keys(page).sort()).toEqual(['keys', 'page']);
  });

  it('reads body items only, splits at line breaks and skips items without a page', () => {
    const doc = {
      pages: { '1': {}, '2': {}, '3': {} },
      texts: [
        { text: 'opening line', label: 'text', content_layer: 'body', prov: [{ page_no: 2 }] },
        { text: 'edge marker', label: 'page_header', content_layer: 'furniture', prov: [{ page_no: 1 }] },
        { text: 'first part\nsecond part\n\n', label: 'text', prov: [{ page_no: 1 }] },
        { text: 'no page here', label: 'text', content_layer: 'body' },
        { text: 'later page', label: 'text', prov: [{ page_no: 3 }, { page_no: 1 }] },
      ],
    };
    expect(readPageLines(doc)).toEqual({
      pageCount: 3,
      pages: [
        { page: 1, keys: ['first part', 'second part'] },
        { page: 2, keys: ['opening line'] },
        { page: 3, keys: ['later page'] },
      ],
    });
  });

  it('takes the highest page seen when pages is absent', () => {
    const doc = { texts: [{ text: 'one', prov: [{ page_no: 4 }] }, { text: 'two', prov: [{ page_no: 2 }] }] };
    const result = readPageLines(doc);
    expect(result?.pageCount).toBe(4);
    expect(result?.pages.map((p) => p.page)).toEqual([2, 4]);
  });

  it('caps pages and keys per page', () => {
    const many = Array.from({ length: 6000 }, (_, i) => `entry ${i}`).join('\n');
    const doc = {
      texts: [
        { text: many, prov: [{ page_no: 1 }] },
        { text: 'far page', prov: [{ page_no: 20000 }] },
      ],
    };
    const result = readPageLines(doc);
    expect(result?.pages[0]?.keys.length).toBe(5000);
    expect(result?.pages.some((p) => p.page > 10000)).toBe(false);
    expect(result?.pageCount).toBeLessThanOrEqual(10000);
  });
});

describe('readPageLines: per-page text shape', () => {
  it('reads each page in order and keeps empty pages', () => {
    const doc = {
      pages: [
        { page: 2, text: 'gamma\r\ndelta' },
        { page: 1, text: 'alpha\nbeta' },
        { page: 3, text: '' },
      ],
    };
    expect(readPageLines(doc)).toEqual({
      pageCount: 3,
      pages: [
        { page: 1, keys: ['alpha', 'beta'] },
        { page: 2, keys: ['gamma', 'delta'] },
        { page: 3, keys: [] },
      ],
    });
  });
});

describe('readPageLines: no page structure', () => {
  it.each([
    ['null', null],
    ['number', 42],
    ['string', 'text'],
    ['array', [1, 2, 3]],
    ['empty object', {}],
    ['empty pages list', { pages: [] }],
    ['texts without pages', { texts: [{ text: 'alpha' }] }],
    ['texts not objects', { texts: [1, 'x', null, [], true] }],
    ['wrong field types', { texts: [{ text: 5, prov: 'x' }, { text: 'a', prov: [{ page_no: 'one' }] }], pages: 3 }],
    ['pages entries wrong', { pages: [{ page: 'a', text: 1 }, null, 7] }],
    ['texts is object', { texts: { a: 1 } }],
  ])('returns null for %s', (_label, value) => {
    expect(readPageLines(value)).toBeNull();
  });

  it('never throws on deeply wrong values', () => {
    const odd: unknown[] = [
      { texts: [{ prov: [null, 1] }, { text: null, prov: [{ page_no: -1 }] }, { text: 'x', prov: [{ page_no: 1.5 }] }] },
      { texts: [{ text: 'x', content_layer: 5, prov: [{ page_no: 1 }] }], pages: { a: null } },
      { pages: [{ page: 1, text: { nested: true } }] },
      Object.create(null),
    ];
    for (const value of odd) expect(() => readPageLines(value)).not.toThrow();
  });
});
