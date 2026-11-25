import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS } from '../../../eval/harness/two-tenant.mts';
import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';
import { fixtureBytes } from '../../helpers/fake-sidecar';
import recorded from '../../fixtures/ingest/caption-recorded.json';

const { userA, userB } = TWO_TENANT_IDS;
const RECORDED_DIR = join(process.cwd(), 'eval/fixtures/ingest/recorded');
const PARSE = JSON.parse(readFileSync(join(RECORDED_DIR, 'images-en.parse.json'), 'utf8')) as ParseResult;
const PICTURE_1 = new Uint8Array(readFileSync(join(RECORDED_DIR, 'images-en.picture-1.png')));
const PICTURE_2 = new Uint8Array(readFileSync(join(RECORDED_DIR, 'images-en.picture-2.png')));
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

type Mods = {
  ingest: typeof import('@/lib/rag/ingest').ingest;
  rag: typeof import('@/lib/rag');
  publicStore: import('../../helpers/fake-public-image-store').FakePublicImageStore;
  base: string;
  injectNext: { value: boolean };
};

interface Loaded extends Mods {
  fixture: RouteFixture;
  db: PGlite;
}

async function start(): Promise<Loaded> {
  let db: PGlite | null = null;
  const fixture = await startRouteFixture({
    deploymentMode: 'multi-tenant',
    twoTenant: true,
    seed: async (database) => {
      db = database;
    },
  });
  vi.resetModules();
  const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  const { resetIngestConfigForTests } = await import('@/lib/rag/ingest/config');
  setIngestDepsForTests({
    embedDocuments: async (texts) => texts.map((text) => embedText(text)),
    ingestEnv: () => ({ RAG_INGEST_PIPELINE: 'unified', RAG_PDF_IMAGE_CHUNKS: 'true', RAG_INJECTION_SCAN: 'quarantine' }),
  });
  resetIngestConfigForTests();
  const { setObjectStoreForTests } = await import('@/lib/rag/ingest/object-store');
  const { createFakeObjectStore } = await import('../../helpers/fake-object-store');
  setObjectStoreForTests(createFakeObjectStore());
  const { createFakePublicImageStore, FAKE_PUBLIC_IMAGE_BASE } = await import('../../helpers/fake-public-image-store');
  const { setPublicImageStoreForTests } = await import('@/lib/rag/ingest/images/public-store');
  const publicStore = createFakePublicImageStore();
  setPublicImageStoreForTests(publicStore);
  const { setSidecarParserForTests } = await import('@/lib/rag/ingest/parsers/sidecar-docling');
  const { setLlamaParseParserForTests } = await import('@/lib/rag/ingest/parsers/llamaparse-v2');
  const { ParserError } = await import('@/lib/rag/ingest/parsers/shared');
  const injectNext = { value: false };
  setSidecarParserForTests({
    name: 'docling',
    unavailableReason: () => null,
    async parse() {
      return {
        kind: 'done',
        result: injectNext.value ? { ...PARSE, markdown: `${PARSE.markdown}\n\nNoticeboard variant of the product sheet.` } : PARSE,
        artifacts: [
          { name: 'picture-1.png', bytes: PICTURE_1, contentType: 'image/png' },
          { name: 'picture-2.png', bytes: PICTURE_2, contentType: 'image/png' },
        ],
        warnings: [],
      };
    },
  });
  setLlamaParseParserForTests({
    name: 'llamaparse',
    unavailableReason: () => 'missing_key',
    async parse() {
      throw new ParserError('llamaparse', 'missing_key');
    },
  });
  const { setCaptionerForTests } = await import('@/lib/rag/ingest/captioner');
  setCaptionerForTests(async (bytes) => {
    if (injectNext.value) return recorded.captions.injection;
    return sameBytes(bytes, PICTURE_1) ? recorded.captions.chart : recorded.captions.logo;
  });
  const { ingest } = await import('@/lib/rag/ingest');
  const rag = await import('@/lib/rag');
  return { fixture, db: db as unknown as PGlite, ingest, rag, publicStore, base: FAKE_PUBLIC_IMAGE_BASE, injectNext };
}

async function stop(loaded: Loaded): Promise<void> {
  const { resetIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  const { resetIngestConfigForTests } = await import('@/lib/rag/ingest/config');
  const { resetObjectStoreForTests } = await import('@/lib/rag/ingest/object-store');
  const { resetPublicImageStoreForTests } = await import('@/lib/rag/ingest/images/public-store');
  const { resetCaptionerForTests } = await import('@/lib/rag/ingest/captioner');
  const { resetSidecarParserForTests } = await import('@/lib/rag/ingest/parsers/sidecar-docling');
  const { resetLlamaParseParserForTests } = await import('@/lib/rag/ingest/parsers/llamaparse-v2');
  resetIngestDepsForTests();
  resetIngestConfigForTests();
  resetObjectStoreForTests();
  resetPublicImageStoreForTests();
  resetCaptionerForTests();
  resetSidecarParserForTests();
  resetLlamaParseParserForTests();
  await loaded.fixture.close();
}

async function scopeOf(loaded: Loaded, userId: string) {
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
}

async function ingestPdf(loaded: Loaded, userId: string, name: string, salt = 0) {
  const base = fixtureBytes('images-en');
  const file = salt === 0 ? base : new Uint8Array([...base, salt]);
  return loaded.ingest({
    scope: await scopeOf(loaded, userId),
    source: 'config_upload',
    sourceKey: `root/${name}`,
    file,
    filename: name,
    mimeType: 'application/pdf',
    docType: 'product_technical',
    signal: new AbortController().signal,
  });
}

async function retrieve(loaded: Loaded, userId: string, query: string) {
  return loaded.rag.runRetrieval({ scope: await scopeOf(loaded, userId), query, profile: 'eval', options: OPTIONS, signal: new AbortController().signal });
}

async function assemble(loaded: Loaded, candidates: Awaited<ReturnType<typeof retrieve>>['candidates'], query: string) {
  const { getSupabaseAdmin } = await import('@/lib/supabase');
  const { fetchAssemblyRows } = await import('@/lib/rag/context/fetch-rows');
  const { assembleContext } = await import('@/lib/rag/context/assemble');
  const rows = await fetchAssemblyRows(candidates as never, { adminClient: getSupabaseAdmin() as never, signal: new AbortController().signal });
  return assembleContext({
    queryText: query,
    candidates: candidates as never,
    documents: rows.documents,
    chunkMetadata: rows.chunkMetadata,
    referenced: null,
    isGPTModel: false,
    ragMode: 'strict',
    webSearchEnabled: false,
    applyRelevanceFilter: true,
  });
}

async function pictureRows(db: PGlite) {
  const { rows } = await db.query<{ document_id: string; tenant_key: string; status: string; page_start: number; url: string; filename: string }>(
    `SELECT c.document_id, d.tenant_key, c.status, c.page_start, c.metadata->>'image_url' AS url, d.filename
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.chunk_kind = 'image' AND d.filename LIKE '%.pdf' ORDER BY d.tenant_key, c.page_start`,
  );
  return rows;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('PDF pictures against two tenants', () => {
  let loaded: Loaded;

  beforeAll(async () => {
    loaded = await start();
  });

  afterAll(async () => {
    await stop(loaded);
  });

  it('each tenant stores the same PDF under its own rag/<tenant_key>/ prefix, and no key of one is under the other', async () => {
    const a = await ingestPdf(loaded, userA, 'images-en.pdf');
    const b = await ingestPdf(loaded, userB, 'images-en.pdf');
    expect(a.status).toBe('ready');
    expect(b.status).toBe('ready');

    const keys = loaded.publicStore.keys();
    const own = (tenant: string) => keys.filter((key) => key.startsWith(`rag/${tenant}/`));
    expect(own(`u:${userA}`)).toHaveLength(2);
    expect(own(`u:${userB}`)).toHaveLength(2);
    expect(keys).toHaveLength(4);
    expect(keys.every((key) => key.startsWith('rag/u:'))).toBe(true);
    expect(own(`u:${userA}`).some((key) => key.includes(userB))).toBe(false);
    expect(own(`u:${userB}`).some((key) => key.includes(userA))).toBe(false);
    expect(new Set(keys.map((key) => key.split('/')[2])).size).toBe(2);

    const rows = await pictureRows(loaded.db);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.status).toBe('ready');
      expect(row.url.startsWith(`${loaded.base}rag/${row.tenant_key}/`)).toBe(true);
    }
    expect(rows.filter((row) => row.tenant_key === `u:${userA}`).map((row) => row.page_start)).toEqual([1, 2]);
  });

  it('retrieval and context assembly give each tenant only its own image chunk and its own URL', async () => {
    const rows = await pictureRows(loaded.db);
    const idsOf = (tenant: string) => new Set(rows.filter((row) => row.tenant_key === tenant).map((row) => row.document_id));
    const urlsOf = (tenant: string) => rows.filter((row) => row.tenant_key === tenant).map((row) => row.url);

    for (const [userId, other] of [
      [userA, userB],
      [userB, userA],
    ] as const) {
      const tenant = `u:${userId}`;
      const otherTenant = `u:${other}`;
      const result = await retrieve(loaded, userId, recorded.captions.chart);
      const hit = result.candidates.find((candidate) => idsOf(tenant).has(candidate.document_id) && candidate.metadata?.image_url);
      expect(hit, `${tenant} retrieves its picture chunk`).toBeTruthy();
      expect(result.candidates.some((candidate) => idsOf(otherTenant).has(candidate.document_id))).toBe(false);
      expect(JSON.stringify(result.candidates)).not.toContain(`rag/${otherTenant}/`);

      const assembled = await assemble(loaded, result.candidates, recorded.captions.chart);
      expect(assembled.sourceImages.length).toBeGreaterThan(0);
      expect(assembled.sourceImages.every((image) => urlsOf(tenant).includes(String(image.url)))).toBe(true);
      expect(JSON.stringify(assembled)).not.toContain(`rag/${otherTenant}/`);
    }
  });

  it('a PDF whose caption holds an injection phrase is quarantined: nothing is stored publicly, no picture chunk exists, and no tenant retrieves it or gets its URL', async () => {
    const before = loaded.publicStore.puts.length;
    loaded.injectNext.value = true;
    let result;
    try {
      result = await ingestPdf(loaded, userA, 'noticeboard.pdf', 7);
    } finally {
      loaded.injectNext.value = false;
    }
    expect(result.status).toBe('quarantined');
    expect(loaded.publicStore.puts).toHaveLength(before);

    const { rows } = await loaded.db.query<{ id: string; status: string; is_current: boolean }>(`SELECT id, status, is_current FROM documents WHERE filename = 'noticeboard.pdf'`);
    expect(rows).toEqual([expect.objectContaining({ status: 'quarantined', is_current: false })]);
    const documentId = rows[0]!.id;
    expect((await pictureRows(loaded.db)).some((row) => row.document_id === documentId)).toBe(false);

    for (const userId of [userA, userB]) {
      const found = await retrieve(loaded, userId, recorded.captions.injection);
      expect(found.candidates.some((candidate) => candidate.document_id === documentId)).toBe(false);
      const assembled = await assemble(loaded, found.candidates, recorded.captions.injection);
      expect(assembled.sourceImages.every((image) => !String(image.url).includes(documentId))).toBe(true);
      expect(JSON.stringify(assembled.usedDocuments)).not.toContain(documentId);
    }
  });

  describe('the chat-images read policy (supabase/patches/2026-11-chat-images-rag-prefix.sql)', () => {
    const PATCH = readFileSync(join(process.cwd(), 'supabase/patches/2026-11-chat-images-rag-prefix.sql'), 'utf8');

    async function listAs(role: 'anon' | 'authenticated'): Promise<string[]> {
      await loaded.db.exec(`SET ROLE ${role}`);
      try {
        const { rows } = await loaded.db.query<{ name: string }>(`SELECT name FROM storage.objects WHERE bucket_id = 'chat-images' ORDER BY name`);
        return rows.map((row) => row.name);
      } finally {
        await loaded.db.exec('RESET ROLE');
      }
    }

    it('lets any client list the pictures of every tenant before the patch (the exposure), and none of them after, while other objects stay listed', async () => {
      // Supabase grants these to its API roles; the fixture's shim does not.
      await loaded.db.exec(`GRANT USAGE ON SCHEMA storage TO anon, authenticated; GRANT SELECT ON storage.objects TO anon, authenticated`);
      const keyA = `rag/u:${userA}/22222222-2222-4222-8222-222222222222/1/p1-1.png`;
      const keyB = `rag/u:${userB}/33333333-3333-4333-8333-333333333333/1/p1-1.png`;
      for (const name of [keyA, keyB, `${userA}/upload_1_abc.png`]) {
        await loaded.db.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('chat-images', $1)`, [name]);
      }

      expect(await listAs('authenticated')).toEqual([keyA, keyB, `${userA}/upload_1_abc.png`].sort());

      await loaded.db.exec(PATCH);
      await loaded.db.exec(PATCH);

      expect(await listAs('authenticated')).toEqual([`${userA}/upload_1_abc.png`]);
      expect(await listAs('anon')).toEqual([`${userA}/upload_1_abc.png`]);
    });
  });
});
