import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { loadIngestConfig, type IngestConfig } from '@/lib/rag/ingest/config';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { renderTemplateHeader } from '@/lib/rag/ingest/text/embedding-text';
import {
  attributeHeaderEnabled,
  attributeHeaderStamp,
  chunkHeadersFor,
  documentHeadersFor,
  listStaleHeaderDocuments,
  loadHeaderTemplate,
  placeholdersOf,
  renderAttributeHeader,
  resetHeaderTemplateCacheForTests,
  setHeaderTemplate,
  getHeaderTemplate,
} from '@/lib/rag/ingest/attributes/header';
import { importAttributeRows, renderDocumentHeaders, renderPendingHeaders, writeDocumentAttributes } from '@/lib/rag/ingest/attributes/apply';
import { resetAttributeSchemaCacheForTests } from '@/lib/rag/ingest/attributes/schema';

/**
 * TPL-05 (D-26, D-27): rendering, the stamp, the template service and its tenant-keyed cache, the batched header reads and the re-render
 * on the attribute apply path. Templates, keys and values are synthetic; MARKER is a value that must never reach a log line.
 */

const MARKER = 'marker-value-h5q';
const TENANT_A = 'o:00000000-0000-4000-8000-0000000015a1';
const TENANT_B = 'o:00000000-0000-4000-8000-0000000015b2';
const ACTOR = '00000000-0000-4000-8000-0000000015c3';
const DOC_1 = '11111111-1111-4111-8111-111111111111';
const DOC_2 = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = 'A {alpha_code} | B {beta_list}';
const signal = new AbortController().signal;

const ON: IngestConfig = loadIngestConfig({ RAG_INGEST_PIPELINE: 'unified', RAG_DOC_ATTRIBUTES: 'true', RAG_ATTRIBUTE_HEADER: 'true' });
const ATTRIBUTES_ONLY: IngestConfig = loadIngestConfig({ RAG_INGEST_PIPELINE: 'unified', RAG_DOC_ATTRIBUTES: 'true' });
const HEADER_WITHOUT_ATTRIBUTES: IngestConfig = loadIngestConfig({ RAG_INGEST_PIPELINE: 'unified', RAG_ATTRIBUTE_HEADER: 'true' });
const LEGACY: IngestConfig = loadIngestConfig({ RAG_DOC_ATTRIBUTES: 'true', RAG_ATTRIBUTE_HEADER: 'true' });

type Row = Record<string, unknown>;
type Call = { fn: string; args: Row };
type Handler = (args: Row) => RpcResponse;

function fakeDb(handlers: Record<string, Handler>): RpcClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args: args as Row });
      const handler = handlers[fn];
      const response: RpcResponse = handler ? handler(args as Row) : { data: [], error: null };
      const run = Promise.resolve(response);
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

const ok = (data: unknown): RpcResponse => ({ data, error: null });
const fns = (calls: Call[]) => calls.map((call) => call.fn);

let lines: string[] = [];
let now = 1_000_000;

beforeEach(() => {
  lines = [];
  now = 1_000_000;
  const capture = (...args: unknown[]) => void lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation(capture);
  resetHeaderTemplateCacheForTests();
  resetAttributeSchemaCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetIngestDepsForTests();
});

function useDb(db: RpcClient | null): void {
  setIngestDepsForTests({ db: () => db, now: () => now });
}

describe('renderAttributeHeader and the stamp', () => {
  it('renders the placeholders of the template, joins lists, leaves out a segment with a missing value', () => {
    const rendered = renderAttributeHeader(TEMPLATE, { alpha_code: 'K-1', beta_list: ['b1', 'b2'], gamma_text: 'unused' }, '; ');
    expect(rendered.header).toBe('A K-1 | B b1; b2');
    expect(rendered.row).toEqual({ alpha_code: 'K-1', beta_list: 'b1; b2' });
    expect(renderAttributeHeader(TEMPLATE, { alpha_code: 'K-1' }, ', ')).toEqual({ header: 'A K-1', row: { alpha_code: 'K-1', beta_list: null } });
    expect(renderAttributeHeader(TEMPLATE, null, ', ')).toEqual({ header: '', row: { alpha_code: null, beta_list: null } });
    expect(renderAttributeHeader(TEMPLATE, { beta_list: [] }, ', ').header).toBe('');
  });

  it('a header over 500 characters loses trailing segments until it fits', () => {
    const long = 'x'.repeat(300);
    const rendered = renderAttributeHeader('{alpha_code} | {beta_list} | tail', { alpha_code: long, beta_list: [long] }, ', ');
    expect(rendered.header).toBe(long);
    const tooLong = renderAttributeHeader('{alpha_code}', { alpha_code: 'y'.repeat(600) }, ', ');
    expect(tooLong.header).toBe('');
  });

  it('every placeholder name placeholdersOf finds is one renderTemplateHeader asks for, so rendering never throws', () => {
    const shapes = ['{alpha_code}', 'lead {alpha_code} | {beta_list} tail', '{alpha_code}{alpha_code}', 'no placeholders', '| {alpha_code} |', '{{alpha_code}}'];
    for (const shape of shapes) {
      const row = Object.fromEntries(placeholdersOf(shape).map((name) => [name, 'v']));
      expect(() => renderTemplateHeader(shape, row)).not.toThrow();
      expect(() => renderAttributeHeader(shape, {}, ', ')).not.toThrow();
    }
  });

  it('stamp: t<version>.<12 hex>; equal rows and versions are equal; a value, list order or version change it; unnamed keys do not', () => {
    const base = renderAttributeHeader(TEMPLATE, { alpha_code: 'K-1', beta_list: ['b1', 'b2'] }, ', ').row;
    const stamp = attributeHeaderStamp(3, base);
    expect(stamp).toMatch(/^t3\.[0-9a-f]{12}$/);
    expect(attributeHeaderStamp(3, renderAttributeHeader(TEMPLATE, { alpha_code: 'K-1', beta_list: ['b1', 'b2'], gamma_text: 'g' }, ', ').row)).toBe(stamp);
    expect(attributeHeaderStamp(3, renderAttributeHeader(TEMPLATE, { alpha_code: 'K-2', beta_list: ['b1', 'b2'] }, ', ').row)).not.toBe(stamp);
    expect(attributeHeaderStamp(3, renderAttributeHeader(TEMPLATE, { alpha_code: 'K-1', beta_list: ['b2', 'b1'] }, ', ').row)).not.toBe(stamp);
    expect(attributeHeaderStamp(4, base)).not.toBe(stamp);
  });

  it('attributeHeaderEnabled follows the effective switch', () => {
    expect(attributeHeaderEnabled(ON)).toBe(true);
    expect(attributeHeaderEnabled(ATTRIBUTES_ONLY)).toBe(false);
    expect(attributeHeaderEnabled(HEADER_WITHOUT_ATTRIBUTES)).toBe(false);
    expect(attributeHeaderEnabled(LEGACY)).toBe(false);
  });
});

const definitionRows = [
  { key: 'alpha_code', type: 'code', filterable: false, in_header: true, in_identifier_index: false, soft: false, updated_at: '2026-01-01T00:00:00Z' },
  { key: 'beta_list', type: 'text_list', filterable: false, in_header: true, in_identifier_index: false, soft: false, updated_at: '2026-01-01T00:00:00Z' },
  { key: 'gamma_text', type: 'text', filterable: false, in_header: false, in_identifier_index: false, soft: false, updated_at: '2026-01-01T00:00:00Z' },
];

describe('template service', () => {
  it('refuses a template over 200 characters before any database call', async () => {
    const db = fakeDb({});
    useDb(db);
    expect(await setHeaderTemplate({ actorUserId: ACTOR, tenantKey: TENANT_A, signal }, 'x'.repeat(201))).toEqual({ ok: false, reason: 'invalid_argument' });
    expect(db.calls).toEqual([]);
  });

  it('refuses placeholders outside the in_header keys with their names and never calls the writer', async () => {
    const db = fakeDb({ rag_attribute_definitions_list: () => ok(definitionRows) });
    useDb(db);
    const result = await setHeaderTemplate({ actorUserId: ACTOR, tenantKey: TENANT_A, signal }, '{alpha_code} | {gamma_text} | {missing_key}');
    expect(result).toEqual({ ok: false, reason: 'unknown_placeholder', placeholders: ['gamma_text', 'missing_key'] });
    expect(fns(db.calls)).toEqual(['rag_attribute_definitions_list']);
  });

  it('saves, maps SQL words, and invalidates only the own tenant entry', async () => {
    let version = 1;
    const db = fakeDb({
      rag_attribute_definitions_list: () => ok(definitionRows),
      rag_attribute_header_template_set: () => ok([{ template: TEMPLATE, version, updated_at: '2026-01-01T00:00:00Z' }]),
      rag_attribute_header_template_for: () => ok([{ template: TEMPLATE, version }]),
    });
    useDb(db);
    await loadHeaderTemplate(TENANT_A, { signal });
    await loadHeaderTemplate(TENANT_B, { signal });
    version = 2;
    expect(await setHeaderTemplate({ actorUserId: ACTOR, tenantKey: TENANT_A, signal }, TEMPLATE)).toEqual({ ok: true, template: TEMPLATE, version: 2 });
    db.calls.length = 0;
    expect(await loadHeaderTemplate(TENANT_A, { signal })).toEqual({ ok: true, template: { template: TEMPLATE, version: 2 } });
    expect(await loadHeaderTemplate(TENANT_B, { signal })).toEqual({ ok: true, template: { template: TEMPLATE, version: 1 } });
    expect(fns(db.calls)).toEqual(['rag_attribute_header_template_for']);
    expect(db.calls[0]?.args).toEqual({ p_tenant_key: TENANT_A });

    const refused = fakeDb({
      rag_attribute_definitions_list: () => ok(definitionRows),
      rag_attribute_header_template_set: () => ({ data: null, error: { code: '42501', message: 'not_admin' } }),
    });
    useDb(refused);
    expect(await setHeaderTemplate({ actorUserId: ACTOR, tenantKey: TENANT_A, signal }, TEMPLATE)).toEqual({ ok: false, reason: 'not_admin' });
    const broken = fakeDb({
      rag_attribute_definitions_list: () => ok(definitionRows),
      rag_attribute_header_template_set: () => ({ data: null, error: { code: 'XX000', message: `boom ${MARKER}` } }),
    });
    useDb(broken);
    expect(await setHeaderTemplate({ actorUserId: ACTOR, tenantKey: TENANT_A, signal }, TEMPLATE)).toEqual({ ok: false, reason: 'unavailable' });
    expect(lines.join('\n')).not.toContain(MARKER);
    expect(lines.join('\n')).not.toContain(TEMPLATE);
  });

  it('get answers template null and version 0 without a row; null removes', async () => {
    const db = fakeDb({ rag_attribute_header_template_get: () => ok([]), rag_attribute_header_template_set: () => ok([]) });
    useDb(db);
    expect(await getHeaderTemplate({ actorUserId: ACTOR, tenantKey: TENANT_A, signal })).toEqual({ ok: true, template: null, version: 0, updatedAt: null });
    expect(await setHeaderTemplate({ actorUserId: ACTOR, tenantKey: TENANT_A, signal }, null)).toEqual({ ok: true, template: null, version: 0 });
    expect(fns(db.calls)).toEqual(['rag_attribute_header_template_get', 'rag_attribute_header_template_set']);
  });

  it('loadHeaderTemplate: one database call within the time to live, per tenant key; reset clears it', async () => {
    const db = fakeDb({ rag_attribute_header_template_for: (args) => ok(args.p_tenant_key === TENANT_A ? [{ template: TEMPLATE, version: 3 }] : []) });
    useDb(db);
    expect(await loadHeaderTemplate(TENANT_A, { signal })).toEqual({ ok: true, template: { template: TEMPLATE, version: 3 } });
    expect(await loadHeaderTemplate(TENANT_A, { signal })).toEqual({ ok: true, template: { template: TEMPLATE, version: 3 } });
    expect(await loadHeaderTemplate(TENANT_B, { signal })).toEqual({ ok: true, template: null });
    expect(db.calls.map((call) => call.args.p_tenant_key)).toEqual([TENANT_A, TENANT_B]);
    now += 61_000;
    await loadHeaderTemplate(TENANT_A, { signal });
    expect(db.calls).toHaveLength(3);
    resetHeaderTemplateCacheForTests();
    await loadHeaderTemplate(TENANT_A, { signal });
    expect(db.calls).toHaveLength(4);
  });
});

describe('batched header reads', () => {
  it('return an empty map without a database call while the switch is effectively off', async () => {
    const db = fakeDb({});
    useDb(db);
    for (const config of [ATTRIBUTES_ONLY, HEADER_WITHOUT_ATTRIBUTES, LEGACY]) {
      expect((await documentHeadersFor(TENANT_A, [DOC_1], { signal, config })).size).toBe(0);
      expect((await chunkHeadersFor([{ chunkId: DOC_1, tenantKey: TENANT_A }], { signal, config })).size).toBe(0);
    }
    expect(db.calls).toEqual([]);
  });

  it('page by 1,000 ids per tenant key; chunk reads are grouped by their own tenant key', async () => {
    const db = fakeDb({
      rag_attribute_headers: (args) => {
        if (Array.isArray(args.p_document_ids)) return ok([{ document_id: DOC_1, chunk_id: null, header: 'A K-1', stamp: 't1.0123456789ab' }]);
        return ok((args.p_chunk_ids as string[]).slice(0, 1).map((id) => ({ document_id: DOC_1, chunk_id: id, header: `h-${String(args.p_tenant_key).slice(-2)}`, stamp: 't1.0123456789ab' })));
      },
    });
    useDb(db);
    const ids = Array.from({ length: 1500 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const docs = await documentHeadersFor(TENANT_A, ids, { signal, config: ON });
    expect(docs.get(DOC_1)).toEqual({ header: 'A K-1', stamp: 't1.0123456789ab' });
    expect(db.calls.map((call) => (call.args.p_document_ids as string[]).length)).toEqual([1000, 500]);
    db.calls.length = 0;
    const chunks = await chunkHeadersFor(
      [
        { chunkId: DOC_1, tenantKey: TENANT_A },
        { chunkId: DOC_2, tenantKey: TENANT_B },
      ],
      { signal, config: ON },
    );
    expect(db.calls.map((call) => [call.args.p_tenant_key, call.args.p_chunk_ids])).toEqual([
      [TENANT_A, [DOC_1]],
      [TENANT_B, [DOC_2]],
    ]);
    expect(chunks.get(DOC_1)).toBe('h-a1');
    expect(chunks.get(DOC_2)).toBe('h-b2');
  });

  it('stale listing pages with a look-ahead row', async () => {
    const db = fakeDb({
      rag_attribute_header_stale: (args) =>
        ok(Array.from({ length: Number(args.p_limit) }, (_, index) => ({ document_id: `d${index}`, doc_type: 'general', stamp: null, stale_chunks: 2 }))),
    });
    useDb(db);
    const listed = await listStaleHeaderDocuments(TENANT_A, { signal, limit: 3 });
    expect(listed).toEqual({ ok: true, more: true, items: [0, 1, 2].map((index) => ({ documentId: `d${index}`, docType: 'general', stamp: null, staleChunks: 2 })) });
    expect(db.calls[0]?.args).toEqual({ p_tenant_key: TENANT_A, p_profile_id: null, p_after: null, p_limit: 4 });
  });
});

function applyDb(template: { template: string; version: number } | null, attributes: Record<string, unknown> | null) {
  return fakeDb({
    rag_apply_document_attributes: () => ok([{ document_id: DOC_1, origin: 'explicit', key_count: 2, chunks_updated: 0 }]),
    rag_attribute_header_template_for: () => ok(template ? [template] : []),
    rag_document_attributes_read: (args) => ok((args.p_document_ids as string[]).map((id) => ({ document_id: id, attributes }))),
    rag_set_document_attribute_headers: (args) => ok([{ updated: (args.p_rows as unknown[]).length, unchanged: 0 }]),
    rag_import_document_attributes: () =>
      ok([{ documents_changed: 2, documents_unchanged: 0, chunks_updated: 4, staged: 0, staged_unchanged: 0, changed_document_ids: [DOC_1, DOC_2], outbox_rows: 0 }]),
  });
}

describe('the apply path re-renders headers', () => {
  it('switch on with a template: the document header and stamp are stored after the apply', async () => {
    const db = applyDb({ template: TEMPLATE, version: 2 }, { alpha_code: MARKER, beta_list: ['b1', 'b2'] });
    useDb(db);
    await writeDocumentAttributes(db, TENANT_A, DOC_1, { alpha_code: MARKER }, signal, { config: ON });
    expect(fns(db.calls)).toEqual(['rag_apply_document_attributes', 'rag_attribute_header_template_for', 'rag_document_attributes_read', 'rag_set_document_attribute_headers']);
    const write = db.calls.at(-1)?.args;
    expect(write?.p_tenant_key).toBe(TENANT_A);
    const [row] = write?.p_rows as Array<{ document_id: string; header: string; stamp: string }>;
    expect(row?.document_id).toBe(DOC_1);
    expect(row?.header).toBe(`A ${MARKER} | B b1, b2`);
    expect(row?.stamp).toMatch(/^t2\.[0-9a-f]{12}$/);
    expect(lines.join('\n')).not.toContain(MARKER);
    expect(lines.join('\n')).not.toContain(TEMPLATE);
    expect(lines.some((line) => line.includes('attribute headers rendered') && line.includes('"version":2'))).toBe(true);
  });

  it('a document without attributes still gets a stamp with an empty header', async () => {
    const db = applyDb({ template: TEMPLATE, version: 1 }, null);
    useDb(db);
    await renderDocumentHeaders(db, TENANT_A, [DOC_1], signal);
    const [row] = db.calls.at(-1)?.args.p_rows as Array<{ header: string; stamp: string }>;
    expect(row?.header).toBe('');
    expect(row?.stamp).toMatch(/^t1\.[0-9a-f]{12}$/);
  });

  it('after an import batch the changed documents are re-rendered; a dry run renders nothing', async () => {
    const db = applyDb({ template: TEMPLATE, version: 1 }, { alpha_code: 'K-1' });
    useDb(db);
    const rows = [{ source: 'config_upload', sourceKey: 'k1', attributes: { alpha_code: 'K-1' } }];
    await importAttributeRows(db, TENANT_A, rows, { dryRun: true, signal, config: ON });
    expect(fns(db.calls)).toEqual(['rag_import_document_attributes']);
    db.calls.length = 0;
    const result = await importAttributeRows(db, TENANT_A, rows, { dryRun: false, signal, config: ON });
    expect(result.ok).toBe(true);
    expect(fns(db.calls)).toEqual(['rag_import_document_attributes', 'rag_attribute_header_template_for', 'rag_document_attributes_read', 'rag_set_document_attribute_headers']);
    expect((db.calls.at(-1)?.args.p_rows as Array<{ document_id: string }>).map((row) => row.document_id)).toEqual([DOC_1, DOC_2]);
  });

  it('off: the call list equals the one before this plan and no header column is written', async () => {
    for (const config of [ATTRIBUTES_ONLY, HEADER_WITHOUT_ATTRIBUTES, LEGACY]) {
      const db = applyDb({ template: TEMPLATE, version: 1 }, { alpha_code: 'K-1' });
      useDb(db);
      await writeDocumentAttributes(db, TENANT_A, DOC_1, { alpha_code: 'K-1' }, signal, { config });
      await importAttributeRows(db, TENANT_A, [{ source: 'config_upload', sourceKey: 'k1', attributes: { alpha_code: 'K-1' } }], { dryRun: false, signal, config });
      expect(fns(db.calls)).toEqual(['rag_apply_document_attributes', 'rag_import_document_attributes']);
    }
  });

  it('switch on without a template: one cached template read per tenant and no header write', async () => {
    const db = applyDb(null, { alpha_code: 'K-1' });
    useDb(db);
    await writeDocumentAttributes(db, TENANT_A, DOC_1, undefined, signal, { config: ON });
    await writeDocumentAttributes(db, TENANT_A, DOC_2, undefined, signal, { config: ON });
    await writeDocumentAttributes(db, TENANT_B, DOC_2, undefined, signal, { config: ON });
    expect(fns(db.calls)).toEqual([
      'rag_apply_document_attributes',
      'rag_attribute_header_template_for',
      'rag_apply_document_attributes',
      'rag_apply_document_attributes',
      'rag_attribute_header_template_for',
    ]);
  });

  it('a failed header write fails the stage with a code word, without the database message', async () => {
    const db = fakeDb({
      rag_apply_document_attributes: () => ok([{ document_id: DOC_1, origin: 'none', key_count: 0, chunks_updated: 0 }]),
      rag_attribute_header_template_for: () => ok([{ template: TEMPLATE, version: 1 }]),
      rag_document_attributes_read: () => ok([{ document_id: DOC_1, attributes: { alpha_code: 'K-1' } }]),
      rag_set_document_attribute_headers: () => ({ data: null, error: { code: 'XX000', message: `boom ${MARKER}` } }),
    });
    useDb(db);
    await expect(writeDocumentAttributes(db, TENANT_A, DOC_1, undefined, signal, { config: ON })).rejects.toMatchObject({ reason: 'attribute_header_failed' });
    expect(lines.join('\n')).not.toContain(MARKER);
  });

  it('renderPendingHeaders pages the pending listing and stops at the deadline with more', async () => {
    const pages: Row[][] = [
      Array.from({ length: 200 }, (_, index) => ({ document_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, attributes: { alpha_code: 'K' }, stamp: null })),
      [{ document_id: DOC_2, attributes: null, stamp: 't1.0123456789ab' }],
    ];
    const db = fakeDb({
      rag_attribute_header_template_for: () => ok([{ template: TEMPLATE, version: 2 }]),
      rag_attribute_header_pending: () => ok(pages.shift() ?? []),
      rag_set_document_attribute_headers: (args) => ok([{ updated: (args.p_rows as unknown[]).length, unchanged: 0 }]),
    });
    useDb(db);
    expect(await renderPendingHeaders(db, TENANT_A, { signal, deadlineMs: 20_000 })).toEqual({ ok: true, rendered: 201, more: false });
    const pendingCalls = db.calls.filter((call) => call.fn === 'rag_attribute_header_pending');
    expect(pendingCalls.map((call) => call.args.p_after)).toEqual([null, '00000000-0000-4000-8000-000000000199']);
    const writes = db.calls.filter((call) => call.fn === 'rag_set_document_attribute_headers').flatMap((call) => call.args.p_rows as Array<{ stamp: string }>);
    expect(writes.every((row) => /^t2\./.test(row.stamp))).toBe(true);

    const slow = fakeDb({
      rag_attribute_header_template_for: () => ok([{ template: TEMPLATE, version: 2 }]),
      rag_attribute_header_pending: () => {
        now += 30_000;
        return ok(Array.from({ length: 200 }, (_, index) => ({ document_id: `d-${index}`, attributes: null, stamp: null })));
      },
      rag_set_document_attribute_headers: (args) => ok([{ updated: (args.p_rows as unknown[]).length, unchanged: 0 }]),
    });
    useDb(slow);
    expect(await renderPendingHeaders(slow, TENANT_A, { signal, deadlineMs: 20_000 })).toEqual({ ok: true, rendered: 200, more: true });
  });

  it('without a template the pending documents are cleared', async () => {
    const db = fakeDb({
      rag_attribute_header_template_for: () => ok([]),
      rag_attribute_header_pending: () => ok([{ document_id: DOC_1, attributes: { alpha_code: 'K' }, stamp: 't1.0123456789ab' }]),
      rag_set_document_attribute_headers: () => ok([{ updated: 1, unchanged: 0 }]),
    });
    useDb(db);
    await renderPendingHeaders(db, TENANT_A, { signal, deadlineMs: 20_000 });
    expect(db.calls.at(-1)?.args.p_rows).toEqual([{ document_id: DOC_1, header: null, stamp: null }]);
  });
});
