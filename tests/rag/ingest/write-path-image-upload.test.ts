import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingest, resumeIngest } from '@/lib/rag/ingest';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { resetCaptionerForTests, setCaptionerForTests } from '@/lib/rag/ingest/captioner';
import { getIngestDeps, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { profileFor } from '@/lib/rag/ingest/profiles/load';
import { imagesStage } from '@/lib/rag/ingest/stages/images';
import { parseStage } from '@/lib/rag/ingest/stages/parse';
import { emptyIngestState, type IngestResult, type StageContext } from '@/lib/rag/ingest/types';
import { createIngestWriter } from '@/lib/rag/ingest/writer';
import { resetInjectionRulesForTests } from '@/lib/rag/security/injection-scan';
import { mintScope } from '@/lib/rag/tenant/scope';
import { FAKE_DOCUMENT_ID, FAKE_LINEAGE_ID, callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps, type RecordedRpc } from '../../helpers/ingest-fakes';
import recorded from '../../fixtures/ingest/caption-recorded.json';

const scope = mintScope('single', null, null);
const IMAGE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const OTHER_IMAGE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9]);
const IMAGE_URL = 'https://project.example.test/storage/v1/object/public/chat-images/user-1/pic_1_abc.png?download';
const STORAGE_PATH = 'user-1/pic_1_abc.png';
const ORIGINAL_PATH = `s:default/${FAKE_LINEAGE_ID}/1/original.png`;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  resetCaptionerForTests();
  resetInjectionRulesForTests();
  uninstallIngestDeps();
  vi.restoreAllMocks();
});

function captionWith(text: string) {
  const seen: Array<{ bytes: Uint8Array; mimeType: string }> = [];
  setCaptionerForTests(async (bytes, mimeType) => {
    seen.push({ bytes, mimeType });
    return text;
  });
  return seen;
}

function uploadImage(overrides: Partial<Parameters<typeof ingest>[0]> = {}) {
  return ingest({
    scope,
    source: 'image_upload',
    sourceKey: STORAGE_PATH,
    file: IMAGE,
    filename: 'pic.png',
    mimeType: 'image/png',
    signal: new AbortController().signal,
    options: { imageUrl: IMAGE_URL, imageContext: 'Ground floor plan' },
    ...overrides,
  } as Parameters<typeof ingest>[0]);
}

const writtenChunks = (calls: RecordedRpc[]) => callsOf(calls, 'rag_write_chunks').flatMap((call) => call.args.p_chunks as Array<Record<string, any>>);
const fieldsSet = (calls: RecordedRpc[]) => callsOf(calls, 'rag_set_document_fields').map((call) => call.args.p_fields as Record<string, any>);

interface ParseCtx {
  ctx: StageContext;
  store: ReturnType<typeof installIngestDeps>;
  calls: RecordedRpc[];
}

/** A context at the parse stage of an image upload: identity, document and the stored original as the earlier stages leave them. */
function parseContext(overrides: { mimeType?: string; file?: Uint8Array; options?: Record<string, unknown>; text?: string; env?: Record<string, string> } = {}): ParseCtx {
  const { db, calls } = fakeIngestDb();
  const store = installIngestDeps({ db, ...(overrides.env ? { env: overrides.env } : {}) });
  const deps = getIngestDeps();
  const signal = new AbortController().signal;
  const profile = profileFor('image_upload', 'general');
  const ctx = {
    input: {
      scope,
      source: 'image_upload',
      sourceKey: STORAGE_PATH,
      ...(overrides.text !== undefined ? { text: overrides.text } : { file: overrides.file ?? IMAGE }),
      filename: 'pic.png',
      mimeType: overrides.mimeType ?? 'image/png',
      options: overrides.options ?? { imageUrl: IMAGE_URL, imageContext: 'Ground floor plan' },
      signal,
    },
    deps,
    writer: createIngestWriter({ db: deps.db()!, scope, signal }),
    config: loadIngestConfig(deps.ingestEnv()),
    signal,
    deadline: deps.now() + 50000,
    state: emptyIngestState(),
    warnings: [],
    identity: {
      tenantKey: 's:default',
      filename: 'pic.png',
      fileSha256: 'sha',
      docType: 'general',
      docTypeOrigin: 'fallback',
      profile,
      bytes: overrides.text !== undefined ? null : (overrides.file ?? IMAGE),
    },
    document: { id: FAKE_DOCUMENT_ID, version: 1, lineageId: FAKE_LINEAGE_ID, resumed: false },
    parserUsed: null,
    work: { parseText: null, parserVersion: null, chunks: [], chunksWritten: 0 },
  } as unknown as StageContext;
  return { ctx, store, calls };
}

describe('parse stage: a whole image', () => {
  it('yields an empty Markdown, one picture that refers to the original, parser text and version image, and keeps no parser call', async () => {
    const { ctx, store } = parseContext();
    const outcome = await parseStage.run(ctx);

    expect(outcome).toEqual({ kind: 'next' });
    expect(ctx.work.parseText).toBe('');
    expect(ctx.work.parseChunks ?? null).toBeNull();
    expect(ctx.work.pictures).toEqual([{ bbox: [0, 0, 1, 1], image_ref: 'original.png', page: 1, page_area_share: 1 }]);
    expect(ctx.parserUsed).toBe('text');
    expect(ctx.work.parserVersion).toBe('image');
    expect(store.keys()).toEqual([`s:default/${FAKE_LINEAGE_ID}/1/parse.md`]);
  });

  it('keeps what the images stage needs in the state slice, so a resumed run does not need the options', async () => {
    const { ctx } = parseContext({ mimeType: 'image/jpeg' });
    await parseStage.run(ctx);
    expect(ctx.state.images).toEqual({ nextIndex: 0, captioned: 0, imageUrl: IMAGE_URL, imageContext: 'Ground floor plan', mimeType: 'image/jpeg' });
  });

  it('fails a run whose file is not an image, or whose image has no usable public URL, before anything is captioned', async () => {
    const pdf = parseContext({ mimeType: 'application/pdf' });
    expect(await parseStage.run(pdf.ctx)).toEqual({ kind: 'fail', reason: 'not_an_image' });

    const text = parseContext({ text: 'plain words' });
    expect(await parseStage.run(text.ctx)).toEqual({ kind: 'fail', reason: 'not_an_image' });

    for (const imageUrl of [undefined, '', 'javascript:alert(1)', 'ftp://example.test/a.png', 'not a url', `https://example.test/${'a'.repeat(2100)}`]) {
      const bad = parseContext({ options: { imageUrl } });
      expect(await parseStage.run(bad.ctx), String(imageUrl)).toEqual({ kind: 'fail', reason: 'image_url_invalid' });
    }
  });
});

describe('an image upload through ingest()', () => {
  it('ends ready with one image chunk: the caption as content, kind image, page 1, the public URL in its metadata and the promoted columns', async () => {
    const seen = captionWith(recorded.captions.chart);
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await uploadImage();

    expect(result).toMatchObject({ status: 'ready', parserUsed: 'text', chunkCount: 1 });
    expect(seen).toHaveLength(1);
    expect(Array.from(seen[0]!.bytes)).toEqual(Array.from(IMAGE));
    expect(seen[0]!.mimeType).toBe('image/png');
    const chunks = writtenChunks(calls);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      content: recorded.captions.chart,
      chunk_index: 0,
      chunk_kind: 'image',
      section_path: [],
      page_start: 1,
      page_end: 1,
    });
    expect(chunks[0]!.metadata).toMatchObject({
      image_url: IMAGE_URL,
      image_type: 'image/png',
      image_context: 'Ground floor plan',
      document_title: 'pic.png',
      chunk_index: 0,
      chunk_position: 1,
      total_chunks: 1,
    });
    expect(typeof chunks[0]!.content_hash).toBe('string');
    expect(String(chunks[0]!.lexical_text)).toContain('quarterly');
    expect(fieldsSet(calls)).toContainEqual({ parser_used: 'text', parser_version: 'image' });
    expect(fieldsSet(calls).some((fields) => fields.language !== undefined)).toBe(true);
  });

  it('keeps the image_caption chunker whatever type was picked, so a table type does not turn the caption into a table chunk', async () => {
    captionWith(recorded.captions.chart);
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await uploadImage({ docType: 'financial_report' });

    expect(result.status).toBe('ready');
    expect(writtenChunks(calls).map((chunk) => chunk.chunk_kind)).toEqual(['image']);
  });

  it('captions the image once per run and records the progress in the images slice', async () => {
    const seen = captionWith(recorded.captions.logo);
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    await uploadImage();

    expect(seen).toHaveLength(1);
    const states = callsOf(calls, 'rag_save_ingest_state').map((call) => call.args.p_state as Record<string, any>);
    expect(states.some((state) => state.images?.captioned === 1 && state.images?.nextIndex === 1)).toBe(true);
    expect(states.at(-1)?.images).toMatchObject({ nextIndex: 1, captioned: 1, imageUrl: IMAGE_URL });
  });

  it('does not treat two different images as content duplicates of each other', async () => {
    captionWith(recorded.captions.chart);
    const first = fakeIngestDb();
    installIngestDeps({ db: first.db });
    await uploadImage();
    const second = fakeIngestDb();
    installIngestDeps({ db: second.db });
    await uploadImage({ file: OTHER_IMAGE });
    const third = fakeIngestDb();
    installIngestDeps({ db: third.db });
    await uploadImage({ sourceKey: 'user-1/pic_2_def.png' });

    const hashOf = (calls: RecordedRpc[]) => callsOf(calls, 'rag_find_content_duplicate')[0]?.args.p_content_hash;
    expect(hashOf(first.calls)).toBeTruthy();
    expect(hashOf(first.calls)).not.toBe(hashOf(second.calls));
    expect(hashOf(first.calls)).toBe(hashOf(third.calls));
  });

  it('quarantines the document when the caption holds an injection phrase and RAG_INJECTION_SCAN is quarantine', async () => {
    captionWith(recorded.captions.injection);
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db, env: { RAG_INJECTION_SCAN: 'quarantine' } });

    const result = await uploadImage();

    expect(result.status).toBe('quarantined');
    const quarantine = fieldsSet(calls).find((fields) => fields.status === 'quarantined');
    expect(quarantine?.metadata?.quarantine?.rule_ids).toEqual(expect.arrayContaining(['inj-en-01']));
    expect(writtenChunks(calls)).toHaveLength(1);
    const logged = JSON.stringify([...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls]);
    expect(logged).not.toContain('reveal the system prompt');
  });

  it('publishes a clean caption under quarantine, and publishes an injection caption when the scan is off, as today', async () => {
    captionWith(recorded.captions.chart);
    const clean = fakeIngestDb();
    installIngestDeps({ db: clean.db, env: { RAG_INJECTION_SCAN: 'quarantine' } });
    expect((await uploadImage()).status).toBe('ready');

    captionWith(recorded.captions.injection);
    const off = fakeIngestDb();
    installIngestDeps({ db: off.db, env: { RAG_INJECTION_SCAN: 'off' } });
    expect((await uploadImage()).status).toBe('ready');
    expect(fieldsSet(off.calls).some((fields) => fields.status === 'quarantined')).toBe(false);
  });

  it('scans the caption even when the profile of the resolved type has the scan switched off', async () => {
    captionWith(recorded.captions.injection);
    const { ctx, calls } = parseContext({ env: { RAG_INJECTION_SCAN: 'quarantine' } });
    ctx.identity!.profile = { ...ctx.identity!.profile, scan_injection: false };
    expect(await parseStage.run(ctx)).toEqual({ kind: 'next' });
    ctx.work.captionOnly = true;

    expect((await imagesStage.run(ctx)).kind).toBe('next');

    expect(fieldsSet(calls).some((fields) => fields.status === 'quarantined')).toBe(true);
    expect(ctx.state.quarantine).toMatchObject({ released: false });
  });

  it('fails with caption_failed and writes no chunk when the vision call fails', async () => {
    setCaptionerForTests(async () => {
      throw new Error('vision down');
    });
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await uploadImage();

    expect(result).toMatchObject({ status: 'failed', reason: 'caption_failed' });
    expect(callsOf(calls, 'rag_write_chunks')).toHaveLength(0);
    expect(callsOf(calls, 'rag_mark_document_failed').map((call) => call.args.p_reason)).toEqual(['caption_failed']);
  });

  it('yields before the vision call when too little of the request budget is left, and captions nothing', async () => {
    const seen = captionWith(recorded.captions.chart);
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await uploadImage({ deadlineMs: 3000 });

    expect(result).toMatchObject({ status: 'processing', reason: 'deadline' });
    expect(seen).toHaveLength(0);
    expect(callsOf(calls, 'rag_write_chunks')).toHaveLength(0);
  });

  it('leaves documents that are not images on the switch behaviour of the images stage', async () => {
    const seen = captionWith(recorded.captions.chart);
    const { db } = fakeIngestDb();
    installIngestDeps({ db, env: { RAG_PDF_IMAGE_CHUNKS: 'true' } });

    const result: IngestResult = await ingest({
      scope,
      source: 'config_upload',
      sourceKey: 'root/handbook.md',
      text: '# Handbook\n\nThe night crew scans every pallet at the dock and stages it beside bay four.\n',
      filename: 'handbook.md',
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('ready');
    expect(result.warnings).toContain('image_chunks_unavailable');
    expect(seen).toHaveLength(0);
  });
});

describe('a resumed image upload', () => {
  function resumeDb(state: Record<string, unknown>) {
    return fakeIngestDb({
      document: {
        status: 'processing',
        version: 1,
        processing_status: 'processing',
        processing_state: state,
        filename: 'pic.png',
        doc_type: 'general',
        parser_used: 'text',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      origin: { lineage_id: FAKE_LINEAGE_ID, original_path: ORIGINAL_PATH, source: 'image_upload', source_key: STORAGE_PATH },
    });
  }

  it('does not caption a second time, and writes the same image chunk as an uninterrupted run', async () => {
    let clock = 0;
    const seen: string[] = [];
    setCaptionerForTests(async () => {
      seen.push('call');
      clock += 49000;
      return recorded.captions.chart;
    });
    const first = fakeIngestDb();
    const store = installIngestDeps({ db: first.db, now: () => clock });

    const interrupted = await uploadImage();
    expect(interrupted).toMatchObject({ status: 'processing', reason: 'deadline' });
    expect(callsOf(first.calls, 'rag_write_chunks')).toHaveLength(0);
    expect(store.keys().some((key) => key.endsWith('/caption-1.txt'))).toBe(true);
    const saved = callsOf(first.calls, 'rag_save_ingest_state').at(-1)!.args.p_state as Record<string, unknown>;
    expect(saved.lastCompleted).toBe('images');

    const second = resumeDb(saved);
    setIngestDepsForTests({ db: () => second.db, now: () => clock });
    clock += 1_000_000;
    const resumed = await resumeIngest(scope, FAKE_DOCUMENT_ID);

    expect(resumed.status).toBe('ready');
    expect(seen).toHaveLength(1);
    const chunks = writtenChunks(second.calls);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ content: recorded.captions.chart, chunk_kind: 'image', page_start: 1 });
    expect(chunks[0]!.metadata).toMatchObject({ image_url: IMAGE_URL, image_type: 'image/png', image_context: 'Ground floor plan' });
  });

  it('captions once more only when the stored caption is gone, from the stored original and without the upload', async () => {
    const seen = captionWith(recorded.captions.logo);
    const { db, calls } = resumeDb({
      lastCompleted: 'extract',
      images: { nextIndex: 0, captioned: 0, imageUrl: IMAGE_URL, mimeType: 'image/png' },
    });
    const store = installIngestDeps({ db });
    await store.put(ORIGINAL_PATH, IMAGE, { contentType: 'image/png' });
    await store.put(ORIGINAL_PATH.replace('original.png', 'parse.md'), new Uint8Array(0), { contentType: 'text/markdown' });

    const result = await resumeIngest(scope, FAKE_DOCUMENT_ID);

    expect(result.status).toBe('ready');
    expect(seen).toHaveLength(1);
    expect(Array.from(seen[0]!.bytes)).toEqual(Array.from(IMAGE));
    expect(writtenChunks(calls)[0]).toMatchObject({ content: recorded.captions.logo, chunk_kind: 'image' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The upload route: the unified branch after the session check, with scope resolution and after()
// ---------------------------------------------------------------------------------------------------------------------

const ADMIN_A = '00000000-0000-4000-8000-0000000000a1';
const ADMIN_B = '00000000-0000-4000-8000-0000000000a2';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const PUBLIC_BASE = 'https://project.example.test';

type Mode = 'single-tenant' | 'multi-tenant';
type Pipeline = 'legacy' | 'unified';

const route = {
  mode: 'single-tenant' as Mode,
  pipeline: 'legacy' as Pipeline,
  configThrows: false,
  session: null as { id: string } | null,
  authThrows: false,
  getUserCalls: 0,
  uploads: [] as string[],
  admins: [] as string[],
  adminQueries: 0,
  adminLookupFails: false,
  members: [] as Array<{ organization_id: string; user_id: string }>,
  readOnly: false,
  processed: [] as Array<{ name: string; metadata: Record<string, unknown> }>,
  ingested: [] as Array<Record<string, any>>,
  afterCallbacks: [] as Array<() => unknown>,
  tenantOverride: null as null | { ok: true; scope: null },
  adminScopeCalls: [] as Array<Record<string, unknown>>,
  tenantCalls: [] as Array<Record<string, unknown>>,
};

function routeAdmin() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        order: () => query,
        limit: () => query,
        abortSignal: () => query,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return query;
        },
        maybeSingle() {
          if (table === 'organization_members') {
            const row = route.members.find((member) => member.organization_id === filters.organization_id && member.user_id === filters.user_id);
            return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
          }
          if (table === 'admin_users') {
            route.adminQueries += 1;
            if (route.adminLookupFails) return Promise.resolve({ data: null, error: { message: 'down' } });
            return Promise.resolve({ data: route.admins.includes(filters.id as string) ? { id: filters.id } : null, error: null });
          }
          if (table === 'admin_settings') return Promise.resolve({ data: { read_only_doc_dashboard: route.readOnly }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
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
  vi.doMock('@/lib/deployment-mode', () => ({
    isSingleTenant: () => route.mode === 'single-tenant',
    isMultiTenant: () => route.mode === 'multi-tenant',
    getDeploymentMode: () => route.mode,
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          route.getUserCalls += 1;
          if (route.authThrows) throw new Error('auth down');
          return { data: { user: route.session } };
        },
      },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: routeAdmin(), getSupabaseAdmin: () => routeAdmin() }));
  vi.doMock('@/lib/document-processor', () => ({
    processImageDocument: async (name: string, _buffer: Buffer, metadata: Record<string, unknown>) => {
      route.processed.push({ name, metadata });
      return 'legacy-doc';
    },
  }));
  vi.doMock('next/server', async (importOriginal) => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: (callback: () => unknown) => {
      route.afterCallbacks.push(callback);
    },
  }));
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      ingest: async (input: Record<string, any>) => {
        route.ingested.push(input);
        return { status: 'ready', documentId: 'doc-1', version: 1, parserUsed: 'text', chunkCount: 1, warnings: [] };
      },
      resolveAdminWorkspaceScope: (input: Record<string, unknown>) => {
        route.adminScopeCalls.push(input);
        return (actual.resolveAdminWorkspaceScope as (i: unknown) => unknown)(input);
      },
      resolveTenantScope: (input: Record<string, unknown>) => {
        route.tenantCalls.push(input);
        return route.tenantOverride ?? (actual.resolveTenantScope as (i: unknown) => unknown)(input);
      },
    };
  });
  const { setRagDepsForTests } = await import('@/lib/rag/deps');
  setRagDepsForTests({ adminClient: () => routeAdmin() as never });
  const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  setIngestDepsForTests({
    ingestEnv: () => {
      if (route.configThrows) throw new Error('config unavailable');
      return { RAG_INGEST_PIPELINE: route.pipeline };
    },
  });
  const module = await import('@/app/api/upload/route');
  const rag = await import('@/lib/rag');
  const admin = await import('@/lib/admin-session');
  return { POST: module.POST, rag, admin };
}

interface PostOptions {
  cookie?: string;
  fileName?: string;
  fileType?: string;
  file?: Uint8Array;
}

async function post(fields: Record<string, string> = {}, options: PostOptions = {}) {
  const loaded = await loadUploadRoute();
  const { NextRequest } = await import('next/server');
  const form = new FormData();
  form.append('files', new File([new Uint8Array(options.file ?? IMAGE)], options.fileName ?? 'photo.png', { type: options.fileType ?? 'image/png' }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const request = new NextRequest('http://localhost/api/upload', {
    method: 'POST',
    body: form,
    headers: options.cookie ? { cookie: options.cookie } : {},
  });
  return { response: await loaded.POST(request), ...loaded };
}

async function runAfter(): Promise<void> {
  for (const callback of route.afterCallbacks) await callback();
}

function resetRoute(): void {
  route.mode = 'single-tenant';
  route.pipeline = 'legacy';
  route.configThrows = false;
  route.session = null;
  route.authThrows = false;
  route.getUserCalls = 0;
  route.uploads = [];
  route.admins = [];
  route.adminQueries = 0;
  route.adminLookupFails = false;
  route.members = [];
  route.readOnly = false;
  route.processed = [];
  route.ingested = [];
  route.afterCallbacks = [];
  route.tenantOverride = null;
  route.adminScopeCalls = [];
  route.tenantCalls = [];
}

function ingestedScopeKey(rag: { scopeKey: (scope: never) => string }): string {
  expect(route.ingested).toHaveLength(1);
  return rag.scopeKey(route.ingested[0]!.scope as never);
}

function nothingReached(): void {
  expect(route.uploads).toEqual([]);
  expect(route.processed).toEqual([]);
  expect(route.ingested).toEqual([]);
  expect(route.afterCallbacks).toEqual([]);
  expect(route.adminScopeCalls).toEqual([]);
  expect(route.tenantCalls).toEqual([]);
}

describe('upload route', () => {
  beforeEach(() => {
    resetRoute();
  });

  afterEach(async () => {
    const { resetIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
    const { resetRagDepsForTests } = await import('@/lib/rag/deps');
    resetIngestDepsForTests();
    resetRagDepsForTests();
    for (const id of ['@/lib/deployment-mode', '@/lib/supabase/server', '@/lib/supabase', '@/lib/document-processor', 'next/server', '@/lib/rag']) {
      vi.doUnmock(id);
    }
  });

  describe.each([
    ['single-tenant', 'legacy'],
    ['single-tenant', 'unified'],
    ['multi-tenant', 'legacy'],
    ['multi-tenant', 'unified'],
  ] as const)('%s, %s pipeline, without a usable session', (mode, pipeline) => {
    beforeEach(() => {
      route.mode = mode;
      route.pipeline = pipeline;
    });

    it('answers 401 with no session and reaches no storage, no legacy processing, no scope, no ingest and no after()', async () => {
      const { response } = await post({ process_rag: 'true' });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Authentication required' });
      nothingReached();
      expect(route.adminQueries).toBe(0);
    });

    it('answers 503 when the session lookup throws and reaches nothing', async () => {
      route.authThrows = true;
      const { response } = await post({ process_rag: 'true' });
      expect(response.status).toBe(503);
      nothingReached();
    });

    it('a valid signed admin cookie never stands in for the missing session: 401 and no admin_users lookup', async () => {
      const probe = await loadUploadRoute();
      const cookie = `admin_session=${probe.admin.mintAdminSessionValue(ADMIN_A)!}`;
      route.admins = [ADMIN_A];
      const { response } = await post({ process_rag: 'true', upload_source: 'config_upload' }, { cookie });
      expect(response.status).toBe(401);
      nothingReached();
      expect(route.adminQueries).toBe(0);
    });
  });

  describe('legacy pipeline', () => {
    it('calls processImageDocument as today with the session user and the storage path, and never ingest or after()', async () => {
      route.session = { id: ADMIN_A };
      const { response } = await post({ process_rag: 'true', image_context: 'Ground floor plan', sessionId: 'someone-else' });
      expect(response.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(route.processed).toHaveLength(1);
      expect(route.processed[0]!.name).toBe('photo.png');
      expect(route.processed[0]!.metadata).toMatchObject({
        user_id: ADMIN_A,
        source: 'upload',
        image_type: 'image/png',
        image_context: 'Ground floor plan',
        source_file_id: route.uploads[0],
      });
      expect(String(route.processed[0]!.metadata.image_url)).toContain(`/chat-images/${ADMIN_A}/`);
      expect(route.ingested).toEqual([]);
      expect(route.afterCallbacks).toEqual([]);
    });

    it('ignores upload_source and never calls checkAdmin (multi-tenant)', async () => {
      route.mode = 'multi-tenant';
      route.session = { id: ADMIN_A };
      route.admins = [ADMIN_A];
      const { response } = await post({ process_rag: 'true', upload_source: 'config_upload' });
      expect(response.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(route.adminQueries).toBe(0);
      expect(route.adminScopeCalls).toEqual([]);
      expect(route.tenantCalls).toEqual([]);
      expect(route.processed).toHaveLength(1);
      expect(route.ingested).toEqual([]);
    });

    it('falls back to the legacy path when the ingest switch cannot be read', async () => {
      route.session = { id: ADMIN_A };
      route.pipeline = 'unified';
      route.configThrows = true;
      const { response } = await post({ process_rag: 'true' });
      expect(response.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(route.processed).toHaveLength(1);
      expect(route.afterCallbacks).toEqual([]);
    });
  });

  describe('unified pipeline, scope resolution', () => {
    beforeEach(() => {
      route.pipeline = 'unified';
      route.session = { id: ADMIN_A };
    });

    it('multi-tenant, no organization: ingest gets the personal scope of the session user', async () => {
      route.mode = 'multi-tenant';
      const { response, rag } = await post({ process_rag: 'true' });
      expect(response.status).toBe(200);
      expect(route.afterCallbacks).toHaveLength(1);
      await runAfter();
      expect(ingestedScopeKey(rag)).toBe(`u:${ADMIN_A}`);
    });

    it('multi-tenant, a member organization: ingest gets the organization scope', async () => {
      route.mode = 'multi-tenant';
      route.members = [{ organization_id: ORG_O, user_id: ADMIN_A }];
      const { response, rag } = await post({ process_rag: 'true', organization_id: ORG_O });
      expect(response.status).toBe(200);
      await runAfter();
      expect(ingestedScopeKey(rag)).toBe(`o:${ORG_O}`);
    });

    it('multi-tenant, a non-member organization: 403 before any storage write, and nothing is scheduled', async () => {
      route.mode = 'multi-tenant';
      const { response } = await post({ process_rag: 'true', organization_id: ORG_O });
      expect(response.status).toBe(403);
      expect(route.uploads).toEqual([]);
      expect(route.afterCallbacks).toEqual([]);
      expect(route.ingested).toEqual([]);
    });

    it('single-tenant with a session: ingest gets s:default', async () => {
      const { response, rag } = await post({ process_rag: 'true' });
      expect(response.status).toBe(200);
      await runAfter();
      expect(ingestedScopeKey(rag)).toBe('s:default');
    });

    it('a null scope is a 401 before any storage write and schedules nothing', async () => {
      route.mode = 'multi-tenant';
      route.tenantOverride = { ok: true, scope: null };
      const { response } = await post({ process_rag: 'true' });
      expect(response.status).toBe(401);
      expect(route.uploads).toEqual([]);
      expect(route.afterCallbacks).toEqual([]);
    });

    it('looks the session up once for the scope: the verified user is passed on, not looked up again', async () => {
      route.mode = 'multi-tenant';
      const { response } = await post({ process_rag: 'true' });
      expect(response.status).toBe(200);
      expect(route.getUserCalls).toBe(1);
    });
  });

  describe('unified pipeline, storage and background ingest', () => {
    beforeEach(() => {
      route.pipeline = 'unified';
      route.session = { id: ADMIN_A };
      route.mode = 'multi-tenant';
    });

    it('keeps the session-user storage prefix, ignores a client sessionId, and ingests the stored path with the public URL and the bytes', async () => {
      const { response } = await post({ process_rag: 'true', image_context: 'Ground floor plan', sessionId: 'victim/../other' });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(route.uploads).toHaveLength(1);
      expect(route.uploads[0]!.startsWith(`${ADMIN_A}/`)).toBe(true);
      expect(route.uploads[0]).not.toContain('victim');
      expect(body.files[0].filePath).toBe(route.uploads[0]);

      const getUserBefore = route.getUserCalls;
      expect(route.afterCallbacks).toHaveLength(1);
      expect(route.ingested).toEqual([]);
      await runAfter();

      expect(route.getUserCalls).toBe(getUserBefore);
      expect(route.ingested).toHaveLength(1);
      const input = route.ingested[0]!;
      expect(input).toMatchObject({ source: 'image_upload', sourceKey: route.uploads[0], filename: 'photo.png', mimeType: 'image/png' });
      expect(Array.from(input.file as Uint8Array)).toEqual(Array.from(IMAGE));
      expect(input.options).toMatchObject({ imageUrl: body.files[0].downloadUrl, imageContext: 'Ground floor plan' });
      expect(String(input.options.imageUrl)).toContain(`/chat-images/${ADMIN_A}/`);
      expect(input.signal).toBeInstanceOf(AbortSignal);
      expect(input.deadlineMs).toBeGreaterThan(0);
      expect(input.deadlineMs).toBeLessThanOrEqual(60000);
    });

    it('schedules nothing when process_rag is not true, and nothing for a file that is not an image, and keeps the response shape', async () => {
      const plain = await post({});
      expect(plain.response.status).toBe(200);
      expect(Object.keys(await plain.response.json()).sort()).toEqual(['files', 'success', 'total', 'uploaded']);
      expect(route.afterCallbacks).toEqual([]);

      const pdf = await post({ process_rag: 'true' }, { fileName: 'notes.pdf', fileType: 'application/pdf' });
      expect(pdf.response.status).toBe(200);
      expect(route.afterCallbacks).toEqual([]);
      expect(route.ingested).toEqual([]);
      expect(route.uploads).toHaveLength(2);
    });

    it('returns the same response shape as the legacy pipeline', async () => {
      const { response } = await post({ process_rag: 'true' });
      const body = await response.json();
      expect(Object.keys(body).sort()).toEqual(['files', 'success', 'total', 'uploaded']);
      expect(body).toMatchObject({ success: true, uploaded: 1, total: 1 });
      expect(Object.keys(body.files[0]).sort()).toEqual(['downloadUrl', 'fileName', 'filePath', 'originalName', 'size', 'type', 'uploadedAt']);
    });
  });

  describe('unified pipeline, Config UI uploads (upload_source=config_upload)', () => {
    beforeEach(() => {
      route.pipeline = 'unified';
      route.mode = 'multi-tenant';
      route.admins = [ADMIN_A, ADMIN_B];
    });

    async function cookieFor(adminId: string): Promise<string> {
      const { mintAdminSessionValue } = await import('@/lib/admin-session');
      return `admin_session=${mintAdminSessionValue(adminId)!}`;
    }

    it('admin A with a valid signed cookie for A and the session of A gets the admin workspace scope; the storage prefix stays the session user', async () => {
      route.session = { id: ADMIN_A };
      const { response, rag } = await post({ process_rag: 'true', upload_source: 'config_upload' }, { cookie: await cookieFor(ADMIN_A) });
      expect(response.status).toBe(200);
      expect(route.adminScopeCalls).toHaveLength(1);
      expect(route.adminScopeCalls[0]).toMatchObject({ adminUserId: ADMIN_A });
      expect(route.tenantCalls).toEqual([]);
      expect(route.uploads[0]!.startsWith(`${ADMIN_A}/`)).toBe(true);
      await runAfter();
      expect(ingestedScopeKey(rag)).toBe(`u:${ADMIN_A}`);
    });

    it('the session of admin A alone, with no cookie, also gets the admin workspace scope', async () => {
      route.session = { id: ADMIN_A };
      const { response } = await post({ process_rag: 'true', upload_source: 'config_upload' });
      expect(response.status).toBe(200);
      expect(route.adminScopeCalls).toHaveLength(1);
      expect(route.adminScopeCalls[0]).toMatchObject({ adminUserId: ADMIN_A });
      expect(route.uploads[0]!.startsWith(`${ADMIN_A}/`)).toBe(true);
    });

    it('an admin workspace organization is honoured only after the membership check', async () => {
      route.session = { id: ADMIN_A };
      const refused = await post({ process_rag: 'true', upload_source: 'config_upload', organization_id: ORG_O });
      expect(refused.response.status).toBe(403);
      expect(route.uploads).toEqual([]);
      expect(route.afterCallbacks).toEqual([]);

      route.members = [{ organization_id: ORG_O, user_id: ADMIN_A }];
      const allowed = await post({ process_rag: 'true', upload_source: 'config_upload', organization_id: ORG_O });
      expect(allowed.response.status).toBe(200);
      await runAfter();
      expect(ingestedScopeKey(allowed.rag)).toBe(`o:${ORG_O}`);
    });

    it('a bare admin UUID and a cookie with a tampered signature, with a non-admin session, give the session scope and never the admin scope', async () => {
      route.session = { id: USER_B };
      const signed = (await cookieFor(ADMIN_A)).replace('admin_session=', '');
      const [id, expiry, signature] = signed.split('.');
      const flipped = `${signature!.slice(0, -1)}${signature!.endsWith('A') ? 'B' : 'A'}`;
      for (const cookie of [`admin_session=${ADMIN_A}`, `admin_session=${id}.${expiry}.${flipped}`]) {
        route.adminScopeCalls = [];
        route.tenantCalls = [];
        route.uploads = [];
        const { response } = await post({ process_rag: 'true', upload_source: 'config_upload' }, { cookie });
        expect(response.status).toBe(200);
        expect(route.adminScopeCalls).toEqual([]);
        expect(route.tenantCalls).toHaveLength(1);
        expect(route.uploads[0]!.startsWith(`${USER_B}/`)).toBe(true);
      }
    });

    it('a non-admin session sending upload_source=config_upload gets the session scope', async () => {
      route.session = { id: USER_B };
      const { response, rag } = await post({ process_rag: 'true', upload_source: 'config_upload' });
      expect(response.status).toBe(200);
      expect(route.adminScopeCalls).toEqual([]);
      expect(route.tenantCalls).toHaveLength(1);
      await runAfter();
      expect(ingestedScopeKey(rag)).toBe(`u:${USER_B}`);
    });

    it('a valid cookie for admin A sent with the session of non-admin B gives B the session scope and B storage prefix', async () => {
      route.session = { id: USER_B };
      const { response, rag } = await post({ process_rag: 'true', upload_source: 'config_upload' }, { cookie: await cookieFor(ADMIN_A) });
      expect(response.status).toBe(200);
      expect(route.adminScopeCalls).toEqual([]);
      expect(route.uploads[0]!.startsWith(`${USER_B}/`)).toBe(true);
      await runAfter();
      expect(ingestedScopeKey(rag)).toBe(`u:${USER_B}`);
    });

    it('a failing admin_users lookup answers 503 before any storage write, and nothing is ingested or scheduled', async () => {
      route.session = { id: ADMIN_A };
      route.adminLookupFails = true;
      const { response } = await post({ process_rag: 'true', upload_source: 'config_upload' });
      expect(response.status).toBe(503);
      expect(route.uploads).toEqual([]);
      expect(route.afterCallbacks).toEqual([]);
      expect(route.ingested).toEqual([]);
    });

    it('an upload without upload_source never calls checkAdmin', async () => {
      route.session = { id: ADMIN_A };
      const { response } = await post({ process_rag: 'true' });
      expect(response.status).toBe(200);
      expect(route.adminQueries).toBe(0);
      expect(route.adminScopeCalls).toEqual([]);
      expect(route.tenantCalls).toHaveLength(1);
    });
  });
});
