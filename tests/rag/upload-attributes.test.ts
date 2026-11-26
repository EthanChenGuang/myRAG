import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { IngestInput } from '@/lib/rag/ingest';

/**
 * TPL-03 (D-22, D-23): attribute values on the write paths. The pipeline applies a begun version's values (explicit, staged or inherited)
 * through rag_apply_document_attributes after begin and before the first chunk write; the chunk copy trigger of 1005 puts them on every
 * chunk (proven against the database in tests/rag-db/document-attributes.test.mts). With RAG_DOC_ATTRIBUTES effectively off nothing new
 * is called, and attributes that still arrive are rejected with attributes_not_enabled, never ignored. Keys and values are neutral
 * synthetic strings; MARKER is a value that must never reach a log line, the job settings snapshot or the document metadata.
 */

const MARKER = 'marker-value-q7z';
const DOCUMENT = '11111111-1111-4111-8111-111111111111';
const MARKDOWN = ['# Neutral handbook', '', 'The first neutral paragraph describes a placeholder process.', '', 'The second neutral paragraph closes it.', ''].join('\n');
const ON = { RAG_INGEST_PIPELINE: 'unified', RAG_DOC_ATTRIBUTES: 'true' };

type Row = Record<string, unknown>;
type Call = { fn: string; args: Row };

let lines: string[] = [];

beforeEach(() => {
  lines = [];
  const capture = (...args: unknown[]) => void lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const order = (calls: Call[]) => calls.map((call) => call.fn);
const applies = (calls: Call[]) => calls.filter((call) => call.fn === 'rag_apply_document_attributes');

async function runIngest(
  env: Record<string, string>,
  extra: Partial<IngestInput>,
  options: { enqueue?: 'stages' | 'full'; failures?: Record<string, { code: string; message: string }>; mode?: 'single' | 'org' } = {},
) {
  vi.resetModules();
  const fakes = await import('../helpers/ingest-fakes');
  const { mintScope } = await import('@/lib/rag/tenant/scope');
  const { db, calls } = fakes.fakeIngestDb(options.failures ? { failures: options.failures } : {});
  const store = fakes.installIngestDeps({ db, env });
  const scope =
    options.mode === 'org'
      ? mintScope('org', '00000000-0000-4000-8000-0000000011a1', '00000000-0000-4000-8000-0000000011c1')
      : mintScope('single', null, null);
  const input = {
    scope,
    source: 'config_upload' as const,
    sourceKey: 'root/neutral.md',
    text: MARKDOWN,
    filename: 'neutral.md',
    mimeType: 'text/markdown',
    signal: new AbortController().signal,
    ...extra,
  } as IngestInput;
  try {
    if (options.enqueue === 'stages') {
      const { enqueueStageContext, runEnqueueStages, queuedInputRecordOf } = await import('@/lib/rag/ingest/enqueue');
      const ctx = enqueueStageContext(input, (await import('@/lib/rag/ingest/deps')).getIngestDeps(), db);
      const result = await runEnqueueStages(ctx);
      return { calls, result, record: queuedInputRecordOf(input, ctx), store };
    }
    if (options.enqueue === 'full') {
      const { enqueueIngest } = await import('@/lib/rag/ingest/enqueue');
      return { calls, result: await enqueueIngest(input), record: null, store };
    }
    const { ingest } = await import('@/lib/rag/ingest');
    return { calls, result: await ingest(input), record: null, store };
  } finally {
    fakes.uninstallIngestDeps();
  }
}

describe('the ingest pipeline applies attribute values before any chunk is written', () => {
  it('inline, switch on: rag_apply_document_attributes runs once with the run tenant, after the scope-tag call and before the first chunk write', async () => {
    const { calls, result } = await runIngest({ ...ON, RAG_SCOPE_TAGS: 'true' }, { attributes: { alpha_code: 'K-1' }, scopes: ['region:a1'] });
    expect(result.status).toBe('ready');
    const fns = order(calls);
    expect(applies(calls)).toHaveLength(1);
    expect(applies(calls)[0]?.args).toEqual({ p_tenant_key: 's:default', p_document_id: DOCUMENT, p_explicit: { alpha_code: 'K-1' } });
    expect(fns.indexOf('rag_begin_document_version')).toBeLessThan(fns.indexOf('rag_set_upload_scopes'));
    expect(fns.indexOf('rag_set_upload_scopes')).toBeLessThan(fns.indexOf('rag_apply_document_attributes'));
    expect(fns.indexOf('rag_apply_document_attributes')).toBeLessThan(fns.indexOf('rag_write_chunks'));
  });

  it('inline, switch on, no attributes on the request: the apply still runs (staged and inherited values) with no explicit values', async () => {
    const { calls } = await runIngest(ON, {});
    expect(applies(calls).map((call) => call.args)).toEqual([{ p_tenant_key: 's:default', p_document_id: DOCUMENT, p_explicit: null }]);
  });

  it('an organization run uses the organization tenant key', async () => {
    const { calls } = await runIngest(ON, { attributes: { alpha_code: 'K-2' } }, { mode: 'org' });
    expect(applies(calls).map((call) => call.args.p_tenant_key)).toEqual(['o:00000000-0000-4000-8000-0000000011c1']);
  });

  it('switch off: no new RPC is called and the call list equals that of the same run today', async () => {
    const off = await runIngest({ RAG_INGEST_PIPELINE: 'unified' }, {});
    expect(order(off.calls)).not.toContain('rag_apply_document_attributes');
    const legacy = await runIngest({ RAG_INGEST_PIPELINE: 'legacy', RAG_DOC_ATTRIBUTES: 'true' }, {});
    expect(order(legacy.calls)).not.toContain('rag_apply_document_attributes');
    expect(order(legacy.calls)).toEqual(order(off.calls));
    const on = await runIngest(ON, {});
    expect(order(on.calls).filter((fn) => fn !== 'rag_apply_document_attributes')).toEqual(order(off.calls));
  });

  it('switch off with attributes still on the input: the run fails with attributes_not_enabled before any chunk is written', async () => {
    const { calls, result } = await runIngest({ RAG_INGEST_PIPELINE: 'unified' }, { attributes: { alpha_code: MARKER } });
    expect(result.status).toBe('failed');
    expect((result as { reason?: string }).reason).toBe('attributes_not_enabled');
    expect(order(calls)).not.toContain('rag_write_chunks');
    expect(order(calls)).not.toContain('rag_apply_document_attributes');
  });

  it('a database refusal fails the run with the SQL code word; an unknown error becomes attribute_write_failed without its message', async () => {
    const refused = await runIngest(ON, { attributes: { alpha_code: 'K-3' } }, {
      failures: { rag_apply_document_attributes: { code: '22023', message: 'unknown_attribute' } },
    });
    expect(refused.result.status).toBe('failed');
    expect((refused.result as { reason?: string }).reason).toBe('unknown_attribute');
    expect(order(refused.calls)).not.toContain('rag_write_chunks');
    const broken = await runIngest(ON, { attributes: { alpha_code: 'K-4' } }, {
      failures: { rag_apply_document_attributes: { code: 'XX000', message: `connection reset ${MARKER}` } },
    });
    expect((broken.result as { reason?: string }).reason).toBe('attribute_write_failed');
    expect(order(broken.calls)).not.toContain('rag_write_chunks');
    expect(lines.join('\n')).not.toContain(MARKER);
  });

  it('queued: the enqueue stages apply at enqueue and the queued-input record carries the explicit values; without them it is unchanged', async () => {
    const { calls, record } = await runIngest(ON, { attributes: { beta_list: ['b1', 'b2'] } }, { enqueue: 'stages' });
    expect(applies(calls).map((call) => call.args.p_explicit)).toEqual([{ beta_list: ['b1', 'b2'] }]);
    expect(order(calls)).not.toContain('rag_write_chunks');
    expect(record?.attributes).toEqual({ beta_list: ['b1', 'b2'] });
    const plain = await runIngest(ON, {}, { enqueue: 'stages' });
    expect(plain.record).not.toHaveProperty('attributes');
    const empty = await runIngest(ON, { attributes: {} }, { enqueue: 'stages' });
    expect(empty.record?.attributes).toEqual({});
  });

  it('the queued-input record round-trips the values, an old record still decodes, and the context puts them on the input', async () => {
    const { decodeQueuedInput, encodeQueuedInput } = await import('@/lib/rag/ingest/queued-context');
    const base = { v: 1 as const, source: 'config_upload' as const, sourceKey: 'k', filename: 'f.md', mimeType: 'text/markdown', kind: 'text' as const, state: {} };
    expect(new TextDecoder().decode(encodeQueuedInput(base))).toBe(JSON.stringify(base));
    expect(decodeQueuedInput(encodeQueuedInput(base))).not.toHaveProperty('attributes');
    const withValues = { ...base, attributes: { alpha_code: 'K-5', beta_list: ['x'] } };
    expect(decodeQueuedInput(encodeQueuedInput(withValues))?.attributes).toEqual({ alpha_code: 'K-5', beta_list: ['x'] });
    const tooMany = { ...base, attributes: { beta_list: Array.from({ length: 51 }, (_, i) => `v${i}`) } };
    expect(decodeQueuedInput(encodeQueuedInput(tooMany))).toBeNull();
    const source = await import('node:fs').then((fs) => fs.readFileSync('src/lib/rag/ingest/queued-context.ts', 'utf8'));
    expect(source).toMatch(/record\.attributes !== undefined \? \{ attributes: record\.attributes \}/);
  });

  it('values never reach the job settings snapshot, the caller document metadata or a log line', async () => {
    const options = { owner: 'neutral' };
    const marked = await runIngest(ON, { attributes: { alpha_code: MARKER }, options } as Partial<IngestInput>, { enqueue: 'full' });
    const plain = await runIngest(ON, { options } as Partial<IngestInput>, { enqueue: 'full' });
    const snapshot = (calls: Call[]) => calls.filter((call) => 'p_settings' in call.args).map((call) => call.args.p_settings);
    expect(snapshot(marked.calls).length).toBeGreaterThan(0);
    expect(snapshot(marked.calls)).toEqual(snapshot(plain.calls));
    const fields = (calls: Call[]) => calls.filter((call) => call.fn === 'rag_set_document_fields').map((call) => call.args.p_fields);
    expect(fields(marked.calls)).toEqual(fields(plain.calls));
    const withoutApply = (calls: Call[]) => JSON.stringify(calls.filter((call) => call.fn !== 'rag_apply_document_attributes'));
    expect(withoutApply(marked.calls)).not.toContain(MARKER);
    expect(lines.join('\n')).not.toContain(MARKER);
    const inline = await runIngest(ON, { attributes: { alpha_code: MARKER } });
    expect(inline.result.status).toBe('ready');
    expect(lines.join('\n')).not.toContain(MARKER);
  });
});

describe('validateUploadAttributes', () => {
  const definitions = [
    { key: 'alpha_code', type: 'code', filterable: false, in_header: false, in_identifier_index: false, soft: false },
    { key: 'beta_list', type: 'text_list', filterable: false, in_header: false, in_identifier_index: false, soft: false },
  ];

  async function check(raw: string | null, config: { docAttributes: boolean }, options: { fail?: boolean; mode?: 'single' | 'org' } = {}) {
    vi.resetModules();
    const fakes = await import('../helpers/ingest-fakes');
    const reads: Row[] = [];
    const db: RpcClient = {
      rpc(fn, args) {
        if (fn === 'rag_attribute_definitions_for') reads.push((args ?? {}) as Row);
        const response =
          fn === 'rag_attribute_definitions_for' && options.fail
            ? { data: null, error: { code: 'XX000', message: `boom ${MARKER}` } }
            : { data: fn === 'rag_attribute_definitions_for' && (args as Row).p_tenant_key !== 'o:00000000-0000-4000-8000-0000000011c2' ? definitions : [], error: null };
        const request = { abortSignal: () => request, then: (ok: (v: unknown) => unknown, bad?: (r: unknown) => unknown) => Promise.resolve(response).then(ok, bad) };
        return request as never;
      },
    };
    fakes.installIngestDeps({ db });
    try {
      const { mintScope } = await import('@/lib/rag/tenant/scope');
      const { validateUploadAttributes } = await import('@/lib/rag/ingest/attributes/apply');
      const scope =
        options.mode === 'org'
          ? mintScope('org', '00000000-0000-4000-8000-0000000011a1', '00000000-0000-4000-8000-0000000011c1')
          : mintScope('single', null, null);
      return { result: await validateUploadAttributes(scope, raw, { signal: new AbortController().signal, config }), reads };
    } finally {
      fakes.uninstallIngestDeps();
    }
  }

  it('an absent field is ok with no attributes and reads no schema, whatever the switch', async () => {
    for (const docAttributes of [true, false]) {
      const { result, reads } = await check(null, { docAttributes });
      expect(result).toEqual({ ok: true, attributes: undefined });
      expect(reads).toEqual([]);
    }
  });

  it('a field present while the feature is off answers attributes_not_enabled without a schema read', async () => {
    const { result, reads } = await check('{}', { docAttributes: false });
    expect(result).toEqual({ ok: false, reason: 'attributes_not_enabled' });
    expect(reads).toEqual([]);
  });

  it('malformed JSON or a non-object answers invalid_attributes with one error', async () => {
    for (const raw of ['{not json', '[]', '"text"', 'null']) {
      const { result } = await check(raw, { docAttributes: true });
      expect(result).toEqual({ ok: false, reason: 'invalid_attributes', errors: [{ key: '', code: 'invalid_attribute_type' }] });
    }
  });

  it("valid values come back canonical, checked against the scope's own tenant schema", async () => {
    const { result, reads } = await check(JSON.stringify({ beta_list: [' x '], alpha_code: ' C-1' }), { docAttributes: true }, { mode: 'org' });
    expect(result).toEqual({ ok: true, attributes: { alpha_code: 'C-1', beta_list: ['x'] } });
    expect(reads).toEqual([{ p_tenant_key: 'o:00000000-0000-4000-8000-0000000011c1' }]);
  });

  it('invalid values return every structured error, never a value; an unreadable schema is unavailable', async () => {
    const { result } = await check(JSON.stringify({ delta_text: MARKER, alpha_code: ['x'] }), { docAttributes: true });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_attributes',
      errors: [{ key: 'delta_text', code: 'unknown_attribute' }, { key: 'alpha_code', code: 'invalid_attribute_type' }],
    });
    expect(JSON.stringify(result)).not.toContain(MARKER);
    const failed = await check('{"alpha_code":"x"}', { docAttributes: true }, { fail: true });
    expect(failed.result).toEqual({ ok: false, reason: 'unavailable' });
    expect(lines.join('\n')).not.toContain(MARKER);
  });
});
