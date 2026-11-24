import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildJobSettings } from '@/lib/rag/ingest/routing/settings-snapshot';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { effectiveTierBounds } from '@/lib/rag/ingest/routing/tier-bounds';
import { loadQueueConfig } from '@/lib/rag/ingest/queue-config';
import { profileFor } from '@/lib/rag/ingest/profiles/load';
import { enqueueIngest } from '@/lib/rag/ingest/enqueue';
import { setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { mintScope } from '@/lib/rag/tenant/scope';
import { setCaptionerForTests, resetCaptionerForTests } from '@/lib/rag/ingest/captioner';
import { callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps } from '../../helpers/ingest-fakes';
import type { EnqueueResult } from '@/lib/rag';

const ADMIN_A = '00000000-0000-4000-8000-0000000000a1';
const IMAGE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

const route = {
  pipeline: 'legacy' as 'legacy' | 'unified',
  asyncOn: false,
  configThrows: false,
  session: null as { id: string } | null,
  authThrows: false,
  uploads: [] as string[],
  submitCalls: 0,
  ingestCalls: 0,
  wakeCalls: 0,
  captionCalls: 0,
  afterCallbacks: [] as Array<() => unknown>,
  submitResults: [] as EnqueueResult[],
};

/** Mirrors D-12: whole images skip tiered preflight and use native captioning in the worker. */
function workerParsePlan(mimeType: string, routing: 'fixed' | 'tiered') {
  void routing;
  if (mimeType.startsWith('image/')) {
    return { mode: 'native' as const, docClass: 'image' as const };
  }
  return { mode: 'unsupported' as const, docClass: null };
}

function routeAdmin() {
  return {
    from: () => {
      const query = {
        select: () => query,
        order: () => query,
        limit: () => query,
        abortSignal: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: { read_only_doc_dashboard: false }, error: null }),
      };
      return query;
    },
    storage: {
      from: () => ({
        upload: async (path: string) => {
          route.uploads.push(path);
          return { data: { path }, error: null };
        },
      }),
    },
  };
}

async function loadUploadRoute() {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('RAG_INGEST_PIPELINE', route.pipeline);
  vi.stubEnv('RAG_INGEST_ASYNC', route.asyncOn ? 'on' : 'off');
  vi.doMock('@/lib/deployment-mode', () => ({
    isSingleTenant: () => true,
    isMultiTenant: () => false,
    getDeploymentMode: () => 'single-tenant',
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (route.authThrows) throw new Error('auth down');
          return { data: { user: route.session } };
        },
      },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: routeAdmin(), getSupabaseAdmin: () => routeAdmin() }));
  vi.doMock('@/lib/document-processor', () => ({
    processImageDocument: async () => undefined,
  }));
  vi.doMock('next/server', async (importOriginal) => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: (callback: () => unknown) => {
      route.afterCallbacks.push(callback);
    },
  }));
  const enqueueModule = await vi.importActual<typeof import('@/lib/rag/ingest/enqueue')>('@/lib/rag/ingest/enqueue');
  const wakeModule = await vi.importActual<typeof import('@/lib/rag/ingest/wake')>('@/lib/rag/ingest/wake');
  vi.doMock('@/lib/rag/ingest/wake', () => ({
    scheduleIngestWake: () => {
      route.wakeCalls += 1;
    },
  }));
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      currentIngestConfig: () => {
        if (route.configThrows) throw new Error('config unavailable');
        return { pipeline: route.pipeline };
      },
      ingest: async (...args: unknown[]) => {
        route.ingestCalls += 1;
        return actual.ingest(...(args as Parameters<typeof actual.ingest>));
      },
      submitIngest: async (...args: unknown[]) => {
        route.submitCalls += 1;
        const next = route.submitResults.shift();
        if (next) return next;
        return enqueueModule.submitIngest(...(args as Parameters<typeof enqueueModule.submitIngest>));
      },
      resolveTenantScope: actual.resolveTenantScope,
      repairOwnerMembership: actual.repairOwnerMembership,
      resolveAdminWorkspaceScope: actual.resolveAdminWorkspaceScope,
    };
  });
  const { setRagDepsForTests } = await import('@/lib/rag/deps');
  setRagDepsForTests({ adminClient: () => routeAdmin() as never });
  const { setIngestDepsForTests: setDeps } = await import('@/lib/rag/ingest/deps');
  setDeps({
    ingestEnv: () => {
      if (route.configThrows) throw new Error('config unavailable');
      return {
        RAG_INGEST_PIPELINE: route.pipeline,
        RAG_INGEST_ASYNC: route.asyncOn ? 'on' : 'off',
      };
    },
  });
  const module = await import('@/app/api/upload/route');
  return module.POST;
}

async function post(fields: Record<string, string> = {}) {
  const POST = await loadUploadRoute();
  const { NextRequest } = await import('next/server');
  const form = new FormData();
  form.append('files', new File([IMAGE], 'photo.png', { type: 'image/png' }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const request = new NextRequest('http://localhost/api/upload', { method: 'POST', body: form });
  return POST(request);
}

async function runAfter(): Promise<void> {
  for (const callback of route.afterCallbacks) await callback();
}

function resetRoute(): void {
  route.pipeline = 'legacy';
  route.asyncOn = false;
  route.configThrows = false;
  route.session = null;
  route.authThrows = false;
  route.uploads = [];
  route.submitCalls = 0;
  route.ingestCalls = 0;
  route.wakeCalls = 0;
  route.captionCalls = 0;
  route.afterCallbacks = [];
  route.submitResults = [];
}

beforeEach(() => {
  resetRoute();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  setCaptionerForTests(async () => {
    route.captionCalls += 1;
    return 'caption text';
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetCaptionerForTests();
  uninstallIngestDeps();
  const { resetIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  const { resetRagDepsForTests } = await import('@/lib/rag/deps');
  resetIngestDepsForTests();
  resetRagDepsForTests();
  vi.restoreAllMocks();
  for (const id of ['@/lib/deployment-mode', '@/lib/supabase/server', '@/lib/supabase', '@/lib/document-processor', 'next/server', '@/lib/rag', '@/lib/rag/ingest/wake']) {
    vi.doUnmock(id);
  }
});

describe('upload route async switch for knowledge-base images', () => {
  beforeEach(() => {
    route.pipeline = 'unified';
    route.session = { id: ADMIN_A };
  });

  it('with async on returns 202 with jobId before captioning and schedules one wake', async () => {
    route.asyncOn = true;
    route.submitResults = [{ jobId: 'job-img-1', documentId: 'doc-img-1', status: 'queued' }];
    const response = await post({ process_rag: 'true', image_context: 'Floor plan' });
    const body = await response.json();
    expect(response.status).toBe(202);
    expect(body).toMatchObject({ jobId: 'job-img-1', documentId: 'doc-img-1', status: 'queued' });
    expect(route.submitCalls).toBe(1);
    expect(route.ingestCalls).toBe(0);
    expect(route.captionCalls).toBe(0);
    expect(route.wakeCalls).toBe(1);
    expect(route.afterCallbacks).toEqual([]);
  });

  it('returns 401 with no session before submitIngest', async () => {
    route.asyncOn = true;
    route.session = null;
    const response = await post({ process_rag: 'true' });
    expect(response.status).toBe(401);
    expect(route.submitCalls).toBe(0);
    expect(route.wakeCalls).toBe(0);
    expect(route.uploads).toEqual([]);
  });

  it('with async off matches the unified after() ingest path', async () => {
    route.asyncOn = false;
    const { db } = fakeIngestDb();
    installIngestDeps({ db });
    route.submitResults = [{ jobId: 'job-never', documentId: 'doc-never', status: 'queued' }];
    const response = await post({ process_rag: 'true' });
    expect(response.status).toBe(200);
    expect(route.afterCallbacks).toHaveLength(1);
    expect(route.submitCalls).toBe(0);
    await runAfter();
    expect(route.ingestCalls).toBe(1);
    expect(route.wakeCalls).toBe(0);
  });
});

describe('enqueued image job snapshot and worker routing', () => {
  const scope = mintScope('single', null, null);
  const IMAGE_URL = 'https://project.example.test/storage/v1/object/public/chat-images/user-1/pic.png?download';

  afterEach(() => {
    setIngestDepsForTests({});
  });

  it('enqueue payload carries image mime and configured routing for fixed and tiered', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db, env: { RAG_INGEST_PIPELINE: 'unified', RAG_INGEST_ASYNC: 'on', RAG_PARSE_ROUTING: 'tiered' } });
    await enqueueIngest(
      {
        scope,
        source: 'image_upload',
        sourceKey: 'user/pic.png',
        file: IMAGE,
        filename: 'pic.png',
        mimeType: 'image/png',
        signal: new AbortController().signal,
        options: { imageUrl: IMAGE_URL },
      },
      {
        queueConfig: () =>
          loadQueueConfig({
            RAG_INGEST_PIPELINE: 'unified',
            RAG_INGEST_ASYNC: 'on',
            RAG_PARSE_ROUTING: 'tiered',
          }),
      },
    );
    const enqueue = callsOf(calls, 'rag_enqueue_ingestion_job')[0];
    expect(enqueue).toBeTruthy();
    expect(enqueue!.args.p_mime_type).toBe('image/png');
    const settings = enqueue!.args.p_settings as { routing: string };
    expect(settings.routing).toBe('tiered');

    resetRoute();
    const fixedDb = fakeIngestDb();
    installIngestDeps({ db: fixedDb.db, env: { RAG_INGEST_PIPELINE: 'unified', RAG_INGEST_ASYNC: 'on', RAG_PARSE_ROUTING: 'fixed' } });
    await enqueueIngest(
      {
        scope,
        source: 'image_upload',
        sourceKey: 'user/pic-fixed.png',
        file: IMAGE,
        filename: 'pic.png',
        mimeType: 'image/png',
        signal: new AbortController().signal,
        options: { imageUrl: IMAGE_URL },
      },
      {
        queueConfig: () =>
          loadQueueConfig({
            RAG_INGEST_PIPELINE: 'unified',
            RAG_INGEST_ASYNC: 'on',
            RAG_PARSE_ROUTING: 'fixed',
          }),
      },
    );
    const fixedEnqueue = callsOf(fixedDb.calls, 'rag_enqueue_ingestion_job')[0];
    expect((fixedEnqueue!.args.p_settings as { routing: string }).routing).toBe('fixed');
  });

  it('worker routing for images stays native with doc class image under fixed and tiered', () => {
    expect(workerParsePlan('image/png', 'fixed')).toEqual({ mode: 'native', docClass: 'image' });
    expect(workerParsePlan('image/jpeg', 'tiered')).toEqual({ mode: 'native', docClass: 'image' });
  });

  it('tiered job settings for an image never enable premium spend or VLM detect', async () => {
    const queueConfig = loadQueueConfig({
      RAG_INGEST_PIPELINE: 'unified',
      RAG_INGEST_ASYNC: 'on',
      RAG_PARSE_ROUTING: 'tiered',
      RAG_PARSE_PREMIUM_PAGE_BUDGET: '0',
      RAG_PARSE_VLM_DETECT: 'false',
    });
    const profile = profileFor('image_upload', 'general');
    const bounds = await effectiveTierBounds('general', { admin: () => null });
    const snapshot = buildJobSettings({
      queueConfig,
      profile,
      bounds,
      routingConfig: loadRoutingConfig(),
    });
    expect(snapshot.routing).toBe('tiered');
    expect(snapshot.vlm_detect).toBe(false);
    expect(snapshot.premium_page_budget).toBe(0);
    expect(workerParsePlan('image/png', 'tiered').mode).toBe('native');
  });
});