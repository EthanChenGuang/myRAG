import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { IngestInput } from '@/lib/rag/ingest';
import type { EnqueueResult } from '@/lib/rag/ingest/enqueue';

/**
 * DATA-18, D-40: scope tags chosen at upload. The pipeline stores them on the version's document row after it is begun and before any chunk
 * is written (the chunk writers copy them, proven against the database in tests/rag-db/upload-scopes.test.mts); the routes check them
 * against the caller workspace's active vocabulary before anything is stored; with RAG_SCOPE_TAGS off or the legacy pipeline they are
 * ignored with one warning; the picker-defaults answer reports the tags block. Values are neutral synthetic slugs.
 */

const USER_A = '00000000-0000-4000-8000-0000000043a1';
const USER_B = '00000000-0000-4000-8000-0000000043b1';
const ORG_O = '00000000-0000-4000-8000-0000000043c1';
const ORG_P = '00000000-0000-4000-8000-0000000043c2';
const DOCUMENT = '00000000-0000-4000-8000-0000000043e1';
const JOB = '00000000-0000-4000-8000-0000000043f1';
const SERVICE_KEY = 'test-service-role-key-placeholder';
const BODY = 'First neutral placeholder paragraph.\n\nSecond neutral placeholder paragraph.';

type Row = Record<string, unknown>;
type Mode = 'single-tenant' | 'multi-tenant';

interface VocabRow {
  tenant_key: string;
  dimension: string;
  value: string;
  label: string;
  aliases: string[];
  active: boolean;
}

const vocab = (tenantKey: string, dimension: string, value: string, label: string, active = true): VocabRow => ({
  tenant_key: tenantKey,
  dimension,
  value,
  label,
  aliases: [],
  active,
});

const state = {
  mode: 'single-tenant' as Mode,
  session: null as { id: string } | null,
  members: [] as Array<{ organization_id: string; user_id: string }>,
  vocabulary: [] as VocabRow[],
  vocabularyFails: false,
  rpcCalls: [] as Array<{ fn: string; args: Row }>,
  storageUploads: 0,
  replaceTargets: [] as Array<{ tenant_key: string; document_id: string; lineage_id: string; source: string; source_key: string }>,
  tenantAdmins: [] as Array<{ tenant_key: string; user_id: string }>,
};

function respond(data: Row[] | null, error: { code: string; message: string } | null = null): RpcRequest {
  const response: RpcResponse = { data, error };
  const request: RpcRequest = {
    abortSignal: () => request,
    then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
  };
  return request;
}

/** The service-role RPC client: answers the vocabulary of the asked tenant only, ordered as rag_scope_vocabulary_for orders it. */
function vocabularyDb(): RpcClient {
  return {
    rpc(fn, args) {
      const a = (args ?? {}) as Row;
      state.rpcCalls.push({ fn, args: a });
      if (fn === 'rag_scope_vocabulary_for') {
        if (state.vocabularyFails) return respond(null, { code: 'XX000', message: 'connection reset: secret-text-placeholder' });
        const rank = ['region', 'legal_entity', 'department'];
        const rows = state.vocabulary
          .filter((row) => row.tenant_key === a.p_tenant_key)
          .sort((x, y) => rank.indexOf(x.dimension) - rank.indexOf(y.dimension) || x.label.toLowerCase().localeCompare(y.label.toLowerCase()))
          .map(({ dimension, value, label, aliases, active }) => ({ dimension, value, label, aliases, active }));
        return respond(rows);
      }
      if (fn === 'rag_supersession_replace_target') {
        const target = state.replaceTargets.find((row) => row.tenant_key === a.p_tenant_key && row.document_id === a.p_document_id);
        return respond(target ? [{ document_id: target.document_id, lineage_id: target.lineage_id, source: target.source, source_key: target.source_key }] : []);
      }
      if (fn === 'rag_is_tenant_admin') {
        const admin = state.tenantAdmins.some((row) => row.tenant_key === a.p_tenant_key && row.user_id === a.p_user);
        return respond(admin as unknown as Row[]);
      }
      return respond([]);
    },
  };
}

const vocabularyReads = () => state.rpcCalls.filter((call) => call.fn === 'rag_scope_vocabulary_for');

function membershipAdmin() {
  return {
    from() {
      const filters: Record<string, string> = {};
      const query = {
        select: () => query,
        eq(column: string, value: string) {
          filters[column] = value;
          return query;
        },
        abortSignal: () => query,
        maybeSingle() {
          const row = state.members.find((member) => member.organization_id === filters.organization_id && member.user_id === filters.user_id);
          return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
        },
      };
      return query;
    },
  };
}

/** Admin client of the routes: no admin users, a writable knowledge base, and a storage bucket that counts uploads. */
function routeAdmin() {
  return {
    from(table: string) {
      const builder = {
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        select: () => builder,
        insert: () => builder,
        maybeSingle: () => Promise.resolve({ data: table === 'admin_settings' ? { read_only_doc_dashboard: false } : null, error: null }),
        single: () => Promise.resolve({ data: { id: 'doc' }, error: null }),
        then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok, bad),
      };
      return builder;
    },
    storage: {
      from: () => ({
        upload: async () => {
          state.storageUploads += 1;
          return { data: {}, error: null };
        },
        getPublicUrl: () => ({ data: { publicUrl: 'http://127.0.0.1/placeholder' } }),
      }),
    },
  };
}

const ingestSpy = vi.hoisted(() => vi.fn<(input: IngestInput) => Promise<unknown>>());
const submitSpy = vi.hoisted(() => vi.fn<(input: IngestInput) => Promise<EnqueueResult>>());
let warnings: string[] = [];

interface RouteEnv {
  pipeline: string;
  scopeTags: string;
  async?: boolean;
  supersession?: string;
}

async function mockCommon(env: RouteEnv): Promise<void> {
  vi.resetModules();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  vi.stubEnv('LLAMA_CLOUD_API_KEY', 'test-llama-key-placeholder');
  vi.stubEnv('RAG_INGEST_PIPELINE', env.pipeline);
  vi.stubEnv('RAG_SCOPE_TAGS', env.scopeTags);
  vi.stubEnv('RAG_INGEST_ASYNC', env.async ? 'on' : 'off');
  vi.stubEnv('RAG_SUPERSESSION_DETECT', env.supersession ?? 'off');
  vi.stubEnv('RAG_SIDECAR_URL', 'http://127.0.0.1:9199');
  vi.stubEnv('RAG_SIDECAR_SECRET', 'wake-sidecar-secret-placeholder-00');
  vi.doMock('next/server', async (importOriginal) => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: (task: () => unknown) => void task(),
  }));
  vi.doMock('@/lib/rag/ingest/wake', () => ({ scheduleIngestWake: () => undefined }));
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => state.mode,
    isMultiTenant: () => state.mode === 'multi-tenant',
    isSingleTenant: () => state.mode === 'single-tenant',
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session }, error: null }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: routeAdmin(), getSupabaseAdmin: () => routeAdmin(), getSupabase: () => ({}) }));
  vi.doMock('@/lib/auth/organization-handler', () => ({
    verifyUserOrganizationAccess: async (userId: string, organizationId: string) => ({
      hasAccess: state.members.some((member) => member.user_id === userId && member.organization_id === organizationId),
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
  setRagDepsForTests({ adminClient: () => membershipAdmin() as never });
  const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  setIngestDepsForTests({ db: () => vocabularyDb() });
}

async function loadProcessDocument(env: RouteEnv): Promise<(req: Request) => Promise<Response>> {
  await mockCommon(env);
  return (await import('@/app/api/process-document/route')).POST;
}

async function loadImageUpload(env: RouteEnv): Promise<(req: Request) => Promise<Response>> {
  await mockCommon(env);
  return (await import('@/app/api/upload/route')).POST as unknown as (req: Request) => Promise<Response>;
}

async function loadDefaults(env: RouteEnv): Promise<(req: Request) => Promise<Response>> {
  await mockCommon(env);
  return (await import('@/app/api/rag/doc-type-defaults/route')).GET;
}

function documentForm(tags: string[], fields: Record<string, string> = {}, temporary = false): Request {
  const form = new FormData();
  form.append('file', new File([BODY], 'notes.txt', { type: 'text/plain' }));
  form.append('isTemporary', String(temporary));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const tag of tags) form.append('scopes', tag);
  return new Request('http://localhost/api/process-document', { method: 'POST', body: form });
}

function imageForm(tags: string[]): Request {
  const form = new FormData();
  form.append('files', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])], 'figure.png', { type: 'image/png' }));
  form.append('process_rag', 'true');
  for (const tag of tags) form.append('scopes', tag);
  return new Request('http://localhost/api/upload', { method: 'POST', body: form });
}

const ingestInputs = (): IngestInput[] => [...ingestSpy.mock.calls, ...submitSpy.mock.calls].map((call) => call[0] as IngestInput);
const lastInput = (): IngestInput => {
  const inputs = ingestInputs();
  expect(inputs.length, 'an ingest input was submitted').toBeGreaterThan(0);
  return inputs.at(-1) as IngestInput;
};
const ignoredWarnings = () => warnings.filter((line) => line.includes('upload scope tags ignored'));

beforeEach(() => {
  state.mode = 'single-tenant';
  state.session = { id: USER_A };
  state.members = [];
  state.vocabulary = [
    vocab('s:default', 'region', 'a1', 'Area one'),
    vocab('s:default', 'department', 'd1', 'Unit one'),
    vocab('s:default', 'region', 'b2', 'Area two', false),
  ];
  state.vocabularyFails = false;
  state.rpcCalls = [];
  state.storageUploads = 0;
  state.replaceTargets = [];
  state.tenantAdmins = [];
  warnings = [];
  ingestSpy.mockReset();
  ingestSpy.mockResolvedValue({ status: 'ready', documentId: DOCUMENT, version: 1, parserUsed: 'text', chunkCount: 2, warnings: [] });
  submitSpy.mockReset();
  submitSpy.mockResolvedValue({ jobId: JOB, documentId: DOCUMENT, status: 'queued' });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const id of [
    'next/server',
    '@/lib/rag/ingest/wake',
    '@/lib/deployment-mode',
    '@/lib/supabase/server',
    '@/lib/supabase',
    '@/lib/auth/organization-handler',
    '@supabase/supabase-js',
    'node-fetch',
    '@/lib/document-processor',
    '@/lib/rag',
  ]) {
    vi.doUnmock(id);
  }
});

describe('the ingest pipeline stores the upload tags on the document before any chunk is written', () => {
  const MARKDOWN = ['# Neutral handbook', '', 'The first neutral paragraph describes a placeholder process.', '', 'The second neutral paragraph closes it.', ''].join('\n');

  async function runIngest(env: Record<string, string>, extra: Partial<IngestInput>, enqueue = false) {
    vi.resetModules();
    const fakes = await import('../helpers/ingest-fakes');
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const { db, calls } = fakes.fakeIngestDb();
    fakes.installIngestDeps({ db, env: { RAG_INGEST_PIPELINE: 'unified', ...env } });
    const input = {
      scope: mintScope('single', null, null),
      source: 'config_upload' as const,
      sourceKey: 'root/neutral.md',
      text: MARKDOWN,
      filename: 'neutral.md',
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
      ...extra,
    } as IngestInput;
    try {
      if (enqueue) {
        const { enqueueStageContext, runEnqueueStages, queuedInputRecordOf } = await import('@/lib/rag/ingest/enqueue');
        const ctx = enqueueStageContext(input, (await import('@/lib/rag/ingest/deps')).getIngestDeps(), db);
        const result = await runEnqueueStages(ctx);
        return { calls, result, record: queuedInputRecordOf(input, ctx) };
      }
      const { ingest } = await import('@/lib/rag/ingest');
      return { calls, result: await ingest(input), record: null };
    } finally {
      fakes.uninstallIngestDeps();
    }
  }

  const order = (calls: Array<{ fn: string }>) => calls.map((call) => call.fn);

  it('inline: rag_set_upload_scopes runs once, for the begun document and its tenant, after begin and before the first chunk write', async () => {
    const { calls, result } = await runIngest({ RAG_SCOPE_TAGS: 'true' }, { scopes: ['region:a1'] });
    expect(result.status).toBe('ready');
    const fns = order(calls);
    const set = calls.filter((call) => call.fn === 'rag_set_upload_scopes');
    expect(set).toHaveLength(1);
    expect(set[0]?.args).toEqual({ p_document_id: '11111111-1111-4111-8111-111111111111', p_tenant_key: 's:default', p_scopes: ['region:a1'] });
    expect(fns.indexOf('rag_begin_document_version')).toBeLessThan(fns.indexOf('rag_set_upload_scopes'));
    expect(fns.indexOf('rag_set_upload_scopes')).toBeLessThan(fns.indexOf('rag_write_chunks'));
  });

  it('queued: the enqueue stages store the tags on the processing version and the queued input carries them for the final version', async () => {
    const { calls, record } = await runIngest({ RAG_SCOPE_TAGS: 'true' }, { scopes: ['department:d1', 'region:a1'] }, true);
    const set = calls.filter((call) => call.fn === 'rag_set_upload_scopes');
    expect(set.map((call) => call.args.p_scopes)).toEqual([['department:d1', 'region:a1']]);
    expect(order(calls)).not.toContain('rag_write_chunks');
    expect(record?.scopes).toEqual(['department:d1', 'region:a1']);
  });

  it('an upload without tags writes none: the writer calls equal those of a run with the switch off', async () => {
    const on = await runIngest({ RAG_SCOPE_TAGS: 'true' }, {});
    const off = await runIngest({}, {});
    expect(order(on.calls)).not.toContain('rag_set_upload_scopes');
    expect(order(on.calls)).toEqual(order(off.calls));
    const queued = await runIngest({ RAG_SCOPE_TAGS: 'true' }, {}, true);
    expect(queued.record).not.toHaveProperty('scopes');
  });

  it('with RAG_SCOPE_TAGS switched off the pipeline writes no tag and warns once with the count only', async () => {
    const tagged = await runIngest({}, { scopes: ['region:a1'] });
    const plain = await runIngest({}, {});
    expect(order(tagged.calls)).toEqual(order(plain.calls));
    expect(ignoredWarnings()).toHaveLength(1);
    expect(ignoredWarnings()[0]).toContain('"count":1');
    expect(ignoredWarnings()[0]).not.toContain('a1');
  });

  it('a refusal of the database (a value retired since the route checked it) fails the run before any chunk is written', async () => {
    vi.resetModules();
    const fakes = await import('../helpers/ingest-fakes');
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const { db, calls } = fakes.fakeIngestDb({ failures: { rag_set_upload_scopes: { code: 'P0001', message: 'unknown_scope_value' } } });
    fakes.installIngestDeps({ db, env: { RAG_INGEST_PIPELINE: 'unified', RAG_SCOPE_TAGS: 'true' } });
    try {
      const { ingest } = await import('@/lib/rag/ingest');
      const result = await ingest({
        scope: mintScope('single', null, null),
        source: 'config_upload',
        sourceKey: 'root/neutral.md',
        text: MARKDOWN,
        filename: 'neutral.md',
        mimeType: 'text/markdown',
        signal: new AbortController().signal,
        scopes: ['region:b2'],
      } as IngestInput);
      expect(result.status).toBe('failed');
      expect(order(calls)).not.toContain('rag_write_chunks');
    } finally {
      fakes.uninstallIngestDeps();
    }
  });
});

describe('process-document: tags at upload', () => {
  it.each([false, true])('unified with the switch on (queued=%s): the checked tags travel in the ingest input, read from the caller tenant', async (asyncOn) => {
    const POST = await loadProcessDocument({ pipeline: 'unified', scopeTags: 'true', async: asyncOn });
    const response = await POST(documentForm(['region:a1', 'department:d1', 'region:a1']));
    expect([200, 202]).toContain(response.status);
    expect((asyncOn ? submitSpy : ingestSpy).mock.calls).toHaveLength(1);
    expect(lastInput().scopes).toEqual(['department:d1', 'region:a1']);
    expect(vocabularyReads().map((call) => call.args)).toEqual([{ p_tenant_key: 's:default' }]);
  });

  it.each([
    ['an unknown value', ['region:zz9']],
    ['a retired value', ['region:b2']],
    ['an unknown dimension', ['nowhere:a1']],
    ['a malformed tag', ['Region: A1']],
  ])('%s answers 400 unknown_scope_value and nothing is ingested', async (_label, tags) => {
    const POST = await loadProcessDocument({ pipeline: 'unified', scopeTags: 'true' });
    const response = await POST(documentForm(tags));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unknown_scope_value' });
    expect(ingestInputs()).toEqual([]);
  });

  it('more than 20 tags answers 400 too_many_scopes before the vocabulary is read', async () => {
    const POST = await loadProcessDocument({ pipeline: 'unified', scopeTags: 'true' });
    const tags = Array.from({ length: 21 }, (_, index) => `region:v${index}`);
    const response = await POST(documentForm(tags));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'too_many_scopes' });
    expect(ingestInputs()).toEqual([]);
    expect(vocabularyReads()).toEqual([]);
  });

  it('a vocabulary that cannot be read answers 503 without the database message and ingests nothing', async () => {
    state.vocabularyFails = true;
    const POST = await loadProcessDocument({ pipeline: 'unified', scopeTags: 'true' });
    const response = await POST(documentForm(['region:a1']));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('secret-text-placeholder');
    expect(ingestInputs()).toEqual([]);
  });

  it('an upload without tags reads no vocabulary and its ingest input has no scopes field', async () => {
    const POST = await loadProcessDocument({ pipeline: 'unified', scopeTags: 'true' });
    expect((await POST(documentForm([]))).status).toBe(200);
    expect(lastInput()).not.toHaveProperty('scopes');
    expect(vocabularyReads()).toEqual([]);
  });

  it('with RAG_SCOPE_TAGS off the tags are ignored: the ingest input equals an untagged one and one warning carries the count only', async () => {
    const POST = await loadProcessDocument({ pipeline: 'unified', scopeTags: 'false' });
    expect((await POST(documentForm(['region:a1', 'nowhere:zz']))).status).toBe(200);
    const tagged = lastInput();
    expect((await POST(documentForm([]))).status).toBe(200);
    const plain = lastInput();
    const { signal: _a, ...taggedRest } = tagged;
    const { signal: _b, ...plainRest } = plain;
    expect({ ...taggedRest, deadlineMs: 0 }).toEqual({ ...plainRest, deadlineMs: 0 });
    expect(vocabularyReads()).toEqual([]);
    expect(ignoredWarnings()).toHaveLength(1);
    expect(ignoredWarnings()[0]).toContain('"count":2');
    expect(ignoredWarnings()[0]).not.toContain('a1');
  });

  it('under the legacy pipeline an upload with tags is processed as today, writes no tag and warns once', async () => {
    const POST = await loadProcessDocument({ pipeline: 'legacy', scopeTags: 'true' });
    const response = await POST(documentForm(['region:a1']));
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json()).sort()).toEqual(['id', 'name', 'pages', 'successfulChunks', 'text', 'totalChunks', 'type']);
    expect(ingestInputs()).toEqual([]);
    expect(vocabularyReads()).toEqual([]);
    expect(state.rpcCalls.filter((call) => /scope/.test(call.fn))).toEqual([]);
    expect(ignoredWarnings()).toHaveLength(1);
  });
});

describe('image upload: tags at upload', () => {
  it.each([false, true])('unified with the switch on (queued=%s): every image ingest input carries the checked tags', async (asyncOn) => {
    const POST = await loadImageUpload({ pipeline: 'unified', scopeTags: 'true', async: asyncOn });
    const response = await POST(imageForm(['region:a1']));
    expect([200, 202]).toContain(response.status);
    await vi.waitFor(() => expect(ingestInputs().length).toBe(1));
    expect(lastInput().scopes).toEqual(['region:a1']);
  });

  it('an unknown value answers 400 unknown_scope_value before any file is stored', async () => {
    const POST = await loadImageUpload({ pipeline: 'unified', scopeTags: 'true' });
    const response = await POST(imageForm(['region:b2']));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unknown_scope_value' });
    expect(state.storageUploads).toBe(0);
    expect(ingestInputs()).toEqual([]);
  });

  it('with the switch off the tags are ignored with one warning and the image is ingested without them', async () => {
    const POST = await loadImageUpload({ pipeline: 'unified', scopeTags: 'false' });
    expect((await POST(imageForm(['region:a1']))).status).toBe(200);
    await vi.waitFor(() => expect(ingestInputs().length).toBe(1));
    expect(lastInput()).not.toHaveProperty('scopes');
    expect(vocabularyReads()).toEqual([]);
    expect(ignoredWarnings()).toHaveLength(1);
  });
});

describe('GET /api/rag/doc-type-defaults: the tags block', () => {
  const PICKER = 'http://localhost/api/rag/doc-type-defaults?source=chat_upload';

  it('with the switch off the answer is today plus tags disabled, and no vocabulary is read', async () => {
    const GET = await loadDefaults({ pipeline: 'unified', scopeTags: 'false' });
    expect(await (await GET(new Request(PICKER))).json()).toEqual({
      enabled: true,
      docType: 'general',
      origin: 'fallback',
      tags: { enabled: false, vocabulary: [] },
      replaces: { enabled: false, confirmedAtOnce: false },
    });
    expect(vocabularyReads()).toEqual([]);
  });

  it('under the legacy pipeline the picker and the tags are both disabled', async () => {
    const GET = await loadDefaults({ pipeline: 'legacy', scopeTags: 'true' });
    expect(await (await GET(new Request(PICKER))).json()).toEqual({ enabled: false, tags: { enabled: false, vocabulary: [] }, replaces: { enabled: false, confirmedAtOnce: false } });
    expect(vocabularyReads()).toEqual([]);
  });

  it('with the switch on it lists the active values of the caller workspace, by dimension then label, without aliases or retired values', async () => {
    state.vocabulary.push(vocab('s:default', 'region', 'a0', 'Again area'), vocab('s:default', 'legal_entity', 'e1', 'Entity one'));
    const GET = await loadDefaults({ pipeline: 'unified', scopeTags: 'true' });
    const body = await (await GET(new Request(PICKER))).json();
    expect(body).toMatchObject({ enabled: true, docType: 'general', origin: 'fallback' });
    expect(body.tags).toEqual({
      enabled: true,
      vocabulary: [
        { dimension: 'region', value: 'a0', label: 'Again area' },
        { dimension: 'region', value: 'a1', label: 'Area one' },
        { dimension: 'legal_entity', value: 'e1', label: 'Entity one' },
        { dimension: 'department', value: 'd1', label: 'Unit one' },
      ],
    });
  });

  it("a member of organization O receives O's vocabulary and never organization P's", async () => {
    state.mode = 'multi-tenant';
    state.session = { id: USER_B };
    state.members = [{ organization_id: ORG_O, user_id: USER_B }, { organization_id: ORG_P, user_id: USER_A }];
    state.vocabulary = [vocab(`o:${ORG_O}`, 'region', 'o-only', 'Area of O'), vocab(`o:${ORG_P}`, 'region', 'p-only', 'Area of P')];
    const GET = await loadDefaults({ pipeline: 'unified', scopeTags: 'true' });
    const own = await (await GET(new Request(`${PICKER}&organizationId=${ORG_O}`))).json();
    expect(own.tags.vocabulary).toEqual([{ dimension: 'region', value: 'o-only', label: 'Area of O' }]);
    const other = await GET(new Request(`${PICKER}&organizationId=${ORG_P}`));
    expect(other.status).toBe(403);
    expect(vocabularyReads().map((call) => call.args.p_tenant_key)).toEqual([`o:${ORG_O}`]);
  });

  it('a vocabulary that cannot be read answers 503 without the database message', async () => {
    state.vocabularyFails = true;
    const GET = await loadDefaults({ pipeline: 'unified', scopeTags: 'true' });
    const response = await GET(new Request(PICKER));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('secret-text-placeholder');
  });
});

// Plan 03.2-45 (DATA-19, D-41): "Replaces…" at upload. The routes check the named document before anything is stored; the pipeline records
// the intent on the version before it is published or held; the picker-defaults answer reports the replaces block.
const REPLACED = '00000000-0000-4000-8000-0000000045e1';
const REPLACES_PICKER = 'http://localhost/api/rag/doc-type-defaults?source=chat_upload';
const OTHER_TENANT_DOC = '00000000-0000-4000-8000-0000000045e2';

describe('"Replaces…" at upload', () => {
  const target = (tenantKey: string, documentId: string, sourceKey = 'root/older.txt') =>
    state.replaceTargets.push({ tenant_key: tenantKey, document_id: documentId, lineage_id: documentId, source: 'chat_upload', source_key: sourceKey });

  it.each([false, true])('process-document (queued=%s): a current document of the same workspace travels in the ingest input', async (asyncOn) => {
    target('s:default', REPLACED);
    const POST = await loadProcessDocument({ pipeline: 'unified', scopeTags: 'false', supersession: 'on', async: asyncOn });
    const response = await POST(documentForm([], { replaces_document_id: REPLACED }));
    expect([200, 202]).toContain(response.status);
    expect(lastInput().replacesDocumentId).toBe(REPLACED);
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_supersession_replace_target').map((call) => call.args)).toEqual([
      { p_tenant_key: 's:default', p_document_id: REPLACED },
    ]);
  });

  it("another tenant's document, an unknown id, a malformed id or the upload's own lineage answers 400 and nothing is ingested", async () => {
    state.mode = 'multi-tenant';
    state.members = [{ organization_id: ORG_O, user_id: USER_A }];
    target(`o:${ORG_P}`, OTHER_TENANT_DOC);
    target(`o:${ORG_O}`, REPLACED, 'root/notes.txt');
    const POST = await loadProcessDocument({ pipeline: 'unified', scopeTags: 'false', supersession: 'on' });
    for (const [value, error] of [
      [OTHER_TENANT_DOC, 'replaces_not_found'],
      ['00000000-0000-4000-8000-0000000045ff', 'replaces_not_found'],
      ['not-a-document', 'invalid_replaces'],
      [REPLACED, 'replaces_same_lineage'],
    ] as const) {
      const response = await POST(documentForm([], { replaces_document_id: value, organization_id: ORG_O }));
      expect(response.status, value).toBe(400);
      expect(await response.json()).toMatchObject({ error });
    }
    expect(ingestInputs()).toEqual([]);
    expect(state.storageUploads).toBe(0);
  });

  it('with the switch off the field is ignored: no lookup, and the ingest input has no replacesDocumentId', async () => {
    target('s:default', REPLACED);
    const POST = await loadProcessDocument({ pipeline: 'unified', scopeTags: 'false', supersession: 'off' });
    const response = await POST(documentForm([], { replaces_document_id: REPLACED }));
    expect([200, 202]).toContain(response.status);
    expect(lastInput()).not.toHaveProperty('replacesDocumentId');
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_supersession_replace_target')).toEqual([]);
  });

  it('image upload: one file carries the checked id; several files with Replaces… answer 400 before any file is stored', async () => {
    target('s:default', REPLACED);
    const POST = await loadImageUpload({ pipeline: 'unified', scopeTags: 'false', supersession: 'on' });
    const one = imageForm([]);
    const form = await one.formData();
    form.append('replaces_document_id', REPLACED);
    const response = await POST(new Request('http://localhost/api/upload', { method: 'POST', body: form }));
    expect([200, 202]).toContain(response.status);
    await vi.waitFor(() => expect(ingestInputs().length).toBe(1));
    expect(lastInput().replacesDocumentId).toBe(REPLACED);

    const two = await imageForm([]).formData();
    two.append('files', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 5, 6])], 'second.png', { type: 'image/png' }));
    two.append('replaces_document_id', REPLACED);
    const uploadsBefore = state.storageUploads;
    const refused = await POST(new Request('http://localhost/api/upload', { method: 'POST', body: two }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'replaces_needs_one_file' });
    expect(state.storageUploads).toBe(uploadsBefore);
  });

  it('GET doc-type-defaults: replaces is enabled only with the switch on, and confirmedAtOnce follows the tenant admin check', async () => {
    let GET = await loadDefaults({ pipeline: 'unified', scopeTags: 'false', supersession: 'on' });
    expect((await (await GET(new Request(REPLACES_PICKER))).json()).replaces).toEqual({ enabled: true, confirmedAtOnce: false });
    state.tenantAdmins = [{ tenant_key: 's:default', user_id: USER_A }];
    GET = await loadDefaults({ pipeline: 'unified', scopeTags: 'false', supersession: 'on' });
    expect((await (await GET(new Request(REPLACES_PICKER))).json()).replaces).toEqual({ enabled: true, confirmedAtOnce: true });
    state.rpcCalls = [];
    GET = await loadDefaults({ pipeline: 'unified', scopeTags: 'false', supersession: 'off' });
    expect((await (await GET(new Request(REPLACES_PICKER))).json()).replaces).toEqual({ enabled: false, confirmedAtOnce: false });
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_is_tenant_admin')).toEqual([]);
  });
});

describe('the pipeline records the "Replaces…" intent on the version before it is published', () => {
  async function run(env: Record<string, string>, extra: Partial<IngestInput>, admin: boolean) {
    vi.resetModules();
    const fakes = await import('../helpers/ingest-fakes');
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const { db, calls } = fakes.fakeIngestDb();
    const recording: RpcClient = {
      rpc(fn, args) {
        if (fn === 'rag_is_tenant_admin') {
          calls.push({ fn, args: (args ?? {}) as Row });
          return respond(admin as unknown as Row[]);
        }
        return db.rpc(fn, args);
      },
    };
    fakes.installIngestDeps({ db: recording, env: { RAG_INGEST_PIPELINE: 'unified', ...env } });
    try {
      const { ingest } = await import('@/lib/rag/ingest');
      const result = await ingest({
        scope: mintScope('single', null, null),
        source: 'config_upload',
        sourceKey: 'root/neutral.md',
        text: '# Neutral notes\n\nA neutral placeholder paragraph.\n',
        filename: 'neutral.md',
        mimeType: 'text/markdown',
        uploaderId: USER_A,
        signal: new AbortController().signal,
        ...extra,
      } as IngestInput);
      return { result, calls };
    } finally {
      fakes.uninstallIngestDeps();
    }
  }

  const intents = (calls: Array<{ fn: string; args: Row }>) =>
    calls
      .filter((call) => call.fn === 'rag_set_document_fields')
      .map((call) => ((call.args.p_fields as Row).metadata as Row | undefined)?.supersession_replaces)
      .filter((value) => value !== undefined);

  it('switch on: the intent (target, uploader, confirm for an admin) is written before rag_publish_document_version', async () => {
    for (const admin of [true, false]) {
      const { result, calls } = await run({ RAG_SUPERSESSION_DETECT: 'on' }, { replacesDocumentId: REPLACED }, admin);
      expect(result.status).toBe('ready');
      expect(intents(calls)).toEqual([{ document_id: REPLACED, actor: USER_A, confirm: admin }]);
      const fns = calls.map((call) => call.fn);
      const write = fns.findIndex((fn, index) => fn === 'rag_set_document_fields' && intents([calls[index] as { fn: string; args: Row }]).length > 0);
      expect(write).toBeLessThan(fns.indexOf('rag_publish_document_version'));
    }
  });

  it('switch off or no id: the writer calls equal those of an upload without Replaces…', async () => {
    const plain = await run({ RAG_SUPERSESSION_DETECT: 'off' }, {}, true);
    const off = await run({ RAG_SUPERSESSION_DETECT: 'off' }, { replacesDocumentId: REPLACED }, true);
    const onWithout = await run({ RAG_SUPERSESSION_DETECT: 'on' }, {}, true);
    // The post-publish detector (switch on) reads after the result; only the ingest writer calls are compared.
    const strip = (calls: Array<{ fn: string; args: Row }>) => calls.map((call) => call.fn).filter((fn) => !fn.startsWith('rag_supersession_'));
    expect(strip(off.calls)).toEqual(strip(plain.calls));
    expect(strip(onWithout.calls)).toEqual(strip(plain.calls));
    expect(intents(off.calls)).toEqual([]);
  });

  it('a queued upload keeps the id in its queued input for the publish of the queued run', async () => {
    vi.resetModules();
    const fakes = await import('../helpers/ingest-fakes');
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const { db } = fakes.fakeIngestDb();
    fakes.installIngestDeps({ db, env: { RAG_INGEST_PIPELINE: 'unified', RAG_SUPERSESSION_DETECT: 'on' } });
    try {
      const { enqueueStageContext, queuedInputRecordOf } = await import('@/lib/rag/ingest/enqueue');
      const { decodeQueuedInput, encodeQueuedInput } = await import('@/lib/rag/ingest/queued-context');
      const input = {
        scope: mintScope('single', null, null),
        source: 'config_upload' as const,
        sourceKey: 'root/neutral.md',
        text: 'A neutral placeholder paragraph.',
        filename: 'neutral.md',
        mimeType: 'text/markdown',
        replacesDocumentId: REPLACED,
        signal: new AbortController().signal,
      } as IngestInput;
      const ctx = enqueueStageContext(input, (await import('@/lib/rag/ingest/deps')).getIngestDeps(), db);
      const record = queuedInputRecordOf(input, ctx);
      expect(record.replacesDocumentId).toBe(REPLACED);
      expect(decodeQueuedInput(encodeQueuedInput(record))?.replacesDocumentId).toBe(REPLACED);
    } finally {
      fakes.uninstallIngestDeps();
    }
  });
});
