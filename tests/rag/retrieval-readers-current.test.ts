import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAssemblyRows } from '@/lib/rag/context/fetch-rows';
import { fetchOverviewDocuments } from '@/lib/rag/context/overview';
import { resolveDocumentRefs } from '@/lib/rag/refs/resolve';
import { mintScope } from '@/lib/rag/tenant/scope';
import { voiceKeywordFallback } from '@/lib/rag/voice/keyword-fallback';
import { opsOf, recordingAdmin, type RecordedCall } from './helpers/recording-admin';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const DOC_READY = '00000000-0000-4000-8000-0000000000d1';
const DOC_QUARANTINED = '00000000-0000-4000-8000-0000000000d2';
const DOC_OLD = '00000000-0000-4000-8000-0000000000d3';
const signal = new AbortController().signal;

const CURRENT: Array<[string, unknown]> = [
  ['is_current', true],
  ['status', 'ready'],
];

function filtersOf(call: RecordedCall): unknown[][] {
  return opsOf(call, 'eq').filter(([column]) => column === 'is_current' || column === 'status');
}

function expectCurrentFilters(call: RecordedCall): void {
  expect(filtersOf(call), `${call.table} query carries the D-08 filters`).toEqual(expect.arrayContaining(CURRENT));
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('voice keyword fallback honours the D-08 filter', () => {
  const respond = (call: RecordedCall) => (call.table === 'documents' ? { data: [{ id: DOC_READY }], error: null } : { data: [], error: null });

  it.each([
    ['single', mintScope('single', null, null)],
    ['personal', mintScope('personal', USER_A, null)],
    ['org', mintScope('org', USER_A, ORG_O)],
  ] as const)('%s scope: every documents and document_chunks query filters is_current and status ready', async (_name, scope) => {
    const { admin, calls } = recordingAdmin(respond);

    await voiceKeywordFallback({ query: 'show me the logo', scope, admin, signal, existing: [] });

    const reads = calls.filter((call) => call.table === 'documents' || call.table === 'document_chunks');
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const call of reads) expectCurrentFilters(call);
    expect(reads.some((call) => call.table === 'document_chunks')).toBe(true);
  });
});

describe('document references honour the D-08 filter', () => {
  interface Row extends Record<string, unknown> {
    id: string;
  }

  /** Applies eq / is / in / ilike / limit / single like the database would and records the calls. */
  function filteringAdmin(tables: Record<string, Row[]>) {
    const calls: RecordedCall[] = [];
    const admin = {
      from(table: string) {
        const call: RecordedCall = { table, ops: [], signal: null };
        const predicates: Array<(row: Row) => boolean> = [];
        let limit = Infinity;
        let single = false;
        const builder: Record<string, unknown> = {};
        const record = (op: string, args: unknown[]) => {
          call.ops.push({ op, args });
          return builder;
        };
        builder.select = (list: string) => record('select', [list]);
        builder.eq = (column: string, value: unknown) => {
          predicates.push((row) => row[column] === value);
          return record('eq', [column, value]);
        };
        builder.is = (column: string, value: unknown) => {
          predicates.push((row) => (row[column] ?? null) === value);
          return record('is', [column, value]);
        };
        builder.in = (column: string, values: unknown[]) => {
          predicates.push((row) => values.includes(row[column]));
          return record('in', [column, values]);
        };
        builder.ilike = (column: string, pattern: string) => {
          const matcher = new RegExp(`^${pattern.replace(/%/g, '.*')}$`, 'i');
          predicates.push((row) => matcher.test(String(row[column] ?? '')));
          return record('ilike', [column, pattern]);
        };
        builder.limit = (count: number) => {
          limit = count;
          return record('limit', [count]);
        };
        builder.single = () => {
          single = true;
          return record('single', []);
        };
        builder.abortSignal = () => builder;
        builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
          calls.push(call);
          const matched = (tables[table] ?? []).filter((row) => predicates.every((predicate) => predicate(row))).slice(0, limit);
          const response = single
            ? matched.length === 1
              ? { data: matched[0], error: null }
              : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }
            : { data: matched, error: null };
          return Promise.resolve(response).then(onFulfilled, onRejected);
        };
        return builder;
      },
    };
    return { admin: admin as unknown as SupabaseClient, calls };
  }

  const baseDocument = { created_at: '2025-01-15T00:00:00.000Z', user_id: USER_A, organization_id: null, metadata: {} };

  function seed(): Record<string, Row[]> {
    return {
      documents: [
        { ...baseDocument, id: DOC_READY, filename: 'ready-handbook.md', content: 'ready full text', is_current: true, status: 'ready' },
        { ...baseDocument, id: DOC_QUARANTINED, filename: 'held-handbook.md', content: 'held full text', is_current: false, status: 'quarantined' },
        { ...baseDocument, id: DOC_OLD, filename: 'old-handbook.md', content: 'old full text', is_current: false, status: 'ready' },
      ],
      document_chunks: [
        { id: 'chunk-ready', document_id: DOC_READY, content: 'ready chunk', is_current: true, status: 'ready' },
        { id: 'chunk-held-quarantined', document_id: DOC_READY, content: 'held chunk of a ready document', is_current: false, status: 'quarantined' },
        { id: 'chunk-held', document_id: DOC_QUARANTINED, content: 'quarantined chunk', is_current: false, status: 'quarantined' },
        { id: 'chunk-old', document_id: DOC_OLD, content: 'superseded chunk', is_current: false, status: 'ready' },
      ],
    };
  }

  const personal = mintScope('personal', USER_A, null);

  it('every documents and document_chunks query carries the filters', async () => {
    const { admin, calls } = filteringAdmin(seed());

    await resolveDocumentRefs({ scope: personal, mentions: ['ready-handbook'], documentParts: [{ id: DOC_READY, name: 'ready-handbook.md' }], admin, signal });

    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) expectCurrentFilters(call);
  });

  it('a quarantined document referenced by id or by name yields no chunk, no text and no used-document entry', async () => {
    const { admin } = filteringAdmin(seed());

    const result = await resolveDocumentRefs({
      scope: personal,
      mentions: ['held-handbook'],
      documentParts: [{ id: DOC_QUARANTINED, name: 'held-handbook.md' }],
      admin,
      signal,
    });

    expect(result.usedDocuments).toEqual([]);
    expect(result.context).toBe('');
    expect(result.ignored).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result)).not.toContain('held');
  });

  it('a superseded version referenced by id is not read either', async () => {
    const { admin } = filteringAdmin(seed());

    const result = await resolveDocumentRefs({ scope: personal, mentions: [], documentParts: [{ id: DOC_OLD, name: 'old-handbook.md' }], admin, signal });

    expect(result.usedDocuments).toEqual([]);
    expect(result.context).toBe('');
  });

  it('a ready document returns only its current ready chunks', async () => {
    const { admin } = filteringAdmin(seed());

    const result = await resolveDocumentRefs({ scope: personal, mentions: [], documentParts: [{ id: DOC_READY, name: 'ready-handbook.md' }], admin, signal });

    expect(result.usedDocuments.map((doc) => doc.id)).toEqual([DOC_READY]);
    expect(result.context).toContain('ready chunk');
    expect(result.context).not.toContain('held chunk of a ready document');
  });

  it('the full-text fallback and the select-star chunk fallback are filtered too', async () => {
    const tables = seed();
    tables.document_chunks = [{ id: 'chunk-held-only', document_id: DOC_READY, content: 'only a quarantined chunk', is_current: false, status: 'quarantined' }];
    const { admin, calls } = filteringAdmin(tables);

    const result = await resolveDocumentRefs({ scope: personal, mentions: [], documentParts: [{ id: DOC_READY, name: 'ready-handbook.md' }], admin, signal });

    expect(result.context).not.toContain('only a quarantined chunk');
    for (const call of calls) expectCurrentFilters(call);
  });
});

describe('the overview documents lookup honours the D-08 filter', () => {
  it('filters is_current and status ready next to the id list', async () => {
    const { admin, calls } = recordingAdmin(() => ({ data: [], error: null }));

    await fetchOverviewDocuments([{ chunk_id: 'c1', document_id: DOC_READY, content: 'x', similarity: 0.9 }], { admin, signal });

    expect(calls).toHaveLength(1);
    expect(opsOf(calls[0] as RecordedCall, 'in')).toEqual([['id', [DOC_READY]]]);
    expectCurrentFilters(calls[0] as RecordedCall);
  });
});

describe('by-id reads for already filtered candidates stay unfiltered', () => {
  it('fetchAssemblyRows adds no is_current or status filter so stored citations keep resolving', async () => {
    const { admin, calls } = recordingAdmin(() => ({ data: [], error: null }));

    await fetchAssemblyRows(
      [{ chunk_id: 'c1', document_id: DOC_READY, content: 'x', similarity: 0.9, metadata: null, temporal_score: 0, financial_score: 0, final_score: 0.9, match_reason: 'similarity' }],
      { adminClient: admin, signal },
    );

    expect(calls.map((call) => call.table).sort()).toEqual(['document_chunks', 'documents']);
    for (const call of calls) expect(filtersOf(call)).toEqual([]);
  });
});
