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
import { buildEmbeddingText } from '@/lib/rag/ingest/text/embedding-text';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
import { lexicalTokens } from '@/lib/rag/lexical/tokenize';
import { buildProfileChunks, type ChunkingProfileRow } from '@/lib/rag/ingest/profile-chunks';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { enrichStage } from '@/lib/rag/ingest/stages/enrich';
import { deferredEmbedStage, embedStage } from '@/lib/rag/ingest/stages/embed-write';
import { emptyIngestState, type ChunkDraft, type StageContext } from '@/lib/rag/ingest/types';
import { createIngestWriter } from '@/lib/rag/ingest/writer';
import { mintScope } from '@/lib/rag/tenant/scope';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { resetActiveProfileForTests } from '@/lib/rag/embeddings/active-profile';
import { FAKE_DOCUMENT_ID, FAKE_LINEAGE_ID, fakeIngestDb, installIngestDeps, uninstallIngestDeps, unitVector, type RecordedRpc } from '../../helpers/ingest-fakes';

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

// --- Plan 03.3-17: the stored header in embedding text and lexical_text (D-26, D-27, D-05) -------------------------------------------------

const HEADER_MARKER = 'hdrmark-q7z';
const STORED_HEADER = `A K-${HEADER_MARKER} | B b1, b2`;
const STORED_STAMP = 't3.0123456789ab';

describe('buildEmbeddingText with an attribute header', () => {
  const inputs = [
    { section_path: [], content: 'Neutral body sentence one.' },
    { section_path: ['Part 1', 'Part 2'], content: 'Neutral body sentence two.' },
    { section_path: ['Part 1'], content: 'Neutral body sentence three.', template_header: 'Profile line' },
    { section_path: ['T'], content: '| c1 | c2 |\n| --- | --- |\n| v1 | v2 |', template_header: 'Profile line', table_row_separator: ', ' },
  ];

  it('absent or null equals today for every input', () => {
    for (const input of inputs) {
      const today = buildEmbeddingText(input);
      expect(buildEmbeddingText({ ...input, attribute_header: null })).toBe(today);
      expect(buildEmbeddingText({ ...input, attribute_header: undefined })).toBe(today);
    }
  });

  it('a string takes the place of the profile header on the same line; an empty string gives no header line', () => {
    for (const input of inputs) {
      const withHeader = buildEmbeddingText({ ...input, attribute_header: STORED_HEADER });
      expect(withHeader).toBe(buildEmbeddingText({ ...input, template_header: STORED_HEADER }));
      expect(withHeader).not.toContain('Profile line');
      expect(buildEmbeddingText({ ...input, attribute_header: '' })).toBe(buildEmbeddingText({ ...input, template_header: undefined }));
    }
  });
});

describe('chunkLexicalText with an attribute header', () => {
  const inputs = [
    { sectionPath: [], content: 'Neutral body sentence one.' },
    { sectionPath: ['Part 1', 'Part 2'], content: 'Neutral body sentence two.' },
    { sectionPath: ['Pics'], content: 'A caption of a shape.', chunkKind: 'image', metadata: { name: 'shape-name', image_context: 'near text' }, documentFilename: 'file.md' },
    { sectionPath: ['T'], content: '| c1 | c2 |\n| --- | --- |\n| v1 | v2 |', chunkKind: 'table', tableRowSeparator: ', ' },
  ];

  it('absent, null or empty equals today', () => {
    for (const input of inputs) {
      const today = chunkLexicalText(input);
      expect(chunkLexicalText({ ...input, attributeHeader: null })).toBe(today);
      expect(chunkLexicalText({ ...input, attributeHeader: undefined })).toBe(today);
      expect(chunkLexicalText({ ...input, attributeHeader: '' })).toBe(today);
    }
  });

  it('a header is one more part after the path prefix and before the body; extras and row lines keep their order', () => {
    for (const input of inputs) {
      const today = chunkLexicalText(input).split(' ').filter(Boolean);
      const pathCount = input.sectionPath.flatMap((part) => lexicalTokens(part)).length;
      const expected = [...today.slice(0, pathCount), ...lexicalTokens(STORED_HEADER), ...today.slice(pathCount)].join(' ');
      expect(chunkLexicalText({ ...input, attributeHeader: STORED_HEADER })).toBe(expected);
    }
  });
});

const PROFILE_ROW: ChunkingProfileRow = { id: 'p256', docType: 'general', childTokens: 256, parentMode: 'structure', parentTokens: 1024, status: 'building' };
const PROFILE_MARKDOWN = ['# Part 1', '', 'Neutral body sentence one about a shape.', '', '## Part 2', '', 'Neutral body sentence two about a colour.', ''].join('\n');

describe('buildProfileChunks with an attribute header', () => {
  const document = { filename: 'file.md', chunker: getProcessingProfile('general').chunker, templateHeader: 'Profile line' };

  it('without the field the result deep-equals today', () => {
    const today = buildProfileChunks(document, PROFILE_MARKDOWN, PROFILE_ROW);
    expect(buildProfileChunks({ ...document, attributeHeader: undefined }, PROFILE_MARKDOWN, PROFILE_ROW)).toEqual(today);
    for (const child of today.children) expect(Object.keys(child.metadata)).not.toContain('attribute_header_stamp');
  });

  it('with a stored header every child carries it in both texts and the stamp in its metadata; content is unchanged', () => {
    const today = buildProfileChunks(document, PROFILE_MARKDOWN, PROFILE_ROW);
    const built = buildProfileChunks({ ...document, attributeHeader: { header: STORED_HEADER, stamp: STORED_STAMP } }, PROFILE_MARKDOWN, PROFILE_ROW);
    expect(built.children.length).toBe(today.children.length);
    built.children.forEach((child, index) => {
      expect(child.content).toBe(today.children[index]?.content);
      expect(child.content).not.toContain(HEADER_MARKER);
      expect(child.metadata.attribute_header_stamp).toBe(STORED_STAMP);
      expect(child.lexical_text).toBe(
        chunkLexicalText({ sectionPath: child.section_path, content: child.content, chunkKind: child.chunk_kind, metadata: {}, documentFilename: 'file.md', attributeHeader: STORED_HEADER }),
      );
      expect(built.embeddingTexts[index]).toBe(buildEmbeddingText({ section_path: child.section_path, content: child.content, attribute_header: STORED_HEADER }));
      expect(built.embeddingTexts[index]).not.toContain('Profile line');
    });
    expect(built.parents).toEqual(today.parents);
  });

  it('null (switch on, no stamped header) keeps the texts and writes the clearing value', () => {
    const today = buildProfileChunks(document, PROFILE_MARKDOWN, PROFILE_ROW);
    const built = buildProfileChunks({ ...document, attributeHeader: null }, PROFILE_MARKDOWN, PROFILE_ROW);
    expect(built.embeddingTexts).toEqual(today.embeddingTexts);
    expect(built.children.map((child) => child.lexical_text)).toEqual(today.children.map((child) => child.lexical_text));
    for (const child of built.children) expect(child.metadata.attribute_header_stamp).toBe('none');
  });
});

const HEADER_ENV = { RAG_INGEST_PIPELINE: 'unified', RAG_DOC_ATTRIBUTES: 'true', RAG_ATTRIBUTE_HEADER: 'true' };
const OFF_ENV = { RAG_INGEST_PIPELINE: 'unified', RAG_DOC_ATTRIBUTES: 'true' };
const INVOICE_ROW = { invoice_number: 'N-7', supplier_name: 'Party Q', supplier_tax_id: null };
const STAGE_TENANT = 's:default';

function headerAnswer(found: boolean) {
  return (args: Record<string, unknown>): Row[] => {
    if (!found || args.p_tenant_key !== STAGE_TENANT) return [];
    return ((args.p_document_ids as string[] | undefined) ?? []).map((id) => ({ document_id: id, chunk_id: null, header: STORED_HEADER, stamp: STORED_STAMP }));
  };
}

function drafts(): ChunkDraft[] {
  return [
    { content: 'Neutral body sentence one about a shape.', section_path: ['Part 1'], chunk_kind: 'text', page_start: null, page_end: null, metadata: {} },
    { content: 'Neutral body sentence two about a colour.', section_path: ['Part 1', 'Part 2'], chunk_kind: 'text', page_start: null, page_end: null, metadata: {} },
  ];
}

interface StageRun {
  calls: RecordedRpc[];
  embedded: string[];
  ctx: StageContext;
}

async function runStages(options: {
  env: Record<string, string>;
  found?: boolean;
  docType?: 'general' | 'invoice_receipt';
  pipeline?: string;
  deferred?: boolean;
}): Promise<StageRun> {
  setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: options.pipeline }) });
  resetActiveProfileForTests();
  const docType = options.docType ?? 'invoice_receipt';
  const { db, calls } = fakeIngestDb({
    chunkingProfiles: [{ ...PROFILE_ROW, id: 'p256', doc_type: docType, child_tokens: 256, parent_mode: 'structure', parent_tokens: 1024, status: 'building' }],
    answers: { rag_attribute_headers: headerAnswer(options.found ?? true) },
  });
  const embedded: string[] = [];
  installIngestDeps({ db, env: options.env, embedDocuments: async (texts) => (embedded.push(...texts), texts.map(() => unitVector())) });
  const scope = mintScope('single', null, null);
  const signal = new AbortController().signal;
  const ctx: StageContext = {
    input: { scope, source: 'config_upload', sourceKey: 'root/file.md', text: PROFILE_MARKDOWN, filename: 'file.md', mimeType: 'text/markdown', signal },
    deps: (await import('@/lib/rag/ingest/deps')).getIngestDeps(),
    writer: createIngestWriter({ db, scope, signal }),
    config: loadIngestConfig(options.env),
    signal,
    deadline: Date.now() + 60_000,
    state: emptyIngestState(),
    warnings: [],
    identity: {
      tenantKey: STAGE_TENANT,
      filename: 'file.md',
      fileSha256: 'a'.repeat(64),
      docType,
      docTypeOrigin: 'picked',
      profile: getProcessingProfile(docType),
      bytes: null,
    },
    document: { id: FAKE_DOCUMENT_ID, version: 1, lineageId: FAKE_LINEAGE_ID, resumed: false },
    parserUsed: null,
    work: { parseText: PROFILE_MARKDOWN, parserVersion: null, chunks: drafts(), chunksWritten: 0, templateRow: INVOICE_ROW },
  };
  await enrichStage.run(ctx);
  await (options.deferred ? deferredEmbedStage : embedStage).run(ctx);
  return { calls, embedded, ctx };
}

const headerReads = (calls: RecordedRpc[]) => calls.filter((call) => call.fn === 'rag_attribute_headers');
const writtenChunks = (calls: RecordedRpc[]) => calls.filter((call) => call.fn === 'rag_write_chunks').flatMap((call) => call.args.p_chunks as Row[]);
const writtenChildren = (calls: RecordedRpc[]) => calls.filter((call) => call.fn === 'rag_write_profile_chunks').flatMap((call) => call.args.p_children as Row[]);

describe('inline ingest stages with the stored header (enrich, runEmbed, runDeferredEmbed)', () => {
  afterEach(() => {
    uninstallIngestDeps();
    resetRagDepsForTests();
    resetActiveProfileForTests();
  });

  it('switch on, header stored: one read per stage call, header in lexical_text and the embedding inputs, never in content; stamp on every chunk', async () => {
    const run = await runStages({ env: HEADER_ENV, pipeline: 'v2' });
    const reads = headerReads(run.calls);
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(read.args).toEqual({ p_tenant_key: STAGE_TENANT, p_document_ids: [FAKE_DOCUMENT_ID] });
    const chunks = writtenChunks(run.calls);
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(String(chunk.lexical_text)).toContain(lexicalTokens(HEADER_MARKER)[0]);
      expect(String(chunk.content)).not.toContain(HEADER_MARKER);
      expect((chunk.metadata as Row).attribute_header_stamp).toBe(STORED_STAMP);
    }
    const legacyTexts = run.embedded.slice(0, 2);
    legacyTexts.forEach((text, index) => {
      expect(text).toBe(buildEmbeddingText({ section_path: drafts()[index]!.section_path, content: drafts()[index]!.content, attribute_header: STORED_HEADER }));
      expect(text).not.toContain('Invoice N-7');
    });
    const children = writtenChildren(run.calls);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect((child.metadata as Row).attribute_header_stamp).toBe(STORED_STAMP);
      expect(String(child.lexical_text)).toContain(lexicalTokens(HEADER_MARKER)[0]);
      expect(String(child.content)).not.toContain(HEADER_MARKER);
    }
    expect(run.embedded.slice(2).every((text) => text.includes(STORED_HEADER) && !text.includes('Invoice N-7'))).toBe(true);
    expect(lines.join('\n')).not.toContain(HEADER_MARKER);
  });

  it('switch on, tenant without a template: texts equal the switch-off run and metadata carries the clearing value', async () => {
    const off = await runStages({ env: OFF_ENV, pipeline: 'v2' });
    uninstallIngestDeps();
    const bare = await runStages({ env: HEADER_ENV, found: false, pipeline: 'v2' });
    expect(bare.embedded).toEqual(off.embedded);
    expect(writtenChunks(bare.calls).map((chunk) => chunk.lexical_text)).toEqual(writtenChunks(off.calls).map((chunk) => chunk.lexical_text));
    for (const chunk of writtenChunks(bare.calls)) expect((chunk.metadata as Row).attribute_header_stamp).toBe('none');
    for (const child of writtenChildren(bare.calls)) expect((child.metadata as Row).attribute_header_stamp).toBe('none');
  });

  it('switch off: no header read, and texts and metadata carry no new key', async () => {
    for (const env of [OFF_ENV, {}]) {
      const run = await runStages({ env, pipeline: 'v2' });
      expect(headerReads(run.calls)).toHaveLength(0);
      for (const chunk of [...writtenChunks(run.calls), ...writtenChildren(run.calls)]) expect(Object.keys(chunk.metadata as Row)).not.toContain('attribute_header_stamp');
      expect(run.embedded.slice(0, 2)[0]).toContain('Invoice N-7');
      uninstallIngestDeps();
    }
  });

  it('deferred embed: one read for the dual write, children carry the header and the stamp', async () => {
    const run = await runStages({ env: HEADER_ENV, pipeline: 'v2', deferred: true });
    expect(headerReads(run.calls)).toHaveLength(2);
    const children = writtenChildren(run.calls);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) expect((child.metadata as Row).attribute_header_stamp).toBe(STORED_STAMP);
    expect(run.embedded.every((text) => text.includes(STORED_HEADER))).toBe(true);
  });
});

// --- Plan 03.3-17 Task 3: sites that rewrite the text of stored chunks follow the in-step rule ------------------------------------------------

const CHUNK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CHUNK_A_OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const CHUNK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const MARK_A = 'hdra-x1';
const MARK_B = 'hdrb-x2';

/** The chunk-mode read: a header only for the chunks that are in step with their document, and only for the tenant named in the call. */
function chunkHeaderAnswer(args: Row): RpcResponse {
  const ids = (args.p_chunk_ids as string[] | undefined) ?? [];
  const inStep: Record<string, { tenant: string; header: string }> = {
    [CHUNK_A]: { tenant: TENANT_A, header: `${MARK_A} K-1` },
    [CHUNK_B]: { tenant: TENANT_B, header: `${MARK_B} K-2` },
  };
  return ok(
    ids.flatMap((id) => {
      const entry = inStep[id];
      return entry && entry.tenant === args.p_tenant_key ? [{ document_id: DOC_1, chunk_id: id, header: entry.header, stamp: 't1.0123456789ab' }] : [];
    }),
  );
}

describe('embeddingTextOf with the in-step header', () => {
  it('without the third argument the text equals today; with a string it replaces the profile header', async () => {
    const { embeddingTextOf } = await import('@/lib/rag/ingest/reembed/run');
    const chunk = {
      id: CHUNK_A,
      documentId: DOC_1,
      tenantKey: TENANT_A,
      content: 'Neutral body sentence one.',
      sectionPath: ['Part 1'],
      chunkKind: 'text',
      docType: 'invoice_receipt',
      templateRow: INVOICE_ROW,
      hasGap: false,
    };
    const today = embeddingTextOf(chunk, new Set());
    expect(today).toContain('Invoice N-7');
    expect(embeddingTextOf(chunk, new Set(), undefined)).toBe(today);
    expect(embeddingTextOf(chunk, new Set(), null)).toBe(today);
    expect(embeddingTextOf(chunk, new Set(), `${MARK_A} K-1`)).toBe(buildEmbeddingText({ section_path: ['Part 1'], content: chunk.content, attribute_header: `${MARK_A} K-1` }));
  });
});

describe('deferred backfill embeddings with the in-step header', () => {
  const deferredRows = [
    { id: CHUNK_A, document_id: DOC_1, tenant_key: TENANT_A, embedding_text_version: 1, content: 'Neutral body one.', section_path: ['P'], chunk_kind: 'text', doc_type: 'general', template_row: {} },
    { id: CHUNK_A_OLD, document_id: DOC_1, tenant_key: TENANT_A, embedding_text_version: 1, content: 'Neutral body two.', section_path: ['P'], chunk_kind: 'text', doc_type: 'general', template_row: {} },
    { id: CHUNK_B, document_id: DOC_2, tenant_key: TENANT_B, embedding_text_version: 1, content: 'Neutral body three.', section_path: ['P'], chunk_kind: 'text', doc_type: 'general', template_row: {} },
  ];

  async function groups(env: Record<string, string>): Promise<{ texts: Map<string, string>; db: ReturnType<typeof fakeDb> }> {
    const { deferredGroups } = await import('@/lib/rag/ingest/backfill/orchestrate');
    let served = false;
    const db = fakeDb({
      rag_deferred_embed_chunks: () => {
        const page = served ? [] : deferredRows;
        served = true;
        return ok(page);
      },
      rag_attribute_headers: chunkHeaderAnswer,
    });
    setIngestDepsForTests({ db: () => db, ingestEnv: () => env });
    const texts = new Map<string, string>();
    for await (const group of deferredGroups(db, 'batch-1', 'openai-3-small-1536', signal)) for (const chunk of group) texts.set(chunk.chunkId, chunk.text);
    return { texts, db };
  }

  it('switch on: one read per tenant of the page; a chunk in step gets its own header, the others today', async () => {
    const { texts, db } = await groups(HEADER_ENV);
    const reads = db.calls.filter((call) => call.fn === 'rag_attribute_headers');
    expect(reads.map((call) => call.args.p_tenant_key).sort()).toEqual([TENANT_A, TENANT_B].sort());
    expect(texts.get(CHUNK_A)).toBe(buildEmbeddingText({ section_path: ['P'], content: 'Neutral body one.', attribute_header: `${MARK_A} K-1` }));
    expect(texts.get(CHUNK_A_OLD)).toBe(buildEmbeddingText({ section_path: ['P'], content: 'Neutral body two.' }));
    expect(texts.get(CHUNK_B)).toContain(MARK_B);
    expect(texts.get(CHUNK_B)).not.toContain(MARK_A);
  });

  it('switch off: no read and the texts of today', async () => {
    const { texts, db } = await groups(OFF_ENV);
    expect(db.calls.filter((call) => call.fn === 'rag_attribute_headers')).toHaveLength(0);
    for (const row of deferredRows) expect(texts.get(row.id)).toBe(buildEmbeddingText({ section_path: ['P'], content: row.content }));
  });
});

describe('recaption with the in-step header', () => {
  const saved = { supported: process.env.RAG_SUPPORTED_LANGUAGES, primary: process.env.RAG_PRIMARY_LANGUAGE };

  beforeEach(async () => {
    process.env.RAG_SUPPORTED_LANGUAGES = 'en,it';
    process.env.RAG_PRIMARY_LANGUAGE = 'en';
    (await import('@/lib/rag/lang/settings')).resetLanguageSettingsForTests();
  });

  afterEach(async () => {
    for (const [key, value] of [['RAG_SUPPORTED_LANGUAGES', saved.supported], ['RAG_PRIMARY_LANGUAGE', saved.primary]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    (await import('@/lib/rag/lang/settings')).resetLanguageSettingsForTests();
  });

  const candidate = (id: string, tenant: string) => ({
    id,
    document_id: DOC_1,
    tenant_key: tenant,
    content: 'A blue square beside two white dots on a card.',
    language: 'en',
    document_language: 'it',
    picture_document: false,
    image_url: `https://project.example.test/storage/v1/object/public/chat-images/rag/${id}.png`,
    image_type: 'image/png',
    section_path: ['Pics'],
    doc_type: 'general',
    template_row: {},
    profiles: [{ id: 'openai-3-small-1536', provider: 'openai', model: 'text-embedding-3-small', dims: 4 }],
  });

  async function run(env: Record<string, string>) {
    const { runRecaption, dryRunRecaption } = await import('@/lib/rag/ingest/reembed/recaption');
    let pages = 0;
    const db = fakeDb({
      rag_recaption_start_run: () => ok([{ run_id: 'run-1', tenant_key: null, cursor_chunk_id: null, status: 'running' }]),
      rag_recaption_candidates: () => ok(pages++ % 2 === 0 ? [candidate(CHUNK_A, TENANT_A), candidate(CHUNK_A_OLD, TENANT_A), candidate(CHUNK_B, TENANT_B)] : []),
      rag_attribute_headers: chunkHeaderAnswer,
    });
    setIngestDepsForTests({ db: () => db, ingestEnv: () => ({ ...env, RAG_CAPTION_LANGUAGE: 'document' }) });
    const embedded = new Map<string, string>();
    let current = '';
    const report = await runRecaption({
      db,
      signal,
      deps: {
        fetchImage: async (url) => ((current = url), { bytes: new Uint8Array([1]), mimeType: 'image/png' }),
        caption: async () => 'Un quadrato blu accanto a due punti bianchi.',
        embed: async (_profile, texts) => (embedded.set(current, texts[0] ?? ''), texts.map(() => [1, 0, 0, 0])),
      },
    });
    await dryRunRecaption({ db, signal });
    return { report, db, embedded, writes: db.calls.filter((call) => call.fn === 'rag_recaption_write_chunk') };
  }

  it('switch on: a chunk in step gets its own header in the embedded text and in its rewritten lexical text; the others today', async () => {
    const { report, db, embedded, writes } = await run(HEADER_ENV);
    expect(report.recaptioned).toBe(3);
    const urlOf = (id: string) => candidate(id, TENANT_A).image_url;
    expect(embedded.get(urlOf(CHUNK_A))).toContain(`${MARK_A} K-1`);
    expect(embedded.get(urlOf(CHUNK_A_OLD))).not.toContain(MARK_A);
    expect(embedded.get(urlOf(CHUNK_B))).toContain(MARK_B);
    expect(embedded.get(urlOf(CHUNK_B))).not.toContain(MARK_A);
    const lexicalOf = (id: string) => String(writes.find((call) => call.args.p_chunk_id === id)?.args.p_lexical_text);
    expect(lexicalOf(CHUNK_A)).toContain(lexicalTokens(MARK_A)[0]);
    expect(lexicalOf(CHUNK_A_OLD)).not.toContain(lexicalTokens(MARK_A)[0]);
    for (const call of writes) expect(String(call.args.p_content)).not.toContain('hdr');
    const reads = db.calls.filter((call) => call.fn === 'rag_attribute_headers');
    expect(reads.length).toBe(4);
    expect(new Set(reads.map((call) => call.args.p_tenant_key))).toEqual(new Set([TENANT_A, TENANT_B]));
  });

  it('switch off: no header read', async () => {
    const { db, embedded } = await run(OFF_ENV);
    expect(db.calls.filter((call) => call.fn === 'rag_attribute_headers')).toHaveLength(0);
    for (const text of embedded.values()) expect(text).not.toContain('hdr');
  });
});
