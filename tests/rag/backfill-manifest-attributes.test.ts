import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceItem } from '@/lib/rag/ingest/backfill/sources';

/**
 * TPL-03 (D-23, F-11): manifest rows of rag:backfill carry attribute values. listManifest puts them on the source item (a row that breaks
 * the contract is skipped as manifest_schema); enqueueRun checks them against the batch tenant's schema and stages them under the backfill
 * source and the entry's source key through rag_stage_document_attributes before rag_enqueue_backfill_jobs. Refused entries are counted,
 * never enqueued. MARKER is a value that must never reach a log line.
 */

const MARKER = 'marker-value-b4k';
const BATCH = '00000000-0000-4000-8000-0000000012b1';
const ORG = '00000000-0000-4000-8000-0000000012c1';
const OWNER = '00000000-0000-4000-8000-0000000012a1';
const TENANT = `o:${ORG}`;
const DEFINITIONS = [
  { key: 'alpha_code', type: 'code', filterable: false, in_header: false, in_identifier_index: false, soft: false },
  { key: 'beta_list', type: 'text_list', filterable: false, in_header: false, in_identifier_index: false, soft: false },
];

type Row = Record<string, unknown>;
type Call = { fn: string; args: Row };

let lines: string[] = [];
let dir = '';

beforeEach(async () => {
  lines = [];
  const capture = (...args: unknown[]) => void lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation(capture);
  dir = await mkdtemp(path.join(os.tmpdir(), 'manifest-attributes-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(dir, { recursive: true, force: true });
});

describe('listManifest: attributes on a manifest row', () => {
  it('a row with attributes yields them on its source item; a row whose attributes break the contract is skipped as manifest_schema', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'neutral one');
    await writeFile(path.join(dir, 'b.txt'), 'neutral two');
    await writeFile(path.join(dir, 'c.txt'), 'neutral three');
    const manifest = path.join(dir, 'manifest.jsonl');
    await writeFile(
      manifest,
      [
        { source_key: 'k/a', path: 'a.txt', attributes: { alpha_code: 'A-1', beta_list: ['x'] } },
        { source_key: 'k/b', path: 'b.txt', attributes: { alpha_code: '' } },
        { source_key: 'k/c', path: 'c.txt' },
        { source_key: 'k/d', path: 'c.txt', attributes: { 'Bad Key': 'x' } },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    const { listSource } = await import('@/lib/rag/ingest/backfill/sources');
    const reasons: string[] = [];
    const items: SourceItem[] = [];
    for await (const item of listSource({ kind: 'manifest', ref: manifest, root: dir, deps: { onReject: (reason) => reasons.push(reason) } })) items.push(item);
    expect(items.map((item) => [item.sourceKey, item.attributes])).toEqual([
      ['k/a', { alpha_code: 'A-1', beta_list: ['x'] }],
      ['k/c', undefined],
    ]);
    expect(items[1]).not.toHaveProperty('attributes');
    expect(reasons).toEqual(['manifest_schema', 'manifest_schema']);
  });
});

describe('enqueueRun: manifest attributes are checked and staged before the jobs are enqueued', () => {
  interface RunOptions {
    env?: Record<string, string>;
    definitionsFail?: boolean;
    stageFails?: { code: string; message: string };
    enqueueFails?: boolean;
    kind?: 'ingest' | 'dry_run';
  }

  function entry(sourceKey: string, text: string, attributes?: Record<string, string | string[]>) {
    const bytes = Buffer.from(text);
    return {
      sourceKey,
      fileSha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
      ext: '.txt',
      filename: `${sourceKey.replace(/\W+/g, '-')}.txt`,
      mimeType: 'text/plain',
      docType: null,
      ...(attributes !== undefined ? { attributes } : {}),
      open: async () => Readable.from([bytes]),
    };
  }

  async function run(entries: ReturnType<typeof entry>[], options: RunOptions = {}) {
    vi.resetModules();
    const fakes = await import('../helpers/ingest-fakes');
    const failures: Record<string, { code: string; message: string }> = {};
    if (options.definitionsFail) failures.rag_attribute_definitions_for = { code: 'XX000', message: `boom ${MARKER}` };
    if (options.stageFails) failures.rag_stage_document_attributes = options.stageFails;
    if (options.enqueueFails) failures.rag_enqueue_backfill_jobs = { code: 'XX000', message: 'enqueue failed' };
    const { db, calls } = fakes.fakeIngestDb({
      failures,
      answers: {
        rag_update_ingestion_batch: () => [{ tenant_key: TENANT, spent_usd: 0, dry_run_report: {} }],
        rag_list_batch_jobs: () => [],
        rag_enqueue_backfill_jobs: (args) => [{ n: (args.p_jobs as unknown[]).length }],
        rag_attribute_definitions_for: (args) => (args.p_tenant_key === TENANT ? DEFINITIONS : []),
        rag_stage_document_attributes: (args) => [{ staged: (args.p_rows as unknown[]).length, unchanged: 0 }],
      },
    });
    fakes.installIngestDeps({ db, env: { RAG_INGEST_PIPELINE: 'unified', ...(options.env ?? { RAG_DOC_ATTRIBUTES: 'true' }) } });
    try {
      const { mintScope } = await import('@/lib/rag/tenant/scope');
      const { enqueueRun } = await import('@/lib/rag/ingest/backfill/run');
      const batch = { id: BATCH, scope: mintScope('org', OWNER, ORG) };
      const result = await enqueueRun(batch, entries, { rpc: db, signal: new AbortController().signal, kind: options.kind ?? 'ingest' }).catch(
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      );
      return { result, calls: calls as Call[] };
    } finally {
      fakes.uninstallIngestDeps();
    }
  }

  const fns = (calls: Call[]) => calls.map((call) => call.fn);
  const enqueuedKeys = (calls: Call[]) =>
    calls.filter((call) => call.fn === 'rag_enqueue_backfill_jobs').flatMap((call) => (call.args.p_jobs as Row[]).map((job) => job.source_key));

  it('accepted entries are staged under the backfill source and their source key, before the enqueue call', async () => {
    const { result, calls } = await run([entry('k/a', 'neutral a', { beta_list: [' x ', 'y'], alpha_code: 'A-1' }), entry('k/b', 'neutral b')]);
    expect(result).toMatchObject({ enqueued: 2, refused: {} });
    const stage = calls.filter((call) => call.fn === 'rag_stage_document_attributes');
    expect(stage.map((call) => call.args)).toEqual([
      { p_tenant_key: TENANT, p_rows: [{ source: 'config_upload', source_key: 'k/a', attributes: { alpha_code: 'A-1', beta_list: ['x', 'y'] } }] },
    ]);
    expect(fns(calls).indexOf('rag_stage_document_attributes')).toBeLessThan(fns(calls).indexOf('rag_enqueue_backfill_jobs'));
    expect(enqueuedKeys(calls)).toEqual(['k/a', 'k/b']);
    const jobs = calls.filter((call) => call.fn === 'rag_enqueue_backfill_jobs').flatMap((call) => call.args.p_jobs as Row[]);
    expect(JSON.stringify(jobs)).not.toContain('A-1');
    expect(calls.filter((call) => call.fn === 'rag_attribute_definitions_for').map((call) => call.args)).toEqual([{ p_tenant_key: TENANT }]);
  });

  it('values that fail the schema are refused attributes_invalid and that entry is not enqueued', async () => {
    const { result, calls } = await run([entry('k/a', 'neutral a', { delta_text: MARKER }), entry('k/b', 'neutral b', { alpha_code: 'B-1' })]);
    expect(result).toMatchObject({ enqueued: 1, refused: { attributes_invalid: 1 } });
    expect(enqueuedKeys(calls)).toEqual(['k/b']);
    expect(lines.join('\n')).not.toContain(MARKER);
  });

  it('with the switch off an entry with attributes is refused attributes_not_enabled; with an unreadable schema attributes_unavailable', async () => {
    const off = await run([entry('k/a', 'neutral a', { alpha_code: 'A-1' }), entry('k/b', 'neutral b')], { env: {} });
    expect(off.result).toMatchObject({ enqueued: 1, refused: { attributes_not_enabled: 1 } });
    expect(fns(off.calls)).not.toContain('rag_stage_document_attributes');
    expect(fns(off.calls)).not.toContain('rag_attribute_definitions_for');
    const broken = await run([entry('k/a', 'neutral a', { alpha_code: MARKER })], { definitionsFail: true });
    expect(broken.result).toMatchObject({ enqueued: 0, refused: { attributes_unavailable: 1 } });
    expect(enqueuedKeys(broken.calls)).toEqual([]);
    expect(lines.join('\n')).not.toContain(MARKER);
  });

  it('a staging refusal keeps every entry with values out of the queue', async () => {
    const { result, calls } = await run([entry('k/a', 'neutral a', { alpha_code: 'A-1' }), entry('k/b', 'neutral b')], {
      stageFails: { code: '22023', message: 'unknown_attribute' },
    });
    expect(result).toMatchObject({ enqueued: 1, refused: { attributes_invalid: 1 } });
    expect(enqueuedKeys(calls)).toEqual(['k/b']);
  });

  it('a dry run never checks or stages', async () => {
    const { calls } = await run([entry('k/a', 'neutral a', { delta_text: 'x' })], { kind: 'dry_run' });
    expect(fns(calls)).not.toContain('rag_stage_document_attributes');
    expect(fns(calls)).not.toContain('rag_attribute_definitions_for');
    expect(enqueuedKeys(calls)).toEqual(['k/a']);
  });

  it('a manifest without attributes: the RPC call list equals that of today (switch on or off)', async () => {
    const plainOn = await run([entry('k/a', 'neutral a'), entry('k/b', 'neutral b')]);
    const plainOff = await run([entry('k/a', 'neutral a'), entry('k/b', 'neutral b')], { env: {} });
    expect(fns(plainOn.calls)).toEqual(fns(plainOff.calls));
    expect(fns(plainOn.calls)).not.toContain('rag_stage_document_attributes');
    expect(fns(plainOn.calls)).not.toContain('rag_attribute_definitions_for');
  });

  it('a run that failed after staging can be run again: the same values are staged again without an error', async () => {
    const entries = [entry('k/a', 'neutral a', { alpha_code: 'A-1' })];
    const failed = await run(entries, { enqueueFails: true });
    expect(failed.result).toHaveProperty('error');
    const again = await run(entries);
    expect(again.result).toMatchObject({ enqueued: 1, refused: {} });
    const staged = (calls: Call[]) => calls.filter((call) => call.fn === 'rag_stage_document_attributes').map((call) => call.args);
    expect(staged(again.calls)).toEqual(staged(failed.calls));
  });
});
