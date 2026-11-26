import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, afterEach, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { TenantScope } from '@/lib/rag/tenant/scope';

type Row = Record<string, unknown>;

const USER_B = '00000000-0000-4000-8000-0000000018b2';
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const WRITE_IDS = 'SELECT * FROM public.rag_write_chunk_identifiers($1, $2::uuid, $3::jsonb)';

// Identifiers described by shape only: invented letter and digit codes.
const SHAPE_A = 'QX-4471-B';
const SHAPE_B = 'ZK.20.991';
const DIGIT_FREE = 'KLOMP-RIVA';

const INDEXER_SIGNATURES = [
  'public.rag_index_document_chunks(text,uuid,uuid,integer)',
  'public.rag_write_chunk_identifiers(text,uuid,jsonb)',
  'public.rag_write_table_rows(text,uuid,text,jsonb)',
  'public.rag_index_backfill_documents(text,text,uuid,integer)',
];

/** RED guard: every case first asserts that the 0860 functions exist, so a missing migration fails on an assertion. */
async function assertIndexerFunctions(db: PGlite): Promise<void> {
  const result = await db.query<{ sig: string; ok: boolean }>('SELECT s AS sig, to_regprocedure(s) IS NOT NULL AS ok FROM unnest($1::text[]) AS s', [INDEXER_SIGNATURES]);
  assert.deepEqual(result.rows.filter((row) => !row.ok).map((row) => row.sig), [], '0860 functions exist');
}

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : '';
}

async function service(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  await db.exec('SET ROLE service_role');
  try {
    return (await db.query<Row>(sql, params)).rows;
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await service(db, sql, params);
    return null;
  } catch (error) {
    return sqlState(error) || 'unknown';
  }
}

async function withReplica<T>(db: PGlite, run: () => Promise<T>): Promise<T> {
  await db.exec("SET session_replication_role = 'replica'");
  try {
    return await run();
  } finally {
    await db.exec("SET session_replication_role = 'origin'");
  }
}

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';
  const tenantA = multi ? `u:${FIXTURE_USER_ID}` : 's:default';
  const tenantB = `u:${USER_B}`;

  describe(`0860 rag_write_chunk_identifiers (${mode}, D-28, D-56)`, () => {
    let db: PGlite;

    async function insertDocument(owner: 'A' | 'B'): Promise<string> {
      const id = crypto.randomUUID();
      const columns = ['id', 'filename', 'content', 'status', 'is_current', 'lineage_id'];
      const values: unknown[] = [id, 'ids.md', 'neutral body', 'ready', true, id];
      if (multi) {
        columns.push('user_id');
        values.push(owner === 'A' ? FIXTURE_USER_ID : USER_B);
      }
      await db.query(`INSERT INTO documents (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, values);
      return id;
    }

    async function insertChunk(documentId: string, options: { profile?: string; index?: number; plantTenant?: string } = {}): Promise<string> {
      const id = crypto.randomUUID();
      const insert = () =>
        db.query(
          `INSERT INTO document_chunks (id, document_id, content, metadata, chunk_index, chunking_profile_id${options.plantTenant ? ', tenant_key' : ''})
           VALUES ($1, $2, 'neutral chunk text', '{}'::jsonb, $3, $4${options.plantTenant ? ', $5' : ''})`,
          [id, documentId, options.index ?? 0, options.profile ?? 'legacy', ...(options.plantTenant ? [options.plantTenant] : [])],
        );
      if (options.plantTenant) await withReplica(db, insert);
      else await insert();
      return id;
    }

    const chunkIds = async (id: string): Promise<Row | undefined> =>
      (await db.query<Row>('SELECT identifiers_raw, identifiers_norm FROM document_chunks WHERE id = $1', [id])).rows[0];
    const documentIds = async (id: string): Promise<Row | undefined> =>
      (await db.query<Row>('SELECT identifiers_raw, identifiers_norm FROM documents WHERE id = $1', [id])).rows[0];

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      if (multi) await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [USER_B, 'fixture-user-b@example.invalid']);
    });

    after(async () => {
      await db?.close();
    });

    test('chunk arrays are stored and the document gets their union (legacy first, de-duplicated by norm); an empty array means indexed with none', async () => {
      await assertIndexerFunctions(db);
      const documentId = await insertDocument('A');
      const one = await insertChunk(documentId, { index: 0 });
      const two = await insertChunk(documentId, { index: 1 });
      const child = await insertChunk(documentId, { profile: 'p-alt', index: 0 });
      const none = await insertChunk(documentId, { index: 2 });
      const rows = [
        { chunk_id: child, raw: ['QX_4471_C'], norm: ['qx4471c'] },
        { chunk_id: two, raw: [SHAPE_B, 'qx 4471 b'], norm: ['zk20991', 'qx4471b'] },
        { chunk_id: one, raw: [SHAPE_A], norm: ['qx4471b'] },
        { chunk_id: none, raw: [], norm: [] },
      ];
      const written = await service(db, WRITE_IDS, [tenantA, documentId, JSON.stringify(rows)]);
      assert.deepEqual(written[0], { chunks_written: 4, document_changed: true });
      assert.deepEqual(await chunkIds(two), { identifiers_raw: [SHAPE_B, 'qx 4471 b'], identifiers_norm: ['zk20991', 'qx4471b'] });
      assert.deepEqual(await chunkIds(none), { identifiers_raw: [], identifiers_norm: [] });
      assert.deepEqual(await documentIds(documentId), { identifiers_raw: [SHAPE_A, SHAPE_B, 'QX_4471_C'], identifiers_norm: ['qx4471b', 'zk20991', 'qx4471c'] });

      const again = await service(db, WRITE_IDS, [tenantA, documentId, JSON.stringify(rows)]);
      assert.deepEqual(again[0], { chunks_written: 0, document_changed: false }, 'an unchanged union is not rewritten');
    });

    test('a chunk of another document or another tenant is refused and nothing is written', async () => {
      await assertIndexerFunctions(db);
      const documentId = await insertDocument('A');
      const own = await insertChunk(documentId);
      const elsewhere = await insertChunk(await insertDocument('A'));
      const foreign = multi ? await insertChunk(await insertDocument('B')) : await insertChunk(documentId, { plantTenant: tenantB, index: 5 });
      for (const bad of [elsewhere, foreign]) {
        const rows = [
          { chunk_id: own, raw: [SHAPE_A], norm: ['qx4471b'] },
          { chunk_id: bad, raw: [SHAPE_B], norm: ['zk20991'] },
        ];
        assert.equal(await failure(db, WRITE_IDS, [tenantA, documentId, JSON.stringify(rows)]), '42501');
      }
      for (const id of [own, elsewhere, foreign]) assert.deepEqual(await chunkIds(id), { identifiers_raw: null, identifiers_norm: null });
      assert.deepEqual(await documentIds(documentId), { identifiers_raw: null, identifiers_norm: null });
      if (multi) {
        const foreignDocument = await insertDocument('B');
        const foreignChunk = await insertChunk(foreignDocument);
        assert.equal(await failure(db, WRITE_IDS, [tenantA, foreignDocument, JSON.stringify([{ chunk_id: foreignChunk, raw: [], norm: [] }])]), '42501');
        assert.deepEqual(await documentIds(foreignDocument), { identifiers_raw: null, identifiers_norm: null });
      }
    });

    test('rows above the caps or malformed rows are rejected with 22023', async () => {
      await assertIndexerFunctions(db);
      const documentId = await insertDocument('A');
      const chunkId = await insertChunk(documentId);
      const cases: unknown[] = [
        Array.from({ length: 1001 }, () => ({ chunk_id: chunkId, raw: [], norm: [] })),
        [{ chunk_id: chunkId, raw: Array.from({ length: 257 }, (_, i) => `QX-${i}`), norm: Array.from({ length: 257 }, (_, i) => `qx${i}`) }],
        [{ chunk_id: chunkId, raw: [SHAPE_A], norm: [] }],
        [{ chunk_id: chunkId, raw: [`A${'1'.repeat(200)}`], norm: ['a1'] }],
        [{ chunk_id: chunkId, raw: [''], norm: [''] }],
        [{ chunk_id: 'not-a-uuid', raw: [], norm: [] }],
        { chunk_id: chunkId },
      ];
      for (const rows of cases) assert.equal(await failure(db, WRITE_IDS, [tenantA, documentId, JSON.stringify(rows)]), '22023', JSON.stringify(rows).slice(0, 80));
    });
  });
}

describe('write stage on the two-tenant fixture: RAG_IDENTIFIER_INDEX (D-28, T-04.2-65)', () => {
  let fixture: TwoTenantDatabase;
  const fixtureDb = (): PGlite => fixture.db;
  let edge: FakeEdge;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let ingestDeps: typeof import('@/lib/rag/ingest/deps');
  let ingestConfig: typeof import('@/lib/rag/ingest/config');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let ragDeps: typeof import('@/lib/rag/deps');
  let patterns: typeof import('@/lib/rag/identifiers/patterns');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let identifierIndex: 'true' | 'false' = 'false';
  const KEY_A = `u:${TWO_TENANT_IDS.userA}`;

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const scopeOf = (userId: string): TenantScope => scopeModule.mintScope('personal', userId, null);
  const indexerCalls = (): number => edge.calls.filter((call) => /\/rpc\/rag_(index_document_chunks|write_table_rows|write_chunk_identifiers|identifier_patterns_list)$/.test(call.path)).length;

  const documentText = (title: string): string =>
    `# ${title}\n\n## Zorvat\n\nBrelo tasku ${SHAPE_A} vimen orlat ${DIGIT_FREE}.\n\n## Pemla\n\nSorvi plaku ${SHAPE_B} tolde minka.\n\n## Velta\n\nVorsa minka tolde plin rosk.\n`;

  const upload = (userId: string, sourceKey: string, text: string) =>
    ingestModule.ingest({
      scope: scopeOf(userId),
      source: 'config_upload',
      sourceKey,
      text,
      filename: `${sourceKey.replace(/\//g, '-')}.md`,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });

  const chunksOf = (documentId: unknown) =>
    rows('SELECT identifiers_raw, identifiers_norm, tenant_key FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId]);

  before(async () => {
    const emptyCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'identifier-index-corpus-'));
    try {
      fixture = await createTwoTenantDatabase({ corpusDir: emptyCorpus });
    } finally {
      fs.rmdirSync(emptyCorpus);
    }
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    ingestModule = await import('@/lib/rag/ingest');
    ingestDeps = await import('@/lib/rag/ingest/deps');
    ingestConfig = await import('@/lib/rag/ingest/config');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    ragDeps = await import('@/lib/rag/deps');
    patterns = await import('@/lib/rag/identifiers/patterns');
    scopeModule = await import('@/lib/rag/tenant/scope');
    objectStoreModule.setObjectStoreForTests((await import('../helpers/fake-object-store')).createFakeObjectStore());
    ingestConfig.resetIngestConfigForTests();
    ingestDeps.setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'off' }) });
    ragDeps.setRagDepsForTests({ ragEnv: () => ({ RAG_IDENTIFIER_INDEX: identifierIndex }) });
    await fixture.db.query("INSERT INTO rag_identifier_patterns (tenant_key, name, pattern, flags) VALUES ($1, 'digit free shape', '[A-Z]{5}-[A-Z]{4}', 'u')", [KEY_A]);
  });

  afterEach(() => {
    mock.restoreAll();
    patterns.resetIdentifierPatternCacheForTests();
  });

  after(async () => {
    objectStoreModule?.resetObjectStoreForTests();
    ingestDeps?.resetIngestDepsForTests();
    ingestConfig?.resetIngestConfigForTests();
    ragDeps?.resetRagDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  test('switch off: no identifier is written and no indexer function is called', async () => {
    await assertIndexerFunctions(fixtureDb());
    identifierIndex = 'false';
    const calls = indexerCalls();
    const result = await upload(TWO_TENANT_IDS.userA, 'ids/off', documentText('Codes off'));
    assert.equal(result.status, 'ready');
    assert.equal(indexerCalls(), calls);
    for (const chunk of await chunksOf(result.documentId)) assert.deepEqual([chunk.identifiers_raw, chunk.identifiers_norm], [null, null]);
    assert.deepEqual(await rows('SELECT identifiers_norm FROM documents WHERE id = $1', [result.documentId]), [{ identifiers_norm: null }]);
  });

  test("switch on: every chunk is indexed (empty means none), the document holds the union, and tenant A's pattern applies to tenant A only", async () => {
    await assertIndexerFunctions(fixtureDb());
    identifierIndex = 'true';
    const a = await upload(TWO_TENANT_IDS.userA, 'ids/one', documentText('Codes'));
    const b = await upload(TWO_TENANT_IDS.userB, 'ids/one', documentText('Codes'));
    for (const result of [a, b]) {
      assert.equal(result.status, 'ready');
      assert.deepEqual(result.warnings.filter((warning) => warning.startsWith('index_') || warning.startsWith('identifier_')), []);
    }
    const chunksA = await chunksOf(a.documentId);
    const chunksB = await chunksOf(b.documentId);
    assert.ok(chunksA.length >= 2);
    for (const chunk of [...chunksA, ...chunksB]) assert.ok(Array.isArray(chunk.identifiers_norm), 'every chunk is indexed');
    const normA = chunksA.flatMap((chunk) => chunk.identifiers_norm as string[]);
    const normB = chunksB.flatMap((chunk) => chunk.identifiers_norm as string[]);
    assert.ok(normA.includes('qx4471b') && normA.includes('zk20991') && normA.includes('klompriva'), JSON.stringify(normA));
    assert.ok(normB.includes('qx4471b') && normB.includes('zk20991'), JSON.stringify(normB));
    assert.equal(normB.includes('klompriva'), false, "tenant A's pattern is not applied to tenant B");
    assert.ok(chunksA.some((chunk) => (chunk.identifiers_norm as string[]).length === 0), 'a chunk without identifiers has an empty array');
    const [docA] = await rows('SELECT identifiers_raw, identifiers_norm FROM documents WHERE id = $1', [a.documentId]);
    assert.deepEqual(new Set(docA?.identifiers_norm as string[]), new Set(normA));
    assert.equal((docA?.identifiers_raw as string[]).length, (docA?.identifiers_norm as string[]).length);
    assert.ok((docA?.identifiers_raw as string[]).includes(SHAPE_A));
  });

  test('a new version is indexed and the old version keeps its identifiers', async () => {
    await assertIndexerFunctions(fixtureDb());
    identifierIndex = 'true';
    const [old] = await rows("SELECT id FROM documents WHERE tenant_key = $1 AND source_key = 'ids/one' AND is_current", [KEY_A]);
    const next = await upload(TWO_TENANT_IDS.userA, 'ids/one', `${documentText('Codes')}\n## Kesta\n\nNovel code RT-5510-Z here.\n`);
    assert.equal(next.version, 2);
    const oldNorm = (await chunksOf(old?.id)).flatMap((chunk) => chunk.identifiers_norm as string[]);
    assert.ok(oldNorm.includes('qx4471b'));
    assert.equal(oldNorm.includes('rt5510z'), false);
    const newNorm = (await chunksOf(next.documentId)).flatMap((chunk) => chunk.identifiers_norm as string[]);
    assert.ok(newNorm.includes('rt5510z') && newNorm.includes('qx4471b'));
  });

  test('a pattern load failure indexes with the built-in rule and records identifier_patterns_unavailable', async () => {
    await assertIndexerFunctions(fixtureDb());
    identifierIndex = 'true';
    mock.method(console, 'warn', () => undefined);
    await fixture.db.query('ALTER FUNCTION public.rag_identifier_patterns_list(text) RENAME TO rag_identifier_patterns_list_disabled');
    try {
      const result = await upload(TWO_TENANT_IDS.userA, 'ids/no-patterns', documentText('Codes plain'));
      assert.equal(result.status, 'ready');
      assert.ok(result.warnings.includes('identifier_patterns_unavailable'), JSON.stringify(result.warnings));
      const norm = (await chunksOf(result.documentId)).flatMap((chunk) => chunk.identifiers_norm as string[]);
      assert.ok(norm.includes('qx4471b'));
      assert.equal(norm.includes('klompriva'), false);
    } finally {
      await fixture.db.query('ALTER FUNCTION public.rag_identifier_patterns_list_disabled(text) RENAME TO rag_identifier_patterns_list');
    }
  });

  test('a writer failure never fails ingestion: published, one [Ingest] warning, index_identifiers_failed', async () => {
    await assertIndexerFunctions(fixtureDb());
    identifierIndex = 'true';
    const warn = mock.method(console, 'warn', () => undefined);
    await fixture.db.query('ALTER FUNCTION public.rag_write_chunk_identifiers(text, uuid, jsonb) RENAME TO rag_write_chunk_identifiers_disabled');
    try {
      const result = await upload(TWO_TENANT_IDS.userB, 'ids/fails', documentText('Codes fail'));
      assert.equal(result.status, 'ready');
      assert.ok(result.warnings.includes('index_identifiers_failed'), JSON.stringify(result.warnings));
      const lines = warn.mock.calls.filter((call) => String(call.arguments[0]).startsWith('[Ingest] lookup indexing failed'));
      assert.equal(lines.length, 1);
      const detail = lines[0]?.arguments[1] as Record<string, unknown>;
      assert.equal(detail.code, 'index_identifiers_failed');
      assert.equal(detail.error, 'IngestWriterError');
      assert.equal(JSON.stringify(detail).toLowerCase().includes('qx'), false, 'no identifier is logged');
    } finally {
      await fixture.db.query('ALTER FUNCTION public.rag_write_chunk_identifiers_disabled(text, uuid, jsonb) RENAME TO rag_write_chunk_identifiers');
    }
  });
});
