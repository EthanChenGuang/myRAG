import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordedRpc } from '../../helpers/ingest-fakes';

/**
 * TPL-04 (D-25, F-13): identifiers from attributes flagged in_identifier_index, merged into the chunk identifier rows by the Phase 4.2
 * indexer. Keys and values are synthetic shapes; MARKER must never reach a log.
 */

const ORG_A = '00000000-0000-4000-8000-0000000016a1';
const ORG_B = '00000000-0000-4000-8000-0000000016b1';
const DOC = '00000000-0000-4000-8000-0000000016d1';
const MARKER = 'QX-7731-MK';
const ON = { RAG_INGEST_PIPELINE: 'unified', RAG_DOC_ATTRIBUTES: 'true' };

const definition = (key: string, type: 'code' | 'text' | 'text_list', flagged: boolean) => ({
  key,
  type,
  filterable: false,
  in_header: false,
  in_identifier_index: flagged,
  soft: false,
});

const FLAGGED = [definition('alpha_code', 'code', true), definition('beta_code', 'code', true), definition('gamma_code', 'code', false), definition('delta_text', 'text', false)];

let logs: string[] = [];

beforeEach(() => {
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('attributeIdentifierEntries', () => {
  it('one entry per flagged attribute with a value: stored spelling and normalised form, in key order', async () => {
    const { attributeIdentifierEntries } = await import('@/lib/rag/ingest/attributes/identifier-feed');
    expect(attributeIdentifierEntries(FLAGGED, { beta_code: 'Zk 40/2', alpha_code: 'AB-12.c', gamma_code: 'QQ-1', delta_text: 'neutral words' })).toEqual([
      { raw: 'AB-12.c', norm: 'ab12c' },
      { raw: 'Zk 40/2', norm: 'zk402' },
    ]);
  });

  it('skips unflagged keys, keys the schema no longer has, absent values and an empty normalised form', async () => {
    const { attributeIdentifierEntries } = await import('@/lib/rag/ingest/attributes/identifier-feed');
    expect(attributeIdentifierEntries(FLAGGED, { gamma_code: 'QQ-1', removed_code: 'RR-1' })).toEqual([]);
    expect(attributeIdentifierEntries(FLAGGED, { alpha_code: ' -./_ ' })).toEqual([]);
    expect(attributeIdentifierEntries(FLAGGED, {})).toEqual([]);
    expect(attributeIdentifierEntries(FLAGGED, null)).toEqual([]);
    expect(attributeIdentifierEntries([], { alpha_code: 'AB-12' })).toEqual([]);
  });

  it('two attributes with the same normalised form give one entry, the first key in key order', async () => {
    const { attributeIdentifierEntries } = await import('@/lib/rag/ingest/attributes/identifier-feed');
    expect(attributeIdentifierEntries(FLAGGED, { beta_code: 'ab 12', alpha_code: 'AB-12' })).toEqual([{ raw: 'AB-12', norm: 'ab12' }]);
  });

  it('is deterministic whatever the key order of the object', async () => {
    const { attributeIdentifierEntries } = await import('@/lib/rag/ingest/attributes/identifier-feed');
    const one = attributeIdentifierEntries(FLAGGED, { alpha_code: 'AB-1', beta_code: 'CD-2' });
    const two = attributeIdentifierEntries([...FLAGGED].reverse(), { beta_code: 'CD-2', alpha_code: 'AB-1' });
    expect(two).toEqual(one);
  });
});

describe('mergeAttributeIdentifiers', () => {
  it('appends the entries to every chunk in order, never twice, raw and norm aligned', async () => {
    const { mergeAttributeIdentifiers } = await import('@/lib/rag/ingest/attributes/identifier-feed');
    const merged = mergeAttributeIdentifiers(
      [
        { raw: ['XY-9'], norm: ['xy9'], truncated: 0 },
        { raw: ['ab 12'], norm: ['ab12'], truncated: 1 },
        { raw: [], norm: [], truncated: 0 },
      ],
      [
        { raw: 'AB-12', norm: 'ab12' },
        { raw: 'CD-3', norm: 'cd3' },
      ],
    );
    expect(merged).toEqual([
      { raw: ['XY-9', 'AB-12', 'CD-3'], norm: ['xy9', 'ab12', 'cd3'], truncated: 0 },
      { raw: ['ab 12', 'CD-3'], norm: ['ab12', 'cd3'], truncated: 1 },
      { raw: ['AB-12', 'CD-3'], norm: ['ab12', 'cd3'], truncated: 0 },
    ]);
  });

  it('keeps the per-chunk cap and counts what it leaves out', async () => {
    const { mergeAttributeIdentifiers } = await import('@/lib/rag/ingest/attributes/identifier-feed');
    const { MAX_CHUNK_IDENTIFIERS } = await import('@/lib/rag/identifiers/extract');
    const full = Array.from({ length: MAX_CHUNK_IDENTIFIERS }, (_, index) => `k${index}`);
    const [merged] = mergeAttributeIdentifiers([{ raw: full, norm: full, truncated: 0 }], [{ raw: 'AB-12', norm: 'ab12' }]);
    expect(merged?.norm).toHaveLength(MAX_CHUNK_IDENTIFIERS);
    expect(merged?.truncated).toBe(1);
  });

  it('with no attribute entries returns the chunk entries unchanged', async () => {
    const { mergeAttributeIdentifiers } = await import('@/lib/rag/ingest/attributes/identifier-feed');
    const chunks = [{ raw: ['XY-9'], norm: ['xy9'], truncated: 0 }];
    expect(mergeAttributeIdentifiers(chunks, [])).toEqual(chunks);
  });
});

interface IndexRun {
  writes: Array<{ documentId: string; rows: Array<{ chunkId: string; raw: string[]; norm: string[] }> }>;
  calls: RecordedRpc[];
  report: Awaited<ReturnType<typeof import('@/lib/rag/ingest/write-indexers')['indexDocumentForLookup']>>;
}

const CHUNKS = [
  { id: '00000000-0000-4000-8000-0000000016c1', chunkingProfileId: 'legacy', chunkIndex: 0, sectionPath: [], content: 'neutral probe sentence with XY-9' },
  { id: '00000000-0000-4000-8000-0000000016c2', chunkingProfileId: 'legacy', chunkIndex: 1, sectionPath: [], content: 'neutral probe sentence two' },
  { id: '00000000-0000-4000-8000-0000000016c3', chunkingProfileId: 'p-alt', chunkIndex: 0, sectionPath: [], content: 'neutral probe sentence three' },
];

async function index(options: {
  env?: Record<string, string>;
  org?: string;
  definitions?: (tenantKey: string) => Record<string, unknown>[];
  attributes?: (tenantKey: string) => Record<string, unknown> | null;
  failures?: Record<string, { code: string; message: string }>;
  identifiers?: boolean;
}): Promise<IndexRun> {
  vi.resetModules();
  const fakes = await import('../../helpers/ingest-fakes');
  const { db, calls } = fakes.fakeIngestDb({
    failures: options.failures,
    answers: {
      rag_attribute_definitions_for: (args) => options.definitions?.(String(args.p_tenant_key)) ?? [],
      rag_document_attributes_read: (args) => {
        const attributes = options.attributes?.(String(args.p_tenant_key));
        return attributes === undefined ? [] : (args.p_document_ids as string[]).map((id) => ({ document_id: id, attributes }));
      },
    },
  });
  fakes.installIngestDeps({ db, env: options.env ?? ON });
  try {
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const { indexDocumentForLookup } = await import('@/lib/rag/ingest/write-indexers');
    const writes: IndexRun['writes'] = [];
    const writer = {
      async listDocumentChunksForIndex(_documentId: string, after: string | null) {
        return after === null ? CHUNKS : [];
      },
      async writeChunkIdentifiers(documentId: string, rows: Array<{ chunkId: string; raw: string[]; norm: string[] }>) {
        writes.push({ documentId, rows: rows.map((row) => ({ chunkId: row.chunkId, raw: [...row.raw], norm: [...row.norm] })) });
        return { chunksWritten: rows.length, documentChanged: true };
      },
      async writeTableRows() {
        return { rowsWritten: 0, rowsDeleted: 0 };
      },
    };
    const report = await indexDocumentForLookup({
      writer,
      scope: mintScope('org', null, options.org ?? ORG_A),
      documentId: DOC,
      tables: false,
      identifiers: options.identifiers ?? true,
      signal: new AbortController().signal,
      loadPatterns: async () => ({ expressions: [], patternIds: [], loadFailed: false }),
    });
    return { writes, calls: calls as RecordedRpc[], report };
  } finally {
    fakes.uninstallIngestDeps();
  }
}

const tenantA = `o:${ORG_A}`;

describe('indexDocumentForLookup with the attribute feed', () => {
  it('both switches on: every chunk of every profile carries the flagged value, normalised and as spelled', async () => {
    const run = await index({
      definitions: (key) => (key === tenantA ? FLAGGED : []),
      attributes: (key) => (key === tenantA ? { alpha_code: 'AB-12.c', gamma_code: 'QQ-1' } : null),
    });
    expect(run.writes).toHaveLength(1);
    const rows = run.writes[0]?.rows ?? [];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.norm).toContain('ab12c');
      expect(row.raw[row.norm.indexOf('ab12c')]).toBe('AB-12.c');
      expect(row.norm).not.toContain('qq1');
      expect(row.raw).toHaveLength(row.norm.length);
    }
    expect(rows[0]?.norm).toEqual(['xy9', 'ab12c']);
    expect(run.report.identifiers?.attributeEntries).toBe(1);
    expect(run.report.warnings).toEqual([]);
  });

  it('two spellings differing by separators or case give one normalised value on each chunk', async () => {
    const run = await index({
      definitions: () => FLAGGED,
      attributes: () => ({ alpha_code: 'ab-12', beta_code: 'AB 12' }),
    });
    for (const row of run.writes[0]?.rows ?? []) expect(row.norm.filter((value) => value === 'ab12')).toHaveLength(1);
  });

  it('RAG_DOC_ATTRIBUTES off: no schema or attribute read, and the written rows equal the indexer without the feed', async () => {
    const off = await index({ env: { RAG_INGEST_PIPELINE: 'unified' }, definitions: () => FLAGGED, attributes: () => ({ alpha_code: 'AB-12' }) });
    const plain = await index({ env: { RAG_INGEST_PIPELINE: 'unified' } });
    expect(off.calls).toEqual([]);
    expect(off.writes).toEqual(plain.writes);
    expect(off.writes[0]?.rows.map((row) => row.norm)).toEqual([['xy9'], [], []]);
    expect(off.report).toEqual(plain.report);
    expect(off.report.identifiers).not.toHaveProperty('attributeEntries');
  });

  it('no flagged definition: the schema is read, no attribute read, and the rows equal the indexer without the feed', async () => {
    const run = await index({ definitions: () => [definition('gamma_code', 'code', false)], attributes: () => ({ gamma_code: 'QQ-1' }) });
    expect(run.calls.map((call) => call.fn)).toEqual(['rag_attribute_definitions_for']);
    expect(run.writes[0]?.rows.map((row) => row.norm)).toEqual([['xy9'], [], []]);
  });

  it('a failed schema read is an identifier failure: nothing written, one index_identifiers_failed warning', async () => {
    const run = await index({ definitions: () => FLAGGED, failures: { rag_attribute_definitions_for: { code: 'XX000', message: 'boom' } } });
    expect(run.writes).toEqual([]);
    expect(run.report.identifiers).toBeNull();
    expect(run.report.warnings).toEqual(['index_identifiers_failed']);
    expect(logs.filter((line) => line.includes('index_identifiers_failed'))).toHaveLength(1);
  });

  it('a failed attribute read is an identifier failure: nothing written, one warning, no value in a log', async () => {
    const run = await index({
      definitions: () => FLAGGED,
      attributes: () => ({ alpha_code: MARKER }),
      failures: { rag_document_attributes_read: { code: 'XX000', message: MARKER } },
    });
    expect(run.writes).toEqual([]);
    expect(run.report.warnings).toEqual(['index_identifiers_failed']);
    expect(logs.join('\n')).not.toContain(MARKER);
  });

  it("reads definitions and attributes for the indexer's own tenant only", async () => {
    const run = await index({
      org: ORG_B,
      definitions: (key) => (key === tenantA ? FLAGGED : [definition('alpha_code', 'code', true)]),
      attributes: (key) => (key === tenantA ? { alpha_code: 'AA-1' } : { alpha_code: 'BB-2' }),
    });
    const tenants = new Set(run.calls.map((call) => call.args.p_tenant_key));
    expect(tenants).toEqual(new Set([`o:${ORG_B}`]));
    for (const row of run.writes[0]?.rows ?? []) {
      expect(row.norm).toContain('bb2');
      expect(row.norm).not.toContain('aa1');
    }
  });

  it('the identifier part off: nothing read, nothing written', async () => {
    const run = await index({ identifiers: false, definitions: () => FLAGGED, attributes: () => ({ alpha_code: 'AB-12' }) });
    expect(run.calls).toEqual([]);
    expect(run.writes).toEqual([]);
  });

  it('no log line carries an identifier or a value', async () => {
    await index({ definitions: () => FLAGGED, attributes: () => ({ alpha_code: MARKER }) });
    expect(logs.join('\n')).not.toContain(MARKER);
    expect(logs.join('\n').toLowerCase()).not.toContain('qx7731mk');
  });
});
