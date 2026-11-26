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

// ---------------------------------------------------------------------------------------------------------------------------------------
// Upload routes (D-22, D-23): the attributes form field of /api/process-document and /api/upload.
// ---------------------------------------------------------------------------------------------------------------------------------------

const USER_A = '00000000-0000-4000-8000-0000000011a1';
const ORG_O = '00000000-0000-4000-8000-0000000011c1';
const ORG_P = '00000000-0000-4000-8000-0000000011c2';
const BODY = 'First neutral placeholder paragraph.\n\nSecond neutral placeholder paragraph.';
const ROUTE_DEFINITIONS: Record<string, Row[]> = {
  's:default': [
    { key: 'alpha_code', type: 'code', filterable: false, in_header: false, in_identifier_index: false, soft: false },
    { key: 'beta_list', type: 'text_list', filterable: false, in_header: false, in_identifier_index: false, soft: false },
  ],
  [`o:${ORG_O}`]: [{ key: 'alpha_code', type: 'code', filterable: false, in_header: false, in_identifier_index: false, soft: false }],
  [`o:${ORG_P}`]: [{ key: 'gamma_text', type: 'text', filterable: false, in_header: false, in_identifier_index: false, soft: false }],
};

const routeState = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  members: [] as Array<{ organization_id: string; user_id: string }>,
  schemaFails: false,
  rpcCalls: [] as Call[],
  storageUploads: 0,
};

const ingestSpy = vi.hoisted(() => vi.fn<(input: IngestInput) => Promise<unknown>>());
const submitSpy = vi.hoisted(() => vi.fn<(input: IngestInput) => Promise<unknown>>());

function routeDb(): RpcClient {
  return {
    rpc(fn, args) {
      const a = (args ?? {}) as Row;
      routeState.rpcCalls.push({ fn, args: a });
      const response =
        fn === 'rag_attribute_definitions_for'
          ? routeState.schemaFails
            ? { data: null, error: { code: 'XX000', message: `connection reset ${MARKER}` } }
            : { data: ROUTE_DEFINITIONS[String(a.p_tenant_key)] ?? [], error: null }
          : { data: [], error: null };
      const request = { abortSignal: () => request, then: (ok: (v: unknown) => unknown, bad?: (r: unknown) => unknown) => Promise.resolve(response).then(ok, bad) };
      return request as never;
    },
  };
}

function routeAdmin() {
  return {
    from(table: string) {
      const filters: Record<string, string> = {};
      const builder = {
        eq: (column: string, value: string) => {
          filters[column] = value;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        select: () => builder,
        insert: () => builder,
        maybeSingle: () => {
          if (table === 'organization_members') {
            const row = routeState.members.find((m) => m.organization_id === filters.organization_id && m.user_id === filters.user_id);
            return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
          }
          return Promise.resolve({ data: table === 'admin_settings' ? { read_only_doc_dashboard: false } : null, error: null });
        },
        single: () => Promise.resolve({ data: { id: 'doc' }, error: null }),
        then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok, bad),
      };
      return builder;
    },
    storage: {
      from: () => ({
        upload: async () => {
          routeState.storageUploads += 1;
          return { data: {}, error: null };
        },
        getPublicUrl: () => ({ data: { publicUrl: 'http://127.0.0.1/placeholder' } }),
      }),
    },
  };
}

async function loadRoute(route: 'process-document' | 'upload', env: { pipeline: string; attributes: string; async?: boolean }) {
  vi.resetModules();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key-placeholder');
  vi.stubEnv('LLAMA_CLOUD_API_KEY', 'test-llama-key-placeholder');
  vi.stubEnv('RAG_INGEST_PIPELINE', env.pipeline);
  vi.stubEnv('RAG_DOC_ATTRIBUTES', env.attributes);
  vi.stubEnv('RAG_SCOPE_TAGS', 'false');
  vi.stubEnv('RAG_INGEST_ASYNC', env.async ? 'on' : 'off');
  vi.stubEnv('RAG_SUPERSESSION_DETECT', 'off');
  vi.stubEnv('RAG_SIDECAR_URL', 'http://127.0.0.1:9199');
  vi.stubEnv('RAG_SIDECAR_SECRET', 'wake-sidecar-secret-placeholder-00');
  vi.doMock('next/server', async (importOriginal) => ({ ...(await importOriginal<typeof import('next/server')>()), after: (task: () => unknown) => void task() }));
  vi.doMock('@/lib/rag/ingest/wake', () => ({ scheduleIngestWake: () => undefined }));
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => routeState.mode,
    isMultiTenant: () => routeState.mode === 'multi-tenant',
    isSingleTenant: () => routeState.mode === 'single-tenant',
  }));
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER_A } }, error: null }) } }) }));
  vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: routeAdmin(), getSupabaseAdmin: () => routeAdmin(), getSupabase: () => ({}) }));
  vi.doMock('@/lib/auth/organization-handler', () => ({
    verifyUserOrganizationAccess: async (userId: string, organizationId: string) => ({
      hasAccess: routeState.members.some((member) => member.user_id === userId && member.organization_id === organizationId),
    }),
  }));
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => routeAdmin() }));
  vi.doMock('node-fetch', () => ({
    default: async (url: string) => {
      const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' });
      if (url.endsWith('/parsing/upload')) return json({ id: 'job-1', status: 'PENDING' });
      if (url.endsWith('/result/markdown')) return json({ markdown: 'Neutral placeholder body.', metadata: { total_pages: 1 }, chunks: ['Neutral placeholder body.'] });
      return json({ status: 'SUCCESS' });
    },
  }));
  vi.doMock('@/lib/document-processor', () => ({ processImageDocument: async () => 'legacy-doc' }));
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...original,
      embedText: async () => [0.1, 0.2],
      ingest: (input: IngestInput) => ingestSpy(input),
      submitIngest: (input: IngestInput) => submitSpy(input),
    };
  });
  const { setRagDepsForTests } = await import('@/lib/rag/deps');
  setRagDepsForTests({ adminClient: () => routeAdmin() as never });
  const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  setIngestDepsForTests({ db: () => routeDb() });
  const module = route === 'upload' ? await import('@/app/api/upload/route') : await import('@/app/api/process-document/route');
  return module.POST as unknown as (req: Request) => Promise<Response>;
}

function documentForm(attributes: string | null, fields: Record<string, string> = {}): Request {
  const form = new FormData();
  form.append('file', new File([BODY], 'notes.txt', { type: 'text/plain' }));
  form.append('isTemporary', fields.isTemporary ?? 'false');
  for (const [key, value] of Object.entries(fields)) if (key !== 'isTemporary') form.append(key, value);
  if (attributes !== null) form.append('attributes', attributes);
  return new Request('http://localhost/api/process-document', { method: 'POST', body: form });
}

function imageForm(attributes: string | null, files = 1): Request {
  const form = new FormData();
  for (let i = 0; i < files; i += 1) {
    form.append('files', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, i])], `figure-${i}.png`, { type: 'image/png' }));
  }
  form.append('process_rag', 'true');
  if (attributes !== null) form.append('attributes', attributes);
  return new Request('http://localhost/api/upload', { method: 'POST', body: form });
}

const routeInputs = (): IngestInput[] => [...ingestSpy.mock.calls, ...submitSpy.mock.calls].map((call) => call[0] as IngestInput);
const schemaReads = () => routeState.rpcCalls.filter((call) => call.fn === 'rag_attribute_definitions_for');

describe('upload routes: the attributes field', () => {
  beforeEach(() => {
    routeState.mode = 'single-tenant';
    routeState.members = [];
    routeState.schemaFails = false;
    routeState.rpcCalls = [];
    routeState.storageUploads = 0;
    ingestSpy.mockReset();
    ingestSpy.mockResolvedValue({ status: 'ready', documentId: DOCUMENT, version: 1, parserUsed: 'text', chunkCount: 2, warnings: [] });
    submitSpy.mockReset();
    submitSpy.mockResolvedValue({ jobId: '00000000-0000-4000-8000-0000000011f1', documentId: DOCUMENT, status: 'queued' });
  });

  afterEach(() => {
    for (const id of ['next/server', '@/lib/rag/ingest/wake', '@/lib/deployment-mode', '@/lib/supabase/server', '@/lib/supabase', '@/lib/auth/organization-handler', '@supabase/supabase-js', 'node-fetch', '@/lib/document-processor', '@/lib/rag']) {
      vi.doUnmock(id);
    }
  });

  it.each([false, true])('process-document (queued=%s): valid values travel canonical in the ingest input', async (asyncOn) => {
    const POST = await loadRoute('process-document', { pipeline: 'unified', attributes: 'true', async: asyncOn });
    const response = await POST(documentForm(JSON.stringify({ beta_list: [' x'], alpha_code: 'C-1 ' })));
    expect([200, 202]).toContain(response.status);
    expect(routeInputs()).toHaveLength(1);
    expect(routeInputs()[0]?.attributes).toEqual({ alpha_code: 'C-1', beta_list: ['x'] });
    expect(schemaReads().map((call) => call.args)).toEqual([{ p_tenant_key: 's:default' }]);
  });

  it('without the field the request behaves as today: no attributes key and no schema read', async () => {
    const POST = await loadRoute('process-document', { pipeline: 'unified', attributes: 'true' });
    expect((await POST(documentForm(null))).status).toBe(200);
    expect(routeInputs()[0]).not.toHaveProperty('attributes');
    expect(schemaReads()).toEqual([]);
  });

  it('invalid values answer 400 invalid_attributes with one detail per error; malformed JSON gives path attributes', async () => {
    const POST = await loadRoute('process-document', { pipeline: 'unified', attributes: 'true' });
    const response = await POST(documentForm(JSON.stringify({ delta_text: MARKER, alpha_code: ['x'] })));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: 'invalid_attributes',
      details: [
        { path: 'attributes.delta_text', message: 'unknown_attribute' },
        { path: 'attributes.alpha_code', message: 'invalid_attribute_type' },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(MARKER);
    const malformed = await POST(documentForm('{not json'));
    expect(await malformed.json()).toEqual({ success: false, error: 'invalid_attributes', details: [{ path: 'attributes', message: 'invalid_attribute_type' }] });
    expect(routeInputs()).toEqual([]);
    expect(lines.join('\n')).not.toContain(MARKER);
  });

  it('an unreadable schema answers 503 attributes_unavailable without the database message', async () => {
    routeState.schemaFails = true;
    const POST = await loadRoute('process-document', { pipeline: 'unified', attributes: 'true' });
    const response = await POST(documentForm('{"alpha_code":"x"}'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'attributes_unavailable' });
    expect(routeInputs()).toEqual([]);
    expect(lines.join('\n')).not.toContain(MARKER);
  });

  it.each([
    ['the switch off', { pipeline: 'unified', attributes: 'false' }, {}],
    ['the legacy pipeline', { pipeline: 'legacy', attributes: 'true' }, {}],
    ['a temporary upload', { pipeline: 'unified', attributes: 'true' }, { isTemporary: 'true' }],
  ])('process-document with %s: 400 attributes_not_enabled and nothing is ingested', async (_label, env, fields) => {
    const POST = await loadRoute('process-document', env);
    const response = await POST(documentForm('{}', fields));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'attributes_not_enabled' });
    expect(routeInputs()).toEqual([]);
    expect(schemaReads()).toEqual([]);
  });

  it("multi-tenant: a member of O is checked against O's schema and never P's", async () => {
    routeState.mode = 'multi-tenant';
    routeState.members = [{ organization_id: ORG_O, user_id: USER_A }];
    const POST = await loadRoute('process-document', { pipeline: 'unified', attributes: 'true' });
    const refused = await POST(documentForm('{"gamma_text":"x"}', { organization_id: ORG_O }));
    expect(refused.status).toBe(400);
    expect((await refused.json()).details).toEqual([{ path: 'attributes.gamma_text', message: 'unknown_attribute' }]);
    const accepted = await POST(documentForm('{"alpha_code":"O-1"}', { organization_id: ORG_O }));
    expect(accepted.status).toBe(200);
    expect(routeInputs().at(-1)?.attributes).toEqual({ alpha_code: 'O-1' });
    expect(new Set(schemaReads().map((call) => call.args.p_tenant_key))).toEqual(new Set([`o:${ORG_O}`]));
  });

  it('image upload: valid values go on every file; invalid values or the switch off answer 400 before any file is stored', async () => {
    let POST = await loadRoute('upload', { pipeline: 'unified', attributes: 'true' });
    const response = await POST(imageForm('{"alpha_code":"I-1"}', 2));
    expect([200, 202]).toContain(response.status);
    await vi.waitFor(() => expect(routeInputs().length).toBe(2));
    expect(routeInputs().map((input) => input.attributes)).toEqual([{ alpha_code: 'I-1' }, { alpha_code: 'I-1' }]);
    const uploads = routeState.storageUploads;
    const invalid = await POST(imageForm('{"delta_text":"x"}'));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe('invalid_attributes');
    expect(routeState.storageUploads).toBe(uploads);
    POST = await loadRoute('upload', { pipeline: 'unified', attributes: 'false' });
    const off = await POST(imageForm('{}'));
    expect(off.status).toBe(400);
    expect(await off.json()).toEqual({ success: false, error: 'attributes_not_enabled' });
    POST = await loadRoute('upload', { pipeline: 'legacy', attributes: 'true' });
    const legacy = await POST(imageForm('{}'));
    expect(legacy.status).toBe(400);
    expect(await legacy.json()).toEqual({ success: false, error: 'attributes_not_enabled' });
    expect(routeState.storageUploads).toBe(uploads);
  });

  it('image upload without the field: the ingest input has no attributes key and no schema is read', async () => {
    const POST = await loadRoute('upload', { pipeline: 'unified', attributes: 'true' });
    expect((await POST(imageForm(null))).status).toBe(200);
    await vi.waitFor(() => expect(routeInputs().length).toBe(1));
    expect(routeInputs()[0]).not.toHaveProperty('attributes');
    expect(schemaReads()).toEqual([]);
  });
});
