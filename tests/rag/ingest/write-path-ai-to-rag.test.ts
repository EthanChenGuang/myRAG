import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { IngestInput, IngestResult } from '@/lib/rag/ingest';
import { fakeEmbedder } from '../helpers/pipeline-fakes';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_X = '00000000-0000-4000-8000-0000000000c1';
const DUPLICATE_OF = '00000000-0000-4000-8000-0000000000d1';
const CONTENT = 'First placeholder paragraph.\n\nSecond placeholder paragraph.';

type Row = Record<string, unknown>;

const state = {
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  members: [] as Array<{ organization_id: string; user_id: string }>,
  inserts: [] as Array<{ table: string; rows: Row[] }>,
  admins: [] as string[],
  readOnly: false,
  title: 'Placeholder Title',
};

function writeAdmin() {
  return {
    from(table: string) {
      let filter: unknown;
      const builder = {
        eq(_column: string, value: unknown) {
          filter = value;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        maybeSingle: () => {
          if (table === 'admin_users') return Promise.resolve({ data: state.admins.includes(filter as string) ? { id: filter } : null, error: null });
          if (table === 'admin_settings') return Promise.resolve({ data: { read_only_doc_dashboard: state.readOnly }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        insert(rows: Row[]) {
          state.inserts.push({ table, rows });
          return builder;
        },
        select: () => builder,
        single: () => Promise.resolve({ data: state.inserts.at(-1)?.rows[0] ?? null, error: null }),
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected),
      };
      return builder;
    },
  };
}

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
          const row = state.members.find(
            (member) => member.organization_id === filters.organization_id && member.user_id === filters.user_id,
          );
          return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
        },
      };
      return query;
    },
  };
}

const ingestSpy = vi.fn<(input: IngestInput) => Promise<IngestResult>>();
const resolveSpy = vi.fn();

const readyResult: IngestResult = {
  status: 'ready',
  documentId: '00000000-0000-4000-8000-0000000000e1',
  version: 1,
  parserUsed: 'text',
  chunkCount: 1,
  warnings: [],
};

interface LoadOptions {
  pipeline: 'legacy' | 'unified' | undefined | string;
  /** Use the real ingest() instead of the spy. */
  realIngest?: boolean;
}

async function loadPost(options: LoadOptions): Promise<(req: Request) => Promise<Response>> {
  vi.resetModules();
  if (options.pipeline === undefined) vi.stubEnv('RAG_INGEST_PIPELINE', '');
  else vi.stubEnv('RAG_INGEST_PIPELINE', options.pipeline);
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => state.mode,
    isMultiTenant: () => state.mode === 'multi-tenant',
    isSingleTenant: () => state.mode === 'single-tenant',
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session } }) } }),
  }));
  vi.doMock('@/lib/auth/organization-handler', () => ({ verifyUserOrganizationAccess: async () => ({ hasAccess: false }) }));
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => writeAdmin() }));
  vi.doMock('openai', () => ({
    default: class FakeOpenAI {
      chat = { completions: { create: async () => ({ choices: [{ message: { content: state.title } }] }) } };
    },
  }));
  const embedder = fakeEmbedder().embedder;
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...original,
      embedText: (text: string, opts: { signal: AbortSignal }) => embedder(text, opts),
      resolveTenantScope: (input: Parameters<typeof original.resolveTenantScope>[0]) => {
        resolveSpy(input);
        return original.resolveTenantScope(input);
      },
      ...(options.realIngest ? {} : { ingest: (input: IngestInput) => ingestSpy(input) }),
    };
  });
  const { setRagDepsForTests } = await import('@/lib/rag/deps');
  setRagDepsForTests({ adminClient: () => membershipAdmin() as never });
  const { POST } = await import('@/app/api/ai-to-rag/route');
  return POST;
}

function request(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/ai-to-rag', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: CONTENT, messageId: 'message-1', chatId: 'chat-1', ...body }),
  });
}

const writesOf = (table: string) => state.inserts.filter((insert) => insert.table === table).flatMap((insert) => insert.rows);

async function keyOf(scope: IngestInput['scope']): Promise<string> {
  const { scopeKey } = await import('@/lib/rag/tenant/scope');
  return scopeKey(scope);
}

beforeEach(() => {
  state.mode = 'multi-tenant';
  state.session = null;
  state.members = [];
  state.inserts = [];
  state.admins = [];
  state.readOnly = false;
  state.title = 'Placeholder Title';
  ingestSpy.mockReset();
  ingestSpy.mockResolvedValue(readyResult);
  resolveSpy.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('@/lib/rag');
  vi.doUnmock('@supabase/supabase-js');
  vi.doUnmock('openai');
});

describe('ai-to-rag write path: legacy', () => {
  it.each([undefined, 'legacy', 'bogus'])('RAG_INGEST_PIPELINE=%s keeps the route inserts and never calls ingest', async (pipeline) => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const POST = await loadPost({ pipeline });
    const response = await POST(request({ organizationId: ORG_X }));
    expect(response.status).toBe(200);
    expect(ingestSpy).not.toHaveBeenCalled();
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['chunksStored', 'documentId', 'filename', 'success', 'title', 'totalChunks']);
    expect(body).toMatchObject({ success: true, title: 'Placeholder Title', chunksStored: 1, totalChunks: 1 });
    const documents = writesOf('documents');
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ user_id: USER_A, organization_id: ORG_X });
    expect(documents[0].metadata).toMatchObject({ source: 'ai_response', messageId: 'message-1', chatId: 'chat-1' });
    expect(writesOf('document_chunks')).toHaveLength(1);
  });
});

describe('ai-to-rag write path: unified', () => {
  it('passes the session-derived personal scope, the chat and message source key and the metadata to ingest, and writes nothing itself', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost({ pipeline: 'unified' });
    const response = await POST(request({}));
    expect(response.status).toBe(200);
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    const input = ingestSpy.mock.calls[0][0];
    expect(await keyOf(input.scope)).toBe(`u:${USER_A}`);
    expect(input).toMatchObject({
      source: 'ai_to_rag',
      sourceKey: 'chat:chat-1/message:message-1',
      text: CONTENT,
      filename: 'Placeholder Title.md',
      mimeType: 'text/markdown',
    });
    expect(input.signal).toBeInstanceOf(AbortSignal);
    const metadata = input.options?.documentMetadata as Record<string, unknown>;
    expect(metadata).toMatchObject({ source: 'ai_response', messageId: 'message-1', chatId: 'chat-1' });
    expect(Number.isNaN(Date.parse(String(metadata.generatedAt)))).toBe(false);
    expect(state.inserts).toEqual([]);
  });

  it('resolves the tenant scope exactly once', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost({ pipeline: 'unified' });
    await POST(request({}));
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it('answers with success, documentId, filename, title, status and version', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost({ pipeline: 'unified' });
    const response = await POST(request({}));
    expect(await response.json()).toEqual({
      success: true,
      documentId: readyResult.documentId,
      filename: 'Placeholder Title.md',
      title: 'Placeholder Title',
      status: 'ready',
      version: 1,
      chunksStored: 1,
      totalChunks: 1,
    });
  });

  it('refuses a body userId that differs from the session user before ingest', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost({ pipeline: 'unified' });
    const response = await POST(request({ userId: USER_B }));
    expect(response.status).toBe(403);
    expect(ingestSpy).not.toHaveBeenCalled();
    expect(state.inserts).toEqual([]);
  });

  it('accepts a body userId equal to the session user and still scopes to the session user', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost({ pipeline: 'unified' });
    const response = await POST(request({ userId: USER_A.toUpperCase() }));
    expect(response.status).toBe(200);
    expect(await keyOf(ingestSpy.mock.calls[0][0].scope)).toBe(`u:${USER_A}`);
  });

  it('refuses a request with no session with 401 and never calls ingest', async () => {
    const POST = await loadPost({ pipeline: 'unified' });
    const response = await POST(request({ userId: USER_A }));
    expect(response.status).toBe(401);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('uses the organization scope when the session user is a member', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const POST = await loadPost({ pipeline: 'unified' });
    const response = await POST(request({ organizationId: ORG_X }));
    expect(response.status).toBe(200);
    expect(await keyOf(ingestSpy.mock.calls[0][0].scope)).toBe(`o:${ORG_X}`);
  });

  it('refuses an organization the session user is not a member of with 403 and never calls ingest', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_B }];
    const POST = await loadPost({ pipeline: 'unified' });
    const response = await POST(request({ userId: USER_A, organizationId: ORG_X }));
    expect(response.status).toBe(403);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('single-tenant: ingest receives the s:default scope, which carries no user', async () => {
    state.mode = 'single-tenant';
    state.session = { id: USER_A };
    const POST = await loadPost({ pipeline: 'unified' });
    const response = await POST(request({ userId: USER_A, organizationId: ORG_X }));
    expect(response.status).toBe(200);
    const { scope } = ingestSpy.mock.calls[0][0];
    expect(await keyOf(scope)).toBe('s:default');
    expect(scope.userId).toBeNull();
    expect(scope.organizationId).toBeNull();
  });

  it('single-tenant: no session gives 401, a mismatching body userId 403 and a read-only dashboard 403 for a non-admin, all before ingest', async () => {
    state.mode = 'single-tenant';
    const POST = await loadPost({ pipeline: 'unified' });
    expect((await POST(request({}))).status).toBe(401);
    state.session = { id: USER_A };
    expect((await POST(request({ userId: USER_B }))).status).toBe(403);
    state.readOnly = true;
    expect((await POST(request({}))).status).toBe(403);
    expect(ingestSpy).not.toHaveBeenCalled();
    state.admins = [USER_A];
    expect((await POST(request({}))).status).toBe(200);
    expect(ingestSpy).toHaveBeenCalledTimes(1);
  });

  it('returns 400 with the validation error shape when messageId is missing or not a string, and never calls ingest', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost({ pipeline: 'unified' });
    for (const messageId of [undefined, 42, '', '   ']) {
      const response = await POST(request({ messageId }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toMatchObject({ success: false, error: 'Invalid request data' });
      expect(body.details).toEqual([expect.objectContaining({ path: 'messageId' })]);
    }
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for a chatId that is not a string and for empty content, as before', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost({ pipeline: 'unified' });
    const badChat = await POST(request({ chatId: { id: 'chat-1' } }));
    expect(badChat.status).toBe(400);
    expect((await badChat.json()).details).toEqual([expect.objectContaining({ path: 'chatId' })]);
    expect((await POST(request({ content: '' }))).status).toBe(400);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('reports a second identical save as skipped_duplicate with the existing document id', async () => {
    state.session = { id: USER_A };
    ingestSpy.mockResolvedValueOnce(readyResult).mockResolvedValueOnce({
      status: 'skipped_duplicate',
      documentId: null,
      version: null,
      parserUsed: null,
      chunkCount: 0,
      warnings: [],
      duplicateOf: readyResult.documentId as string,
    });
    const POST = await loadPost({ pipeline: 'unified' });
    await POST(request({}));
    const response = await POST(request({}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      documentId: readyResult.documentId,
      filename: 'Placeholder Title.md',
      title: 'Placeholder Title',
      status: 'skipped_duplicate',
      version: null,
    });
    const [first, second] = ingestSpy.mock.calls.map(([input]) => input.sourceKey);
    expect(second).toBe(first);
  });

  it('maps processing to 202 and a failed run to 500 without leaking the reason or the content', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost({ pipeline: 'unified' });
    ingestSpy.mockResolvedValueOnce({ ...readyResult, status: 'processing', chunkCount: 0 });
    const processing = await POST(request({}));
    expect(processing.status).toBe(202);
    expect(await processing.json()).toMatchObject({ success: true, status: 'processing', documentId: readyResult.documentId });
    ingestSpy.mockResolvedValueOnce({ ...readyResult, status: 'failed', documentId: null, version: null, chunkCount: 0, reason: 'embed_failed' });
    const failed = await POST(request({}));
    expect(failed.status).toBe(500);
    const body = await failed.json();
    expect(body).toMatchObject({ success: false, status: 'failed' });
    expect(JSON.stringify(body)).not.toContain('placeholder paragraph');
  });

  it('keeps a title with path separators out of the filename', async () => {
    state.session = { id: USER_A };
    state.title = 'Choosing A/B tests\\for "growth"\n';
    const POST = await loadPost({ pipeline: 'unified' });
    const response = await POST(request({}));
    const { filename } = await response.json();
    expect(ingestSpy.mock.calls[0][0].filename).toBe(filename);
    expect(filename).toMatch(/\.md$/);
    expect(filename).not.toMatch(/[\\/\n]/);
    expect(filename).toContain('A-B tests');
  });

  it('never logs the content', async () => {
    state.session = { id: USER_A };
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const POST = await loadPost({ pipeline: 'unified' });
    await POST(request({}));
    await POST(request({ messageId: undefined }));
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain('placeholder paragraph');
  });
});

describe('ai-to-rag write path: unified with the real ingest()', () => {
  async function installFakes(wrap?: (db: RpcClient) => RpcClient) {
    const fakes = await import('../../helpers/ingest-fakes');
    const { db: base, calls } = fakes.fakeIngestDb();
    const db = wrap ? wrap(base) : base;
    const store = fakes.installIngestDeps({ db, env: { RAG_INGEST_PIPELINE: 'unified' } });
    return { fakes, calls, store };
  }

  afterEach(async () => {
    const fakes = await import('../../helpers/ingest-fakes');
    fakes.uninstallIngestDeps();
  });

  it('writes through the ingest writer under the session scope, with the chat metadata on the document and no route insert', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost({ pipeline: 'unified', realIngest: true });
    const { fakes, calls } = await installFakes();
    const response = await POST(request({}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, status: 'ready', version: 1, filename: 'Placeholder Title.md' });
    expect(state.inserts).toEqual([]);
    const begin = fakes.callsOf(calls, 'rag_begin_document_version')[0].args;
    expect(begin).toMatchObject({
      p_tenant_key: `u:${USER_A}`,
      p_user_id: USER_A,
      p_org_id: null,
      p_source: 'ai_to_rag',
      p_source_key: 'chat:chat-1/message:message-1',
      p_filename: 'Placeholder Title.md',
    });
    const metadataWrites = fakes
      .callsOf(calls, 'rag_set_document_fields')
      .map((call) => (call.args.p_fields as { metadata?: Record<string, unknown> }).metadata)
      .filter((metadata): metadata is Record<string, unknown> => metadata !== undefined && 'messageId' in metadata);
    expect(metadataWrites).toHaveLength(1);
    expect(metadataWrites[0]).toMatchObject({ source: 'ai_response', messageId: 'message-1', chatId: 'chat-1' });
    expect(fakes.callsOf(calls, 'rag_write_chunks')).toHaveLength(1);
    expect(fakes.callsOf(calls, 'rag_publish_document_version')).toHaveLength(1);
  });

  it('single-tenant sends no user id to the writer', async () => {
    state.mode = 'single-tenant';
    state.session = { id: USER_A };
    const POST = await loadPost({ pipeline: 'unified', realIngest: true });
    const { fakes, calls } = await installFakes();
    const response = await POST(request({ userId: USER_A }));
    expect(response.status).toBe(200);
    const begin = fakes.callsOf(calls, 'rag_begin_document_version')[0].args;
    expect(begin).toMatchObject({ p_tenant_key: 's:default', p_user_id: null, p_org_id: null });
  });

  it('a second identical save is skipped as a duplicate and keeps the response shape', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost({ pipeline: 'unified', realIngest: true });
    let begins = 0;
    const { fakes, calls } = await installFakes((db) => ({
      rpc(fn, args) {
        if (fn === 'rag_begin_document_version' && ++begins === 2) {
          const response = { data: [{ outcome: 'skipped_duplicate', document_id: null, version: null, lineage_id: null, duplicate_of: DUPLICATE_OF }], error: null };
          const request = {
            abortSignal: () => request,
            then: (onFulfilled: (value: typeof response) => unknown, onRejected?: (reason: unknown) => unknown) =>
              Promise.resolve(response).then(onFulfilled, onRejected),
          };
          calls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
          return request as never;
        }
        return db.rpc(fn, args);
      },
    }));
    const first = await POST(request({}));
    expect(first.status).toBe(200);
    const second = await POST(request({}));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      success: true,
      documentId: DUPLICATE_OF,
      filename: 'Placeholder Title.md',
      title: 'Placeholder Title',
      status: 'skipped_duplicate',
      version: null,
    });
    const writes = fakes.callsOf(calls, 'rag_write_chunks');
    expect(writes).toHaveLength(1);
  });

  it('never logs the content through ingest either', async () => {
    state.session = { id: USER_A };
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const POST = await loadPost({ pipeline: 'unified', realIngest: true });
    await installFakes();
    await POST(request({}));
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain('placeholder paragraph');
  });
});
