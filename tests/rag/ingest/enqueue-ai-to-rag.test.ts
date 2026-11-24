import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnqueueResult, IngestInput, IngestResult } from '@/lib/rag';
import type { JobSettingsSnapshot } from '@/lib/rag-eval/contracts.generated';
import { buildParserChain } from '@/lib/rag/ingest/parsers/chain';
import { isTextLike, parsePlainText } from '@/lib/rag/ingest/parsers/plain-text';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { fakeEmbedder } from '../helpers/pipeline-fakes';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_X = '00000000-0000-4000-8000-0000000000c1';
const JOB_ID = '00000000-0000-4000-8000-0000000000f1';
const DOCUMENT_ID = '00000000-0000-4000-8000-0000000000e1';
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
          if (table === 'rag_parse_tier_overrides') return Promise.resolve({ data: null, error: null });
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

const submitSpy = vi.fn<(input: IngestInput) => Promise<IngestResult | EnqueueResult>>();
const wakeSpy = vi.fn();
const embedSpy = vi.fn();
const resolveSpy = vi.fn();

const readyResult: IngestResult = {
  status: 'ready',
  documentId: DOCUMENT_ID,
  version: 1,
  parserUsed: 'text',
  chunkCount: 1,
  warnings: [],
};

const queuedResult: EnqueueResult = {
  status: 'queued',
  jobId: JOB_ID,
  documentId: DOCUMENT_ID,
};

interface LoadOptions {
  ingestAsync: 'on' | 'off';
}

async function loadPost(options: LoadOptions): Promise<(req: Request) => Promise<Response>> {
  vi.resetModules();
  vi.stubEnv('RAG_INGEST_PIPELINE', 'unified');
  vi.stubEnv('RAG_INGEST_ASYNC', options.ingestAsync);
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
  vi.doMock('@/lib/rag/ingest/wake', () => ({ scheduleIngestWake: wakeSpy }));
  const embedder = fakeEmbedder().embedder;
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...original,
      embedText: (text: string, opts: { signal: AbortSignal }) => {
        embedSpy(text, opts);
        return embedder(text, opts);
      },
      resolveTenantScope: (input: Parameters<typeof original.resolveTenantScope>[0]) => {
        resolveSpy(input);
        return original.resolveTenantScope(input);
      },
      ingest: (input: IngestInput) => submitSpy(input),
      submitIngest: (input: IngestInput) => submitSpy(input),
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

beforeEach(() => {
  state.mode = 'multi-tenant';
  state.session = null;
  state.members = [];
  state.inserts = [];
  state.admins = [];
  state.readOnly = false;
  state.title = 'Placeholder Title';
  submitSpy.mockReset();
  submitSpy.mockResolvedValue(queuedResult);
  wakeSpy.mockReset();
  embedSpy.mockReset();
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
  vi.doUnmock('@/lib/rag/ingest/wake');
  vi.doUnmock('@supabase/supabase-js');
  vi.doUnmock('openai');
});

describe('ai-to-rag queue switch', () => {
  it('with async on returns 202 with jobId, documentId and status queued, then schedules the wake', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost({ ingestAsync: 'on' });
    const response = await POST(request({}));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      success: true,
      jobId: JOB_ID,
      documentId: DOCUMENT_ID,
      filename: 'Placeholder Title.md',
      title: 'Placeholder Title',
      status: 'queued',
    });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(wakeSpy).toHaveBeenCalledTimes(1);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('passes text/markdown and the chat message source key to submitIngest', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost({ ingestAsync: 'on' });
    await POST(request({}));
    expect(submitSpy.mock.calls[0][0]).toMatchObject({
      source: 'ai_to_rag',
      sourceKey: 'chat:chat-1/message:message-1',
      text: CONTENT,
      filename: 'Placeholder Title.md',
      mimeType: 'text/markdown',
    });
  });

  it('refuses with 401 before submitIngest when there is no session', async () => {
    const POST = await loadPost({ ingestAsync: 'on' });
    const response = await POST(request({ userId: USER_A }));
    expect(response.status).toBe(401);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it('refuses another user org with 403 before submitIngest', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_B }];
    const POST = await loadPost({ ingestAsync: 'on' });
    const response = await POST(request({ userId: USER_A, organizationId: ORG_X }));
    expect(response.status).toBe(403);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('with async off maps an inline ready result to 200 and does not wake', async () => {
    state.session = { id: USER_A };
    submitSpy.mockResolvedValueOnce(readyResult);
    const POST = await loadPost({ ingestAsync: 'off' });
    const response = await POST(request({}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      status: 'ready',
      documentId: DOCUMENT_ID,
      chunksStored: 1,
    });
    expect(wakeSpy).not.toHaveBeenCalled();
  });
});

describe('ai-to-rag native routing for text jobs', () => {
  const filename = 'Placeholder Title.md';
  const mimeType = 'text/markdown';
  const encoder = new TextEncoder();

  async function submitWithRouting(routing: 'fixed' | 'tiered'): Promise<JobSettingsSnapshot> {
    vi.resetModules();
    vi.stubEnv('RAG_INGEST_PIPELINE', 'unified');
    vi.stubEnv('RAG_INGEST_ASYNC', 'on');
    vi.stubEnv('RAG_PARSE_ROUTING', routing);
    const fakes = await import('../../helpers/ingest-fakes');
    const JOB_ROW = {
      id: JOB_ID,
      tenant_key: `u:${USER_A}`,
      kind: 'ingest',
      status: 'queued',
      stage: null,
      source: 'ai_to_rag',
      source_key: 'chat:chat-1/message:message-1',
      file_sha256: null,
      mime_type: mimeType,
      filename,
      original_ref: { bucket: 'rag-originals', path: 'queued/original' },
      document_id: DOCUMENT_ID,
      settings: {},
    };
    let captured: JobSettingsSnapshot | null = null;
    const { db: base, calls } = fakes.fakeIngestDb();
    const db = {
      rpc(fn: string, args?: Record<string, unknown>) {
        if (fn === 'rag_enqueue_ingestion_job') {
          captured = (args?.p_settings ?? {}) as JobSettingsSnapshot;
          return {
            abortSignal: () => db.rpc(fn, args),
            then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
              Promise.resolve({ data: [JOB_ROW], error: null }).then(onFulfilled, onRejected),
          } as never;
        }
        return base.rpc(fn, args ?? {});
      },
    };
    fakes.installIngestDeps({
      db,
      env: { RAG_INGEST_PIPELINE: 'unified' },
    });
    vi.stubEnv('RAG_INGEST_ASYNC', 'on');
    vi.stubEnv('RAG_PARSE_ROUTING', routing);
    const { submitIngest } = await import('@/lib/rag/ingest/enqueue');
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    await submitIngest({
      scope: mintScope('personal', USER_A, null),
      source: 'ai_to_rag',
      sourceKey: 'chat:chat-1/message:message-1',
      text: CONTENT,
      filename,
      mimeType,
      signal: new AbortController().signal,
    });
    fakes.uninstallIngestDeps();
    expect(captured).not.toBeNull();
    expect(fakes.callsOf(calls, 'rag_begin_document_version')).toHaveLength(1);
    return captured!;
  }

  it.each(['fixed', 'tiered'] as const)('under %s routing the job snapshot keeps markdown on the native text path', async (routing) => {
    const settings = await submitWithRouting(routing);
    expect(settings.routing).toBe(routing);
    expect(isTextLike(filename, mimeType)).toBe(true);
    const chain = buildParserChain(getProcessingProfile(settings.doc_type), { parser: 'llamaparse' }, { filename, mimeType });
    expect(chain.at(-1)).toBe('text');
    const parsed = parsePlainText({ filename, mimeType, bytes: encoder.encode(CONTENT) });
    expect(parsed.parser_version).toBe('native');
    expect(settings.premium_page_budget).toBe(0);
    expect(settings.vlm_detect).toBe(false);
    expect(settings.doc_type).toBe('general');
    expect(settings.min_tier).toBe('fast');
    expect(settings.max_tier).toBe('premium');
  });
});