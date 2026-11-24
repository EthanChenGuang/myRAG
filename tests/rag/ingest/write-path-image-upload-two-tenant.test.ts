import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS } from '../../../eval/harness/two-tenant.mts';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';
import recorded from '../../fixtures/ingest/caption-recorded.json';

const h = await vi.hoisted(async () => {
  const session: { userId: string | null } = { userId: null };
  return {
    session,
    uploads: [] as string[],
    adminOverride: null as unknown,
    after: [] as Array<() => unknown>,
    processed: [] as string[],
    ssr: {
      auth: {
        getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }),
      },
    },
  };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
// The fixture database has no admin tables; the write-access rules are covered in tests/api/upload-route.test.ts.
vi.mock('@/lib/kb-write-access', () => ({ checkSingleTenantKbWrite: async () => ({ ok: true, isAdmin: false }) }));
vi.mock('@/lib/document-processor', () => ({
  processImageDocument: async (name: string) => {
    h.processed.push(name);
    return 'legacy-document';
  },
}));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (callback: () => unknown) => {
    h.after.push(callback);
  },
}));
// Storage objects go to a recorder; every database call keeps going to the fixture database. Registered per fixture start so each
// run wraps the Supabase module of its own module graph (and its own fake edge URL).
async function supabaseMock(importOriginal: () => Promise<typeof import('@/lib/supabase')>) {
  const actual = await importOriginal();
  const supabaseAdmin = new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      if (property === 'storage') {
        return {
          from: () => ({
            upload: async (path: string) => {
              h.uploads.push(path);
              return { data: { path }, error: null };
            },
          }),
        };
      }
      const real = actual.getSupabaseAdmin() as unknown as Record<string | symbol, unknown> | null;
      const value = real?.[property];
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(real) : value;
    },
  });
  return { ...actual, supabaseAdmin, getSupabaseAdmin: () => h.adminOverride ?? actual.getSupabaseAdmin() };
}

const { userA, userB, orgO } = TWO_TENANT_IDS;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const OTHER_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 5, 6, 7, 8]);
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };

type Post = (req: Request) => Promise<Response>;
type Get = (req: Request) => Promise<Response>;

interface Loaded {
  fixture: RouteFixture;
  db: PGlite;
  post: Post;
  images: { GET: Get };
  captions: Map<number, string>;
  rag: typeof import('@/lib/rag');
}

function uploadRequest(fields: Record<string, string>, bytes: Uint8Array, fileName: string): Request {
  const form = new FormData();
  form.append('files', new File([new Uint8Array(bytes)], fileName, { type: 'image/png' }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request('http://localhost/api/upload', { method: 'POST', body: form });
}

async function start(deploymentMode: 'single-tenant' | 'multi-tenant'): Promise<Loaded> {
  vi.stubEnv('RAG_INGEST_PIPELINE', 'unified');
  let db: PGlite | null = null;
  const fixture = await startRouteFixture({
    deploymentMode,
    ...(deploymentMode === 'multi-tenant' ? { twoTenant: true } : {}),
    seed: async (database) => {
      db = database;
    },
  });
  process.env.RAG_INGEST_PIPELINE = 'unified';
  vi.doMock('@/lib/supabase', () => supabaseMock(() => vi.importActual<typeof import('@/lib/supabase')>('@/lib/supabase')));
  const { POST } = await fixture.loadRoute<{ POST: Post }>('upload');
  const images = await fixture.loadRoute<{ GET: Get }>('images');
  const rag = await import('@/lib/rag');
  const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  setIngestDepsForTests({ embedDocuments: async (texts) => texts.map((text) => embedText(text)) });
  const { setObjectStoreForTests } = await import('@/lib/rag/ingest/object-store');
  const { createFakeObjectStore } = await import('../../helpers/fake-object-store');
  setObjectStoreForTests(createFakeObjectStore());
  const captions = new Map<number, string>();
  const { setCaptionerForTests } = await import('@/lib/rag/ingest/captioner');
  setCaptionerForTests(async (bytes) => captions.get(bytes[bytes.length - 1] ?? 0) ?? recorded.captions.chart);
  return { fixture, db: db as unknown as PGlite, post: POST, images, captions, rag };
}

async function stop(loaded: Loaded): Promise<void> {
  const { resetIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  const { resetObjectStoreForTests } = await import('@/lib/rag/ingest/object-store');
  const { resetCaptionerForTests } = await import('@/lib/rag/ingest/captioner');
  resetIngestDepsForTests();
  resetObjectStoreForTests();
  resetCaptionerForTests();
  await loaded.fixture.close();
  vi.doUnmock('@/lib/supabase');
  vi.unstubAllEnvs();
}

/** The images route reads with order and is_null filters the fake edge does not serve, so it runs over the same database through the PGlite builder. */
async function listImages(loaded: Loaded, userId: string): Promise<{ images: Array<{ id: string; url: string; name: string }> }> {
  const { createPgliteAdmin } = await import('../../helpers/pglite-admin');
  h.session.userId = userId;
  h.adminOverride = createPgliteAdmin(loaded.db);
  try {
    const response = await loaded.images.GET(new Request('http://localhost/api/images'));
    expect(response.status).toBe(200);
    return (await response.json()) as { images: Array<{ id: string; url: string; name: string }> };
  } finally {
    h.adminOverride = null;
  }
}

async function runAfter(): Promise<void> {
  const callbacks = h.after.splice(0);
  for (const callback of callbacks) await callback();
}

async function imageRows(db: PGlite) {
  const { rows } = await db.query<{
    id: string;
    tenant_key: string;
    user_id: string | null;
    organization_id: string | null;
    source: string;
    source_key: string;
    filename: string;
    status: string;
    is_current: boolean;
    parser_used: string | null;
    parser_version: string | null;
    chunks: Array<{ content: string; chunk_kind: string; page_start: number | null; status: string; metadata: Record<string, any> }>;
  }>(
    `SELECT d.id, d.tenant_key, d.user_id, d.organization_id, d.source, d.source_key, d.filename, d.status, d.is_current, d.parser_used, d.parser_version,
            COALESCE((SELECT json_agg(json_build_object('content', c.content, 'chunk_kind', c.chunk_kind, 'page_start', c.page_start, 'status', c.status, 'metadata', c.metadata) ORDER BY c.chunk_index)
                        FROM document_chunks c WHERE c.document_id = d.id), '[]'::json) AS chunks
       FROM documents d WHERE d.source = 'image_upload' ORDER BY d.created_at, d.id`,
  );
  return rows;
}

beforeEach(() => {
  h.session.userId = null;
  h.uploads.length = 0;
  h.after.length = 0;
  h.processed.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('image upload through ingest() against two tenants', () => {
  let loaded: Loaded;

  beforeAll(async () => {
    loaded = await start('multi-tenant');
    loaded.captions.set(4, recorded.captions.chart);
    loaded.captions.set(8, recorded.captions.logo);
  });

  afterAll(async () => {
    await stop(loaded);
  });

  async function upload(userId: string | null, bytes: Uint8Array, fields: Record<string, string> = {}, fileName = 'photo.png') {
    h.session.userId = userId;
    const response = await loaded.post(uploadRequest({ process_rag: 'true', ...fields }, bytes, fileName));
    return response;
  }

  it('a signed-in user uploads an image: stored under their prefix, then one ready image document and one image chunk in their personal tenant', async () => {
    const response = await upload(userA, PNG);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0]!.startsWith(`${userA}/`)).toBe(true);
    expect(h.after).toHaveLength(1);
    expect(h.processed).toEqual([]);
    await runAfter();

    const rows = await imageRows(loaded.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_key: `u:${userA}`,
      user_id: userA,
      organization_id: null,
      source: 'image_upload',
      source_key: h.uploads[0],
      filename: 'photo.png',
      status: 'ready',
      is_current: true,
      parser_used: 'text',
      parser_version: 'image',
    });
    expect(rows[0]!.chunks).toHaveLength(1);
    expect(rows[0]!.chunks[0]).toMatchObject({ content: recorded.captions.chart, chunk_kind: 'image', page_start: 1, status: 'ready' });
    expect(rows[0]!.chunks[0]!.metadata.image_url).toBe(body.files[0].downloadUrl);
  });

  it('another user uploads their own image into their own tenant, and the same bytes from them are not a duplicate of the first user', async () => {
    const response = await upload(userB, PNG);
    expect(response.status).toBe(200);
    await runAfter();
    const rows = await imageRows(loaded.db);
    expect(rows.map((row) => row.tenant_key).sort()).toEqual([`u:${userA}`, `u:${userB}`].sort());
    expect(rows.every((row) => row.status === 'ready' && row.is_current)).toBe(true);

    h.session.userId = userB;
    await upload(userB, OTHER_PNG);
    await runAfter();
    const afterSecond = await imageRows(loaded.db);
    expect(afterSecond.filter((row) => row.tenant_key === `u:${userB}`)).toHaveLength(2);
  });

  it('runRetrieval returns the image chunk for its tenant and never for the other, and it reaches source_images through context assembly', async () => {
    const scopeOf = async (userId: string) => {
      const { getSupabaseAdmin } = await import('@/lib/supabase');
      const resolved = await loaded.rag.resolveTenantScope({
        requestedOrganizationId: null,
        deploymentMode: 'multi-tenant',
        getUser: async () => ({ id: userId }),
        admin: getSupabaseAdmin() as never,
        signal: new AbortController().signal,
      });
      if (!resolved.ok || !resolved.scope) throw new Error('scope must resolve');
      return resolved.scope;
    };
    const retrieve = async (userId: string) =>
      loaded.rag.runRetrieval({ scope: await scopeOf(userId), query: recorded.captions.chart, profile: 'eval', options: OPTIONS, signal: new AbortController().signal });

    const rows = await imageRows(loaded.db);
    const rowA = rows.find((row) => row.tenant_key === `u:${userA}`)!;
    expect(rowA, 'the image document of tenant A exists').toBeTruthy();
    const forA = await retrieve(userA);
    const hit = forA.candidates.find((candidate) => candidate.document_id === rowA.id);
    expect(hit, 'tenant A retrieves its image chunk').toBeTruthy();
    expect(hit!.content).toBe(recorded.captions.chart);
    expect(forA.candidates.every((candidate) => !rows.some((row) => row.tenant_key === `u:${userB}` && row.id === candidate.document_id))).toBe(true);

    const forB = await retrieve(userB);
    expect(forB.candidates.some((candidate) => candidate.document_id === rowA.id)).toBe(false);

    const { getSupabaseAdmin } = await import('@/lib/supabase');
    const { fetchAssemblyRows } = await import('@/lib/rag/context/fetch-rows');
    const { assembleContext } = await import('@/lib/rag/context/assemble');
    const assemblyRows = await fetchAssemblyRows(forA.candidates as never, { adminClient: getSupabaseAdmin() as never, signal: new AbortController().signal });
    const assembled = assembleContext({
      queryText: recorded.captions.chart,
      candidates: forA.candidates as never,
      documents: assemblyRows.documents,
      chunkMetadata: assemblyRows.chunkMetadata,
      referenced: null,
      isGPTModel: false,
      ragMode: 'strict',
      webSearchEnabled: false,
      applyRelevanceFilter: true,
    });
    expect(assembled.sourceImages.map((image) => image.url)).toContain(String(rowA.chunks[0]!.metadata.image_url));
    expect(assembled.sourceImages.map((image) => image.name)).toContain('photo.png');
  });

  it('GET /api/images lists each tenant its own image only, with the chunk image URL', async () => {
    const rows = await imageRows(loaded.db);
    const rowA = rows.find((row) => row.tenant_key === `u:${userA}`)!;
    expect(rowA, 'the image document of tenant A exists').toBeTruthy();
    h.session.userId = userA;
    const listA = await listImages(loaded, userA);
    expect(listA.images.map((image: { id: string }) => image.id)).toEqual([rowA.id]);
    expect(listA.images[0].url).toBe(rowA.chunks[0]!.metadata.image_url);

    const listB = await listImages(loaded, userB);
    expect(listB.images.map((image: { id: string }) => image.id)).not.toContain(rowA.id);
    expect(listB.images).toHaveLength(2);
  });

  it('a member uploads into the organization workspace and the organization image is not visible to a non-member', async () => {
    const response = await upload(userA, new Uint8Array([9, 9, 9, 8]), { organization_id: orgO });
    expect(response.status).toBe(200);
    await runAfter();
    const row = (await imageRows(loaded.db)).find((candidate) => candidate.tenant_key === `o:${orgO}`);
    expect(row).toMatchObject({ organization_id: orgO, status: 'ready' });

    const listB = await listImages(loaded, userB);
    expect(listB.images.map((image: { id: string }) => image.id)).not.toContain(row!.id);
  });

  it('a non-member naming the organization gets 403 with nothing stored, scheduled or written', async () => {
    const before = await imageRows(loaded.db);
    const uploadsBefore = h.uploads.length;
    const response = await upload(userB, new Uint8Array([7, 7, 7, 7]), { organization_id: orgO });
    expect(response.status).toBe(403);
    expect(h.uploads).toHaveLength(uploadsBefore);
    expect(h.after).toEqual([]);
    expect(await imageRows(loaded.db)).toEqual(before);
  });

  it('no session gets 401 with nothing stored, scheduled or written', async () => {
    const before = await imageRows(loaded.db);
    const uploadsBefore = h.uploads.length;
    const response = await upload(null, new Uint8Array([6, 6, 6, 6]));
    expect(response.status).toBe(401);
    expect(h.uploads).toHaveLength(uploadsBefore);
    expect(h.after).toEqual([]);
    expect(await imageRows(loaded.db)).toEqual(before);
  });

  it('an image whose caption holds an injection phrase is quarantined under RAG_INJECTION_SCAN=quarantine and no tenant lists or retrieves it', async () => {
    const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
    const { resetIngestConfigForTests } = await import('@/lib/rag/ingest/config');
    setIngestDepsForTests({ ingestEnv: () => ({ RAG_INGEST_PIPELINE: 'unified', RAG_INJECTION_SCAN: 'quarantine' }) });
    resetIngestConfigForTests();
    loaded.captions.set(3, recorded.captions.injection);
    try {
      const response = await upload(userA, new Uint8Array([5, 5, 5, 3]));
      expect(response.status).toBe(200);
      await runAfter();
      const row = (await imageRows(loaded.db)).find((candidate) => candidate.source_key === h.uploads.at(-1));
      expect(row).toMatchObject({ status: 'quarantined', is_current: false });
      expect(row!.chunks.every((chunk) => chunk.status === 'quarantined')).toBe(true);

      const listA = await listImages(loaded, userA);
      expect(listA.images.map((image: { id: string }) => image.id)).not.toContain(row!.id);
    } finally {
      setIngestDepsForTests({ ingestEnv: () => ({ RAG_INGEST_PIPELINE: 'unified' }) });
      resetIngestConfigForTests();
    }
  });
});

describe('image upload through ingest(), single-tenant', () => {
  let loaded: Loaded;

  beforeAll(async () => {
    loaded = await start('single-tenant');
  });

  afterAll(async () => {
    await stop(loaded);
  });

  it('writes under s:default with no user id, and the image is listed and retrievable', async () => {
    h.session.userId = userA;
    const response = await loaded.post(uploadRequest({ process_rag: 'true' }, PNG, 'photo.png'));
    expect(response.status).toBe(200);
    await runAfter();
    const rows = await imageRows(loaded.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_key: 's:default', user_id: null, organization_id: null, status: 'ready', is_current: true });
    expect(rows[0]!.chunks[0]).toMatchObject({ chunk_kind: 'image', page_start: 1 });

    const list = await listImages(loaded, userA);
    expect(list.images.map((image: { id: string }) => image.id)).toContain(rows[0]!.id);
  });

  it('refuses a request with no session before any write', async () => {
    const before = await imageRows(loaded.db);
    h.session.userId = null;
    const response = await loaded.post(uploadRequest({ process_rag: 'true' }, new Uint8Array([1, 1, 1, 1]), 'photo.png'));
    expect(response.status).toBe(401);
    expect(h.after).toEqual([]);
    expect(await imageRows(loaded.db)).toEqual(before);
  });
});
