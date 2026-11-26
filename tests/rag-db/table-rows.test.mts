import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, afterEach, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { applyMigrations } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { TenantScope } from '@/lib/rag/tenant/scope';

type Row = Record<string, unknown>;

const ANON_KEY = 'fixture-anon-key-placeholder';
const SERVICE_KEY = 'fixture-service-role-key-placeholder';
const USER_B = '00000000-0000-4000-8000-0000000018b1';
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const SIGNATURES = [
  'public.rag_index_document_chunks(text,uuid,uuid,integer)',
  'public.rag_write_chunk_identifiers(text,uuid,jsonb)',
  'public.rag_write_table_rows(text,uuid,text,jsonb)',
  'public.rag_index_backfill_documents(text,text,uuid,integer)',
];
const NEW_FUNCTIONS = ['rag_index_document_chunks', 'rag_write_chunk_identifiers', 'rag_write_table_rows', 'rag_index_backfill_documents'];

// Synthetic, neutral content: invented column names and values.
const TABLE = ['| Kelmo | Darvi | Quenta |', '| --- | --- | --- |', '| plin 41 | rosk | 7 |', '| vatu 52 | mepra | 9 |'].join('\n');

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

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated' | 'service_role', run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function service(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return asRole(db, 'service_role', async () => (await db.query<Row>(sql, params)).rows);
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

/** Service-role PostgREST stand-in over PGlite: named arguments, objects and arrays as JSON, errors with their SQLSTATE. */
export function serviceRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM public.${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const values = keys.map((key) => {
        const value = args[key];
        return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
      });
      const run = db
        .transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          return (await tx.query<Row>(sql, values)).rows;
        })
        .then((rows): RpcResponse => ({ data: rows as unknown[], error: null }))
        .catch((error: unknown): RpcResponse => ({
          data: null,
          error: { code: sqlState(error) || 'P0001', message: error instanceof Error ? error.message : String(error) },
        }));
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

async function functionDump(db: PGlite): Promise<string[]> {
  const result = await db.query<{ sig: string; def: string; acl: string | null }>(
    `SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])`,
    [NEW_FUNCTIONS],
  );
  return result.rows.map((row) => JSON.stringify(row)).sort();
}

function tableRow(tableKey: string, rowIndex: number, chunkIds: string[], value = 'plin'): Row {
  return {
    table_key: tableKey,
    row_index: rowIndex,
    header: ['Kelmo', 'Darvi'],
    cells: { Kelmo: `${value} ${rowIndex}`, Darvi: 'rosk' },
    cell_tokens: [[value, String(rowIndex)], ['rosk']],
    cell_norm: [value, String(rowIndex), 'rosk'],
    chunk_ids: chunkIds,
  };
}

const WRITE_ROWS = 'SELECT * FROM public.rag_write_table_rows($1, $2::uuid, $3, $4::jsonb)';
const READ_CHUNKS = 'SELECT * FROM public.rag_index_document_chunks($1, $2::uuid, $3::uuid, $4)';
const WRITE_IDS = 'SELECT * FROM public.rag_write_chunk_identifiers($1, $2::uuid, $3::jsonb)';
const BACKFILL = 'SELECT * FROM public.rag_index_backfill_documents($1, $2, $3::uuid, $4)';

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';
  const tenantA = multi ? `u:${FIXTURE_USER_ID}` : 's:default';
  const tenantB = `u:${USER_B}`;
  const wrongModeKey = multi ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`0860 table rows, chunk read and backfill listing (${mode}, D-15, D-45, D-56)`, () => {
    let db: PGlite;
    let edge: FakeEdge;

    async function insertDocument(owner: 'A' | 'B', options: { status?: string; isCurrent?: boolean; version?: number; provisional?: boolean; supersededBy?: string | null } = {}): Promise<string> {
      const id = crypto.randomUUID();
      const columns = ['id', 'filename', 'content', 'status', 'is_current', 'version', 'provisional', 'superseded_by', 'lineage_id'];
      const values: unknown[] = [id, 'rows.md', 'neutral body', options.status ?? 'ready', options.isCurrent ?? true, options.version ?? 1, options.provisional ?? false, options.supersededBy ?? null, id];
      if (multi) {
        columns.push('user_id');
        values.push(owner === 'A' ? FIXTURE_USER_ID : USER_B);
      }
      await db.query(`INSERT INTO documents (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, values);
      return id;
    }

    async function insertChunk(documentId: string, options: { profile?: string; index?: number; content?: string; plantTenant?: string } = {}): Promise<string> {
      const id = crypto.randomUUID();
      const insert = () =>
        db.query(
          `INSERT INTO document_chunks (id, document_id, content, metadata, chunk_index, chunking_profile_id, section_path${options.plantTenant ? ', tenant_key' : ''})
           VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, ARRAY['Zorvat']${options.plantTenant ? ', $6' : ''})`,
          [id, documentId, options.content ?? TABLE, options.index ?? 0, options.profile ?? 'legacy', ...(options.plantTenant ? [options.plantTenant] : [])],
        );
      if (options.plantTenant) await withReplica(db, insert);
      else await insert();
      return id;
    }

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      if (multi) await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [USER_B, 'fixture-user-b@example.invalid']);
      edge = await startFakeEdge({ db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
    });

    after(async () => {
      await edge?.close();
      await db?.close();
    });

    test('the four functions are SECURITY INVOKER with an empty search_path and executable by service_role only', async () => {
      await assertIndexerFunctions(db);
      for (const signature of SIGNATURES) {
        const exists = await db.query<{ ok: boolean }>('SELECT to_regprocedure($1) IS NOT NULL AS ok', [signature]);
        assert.equal(exists.rows[0]?.ok, true, `${signature} exists`);
        const privileges = await db.query<{ role: string; allowed: boolean }>(
          `SELECT r.role, has_function_privilege(r.role, $1, 'EXECUTE') AS allowed FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
          [signature],
        );
        assert.deepEqual(Object.fromEntries(privileges.rows.map((row) => [row.role, row.allowed])), { anon: false, authenticated: false, service_role: true }, signature);
        const definer = await db.query<{ secdef: boolean; config: string[] | null }>('SELECT prosecdef AS secdef, proconfig AS config FROM pg_proc WHERE oid = $1::regprocedure', [signature]);
        assert.equal(definer.rows[0]?.secdef, false, `${signature} is SECURITY INVOKER`);
        assert.ok((definer.rows[0]?.config ?? []).includes('search_path=""'), `${signature} has an empty search_path`);
      }
    });

    test('anon and authenticated are refused through the fake edge and by SET ROLE', async () => {
      await assertIndexerFunctions(db);
      const documentId = await insertDocument('A');
      for (const role of ['anon', 'authenticated'] as const) {
        await assert.rejects(
          () => asRole(db, role, () => db.query(READ_CHUNKS, [tenantA, documentId, null, 10])),
          (error: unknown) => sqlState(error) === '42501',
        );
      }
      const bodies: Record<string, Row> = {
        rag_index_document_chunks: { p_tenant_key: tenantA, p_document_id: documentId, p_after: null, p_limit: 10 },
        rag_write_chunk_identifiers: { p_tenant_key: tenantA, p_document_id: documentId, p_rows: [] },
        rag_write_table_rows: { p_tenant_key: tenantA, p_document_id: documentId, p_chunking_profile_id: 'legacy', p_rows: [] },
        rag_index_backfill_documents: { p_tenant_key: tenantA, p_kind: 'tables', p_after: null, p_limit: 10 },
      };
      for (const fn of NEW_FUNCTIONS) {
        const res = await fetch(`${edge.url}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
          body: JSON.stringify(bodies[fn]),
        });
        assert.equal(res.status, 403, `${fn} answers ${res.status} to the anon key`);
        const body = (await res.json()) as { code?: string };
        assert.equal(body.code, '42501');
        assert.equal(JSON.stringify(body).includes(documentId), false);
      }
      const ok = await fetch(`${edge.url}/rest/v1/rpc/rag_index_document_chunks`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, 'content-type': 'application/json' },
        body: JSON.stringify(bodies.rag_index_document_chunks),
      });
      assert.equal(ok.status, 200);
    });

    test('a key of the other deployment mode or a malformed key is rejected with 22023 by every function', async () => {
      await assertIndexerFunctions(db);
      const documentId = await insertDocument('A');
      for (const key of [wrongModeKey, 'not-a-tenant']) {
        assert.equal(await failure(db, READ_CHUNKS, [key, documentId, null, 10]), '22023');
        assert.equal(await failure(db, WRITE_IDS, [key, documentId, '[]']), '22023');
        assert.equal(await failure(db, WRITE_ROWS, [key, documentId, 'legacy', '[]']), '22023');
        assert.equal(await failure(db, BACKFILL, [key, 'tables', null, 10]), '22023');
      }
    });

    test('rag_write_table_rows replaces the rows of one document and profile and copies version, is_current and status from the document', async () => {
      await assertIndexerFunctions(db);
      const documentId = await insertDocument('A', { status: 'processing', isCurrent: false, version: 3 });
      const legacy = await insertChunk(documentId);
      const child = await insertChunk(documentId, { profile: 'p-alt' });
      const first = await service(db, WRITE_ROWS, [tenantA, documentId, 'legacy', JSON.stringify([tableRow('k:t0', 0, [legacy]), tableRow('k:t0', 1, [legacy])])]);
      assert.deepEqual(first[0], { rows_written: 2, rows_deleted: 0 });
      await service(db, WRITE_ROWS, [tenantA, documentId, 'p-alt', JSON.stringify([tableRow('k:t0', 0, [child])])]);
      const second = await service(db, WRITE_ROWS, [tenantA, documentId, 'legacy', JSON.stringify([tableRow('k:t0', 0, [legacy], 'vatu')])]);
      assert.deepEqual(second[0], { rows_written: 1, rows_deleted: 2 });
      const stored = await db.query<Row>(
        'SELECT tenant_key, version, is_current, status, chunking_profile_id, table_key, row_index, header, cells, cell_norm, cell_tokens, chunk_ids FROM rag_table_rows WHERE document_id = $1 ORDER BY chunking_profile_id',
        [documentId],
      );
      assert.equal(stored.rows.length, 2);
      assert.deepEqual(stored.rows[0], {
        tenant_key: tenantA,
        version: 3,
        is_current: false,
        status: 'processing',
        chunking_profile_id: 'legacy',
        table_key: 'k:t0',
        row_index: 0,
        header: ['Kelmo', 'Darvi'],
        cells: { Kelmo: 'vatu 0', Darvi: 'rosk' },
        cell_norm: ['vatu', '0', 'rosk'],
        cell_tokens: [['vatu', '0'], ['rosk']],
        chunk_ids: [legacy],
      });
      assert.equal(stored.rows[1]?.chunking_profile_id, 'p-alt', 'the other profile keeps its row');
      await db.query("UPDATE documents SET status = 'ready', is_current = true WHERE id = $1", [documentId]);
      const followed = await db.query<Row>('SELECT DISTINCT is_current, status FROM rag_table_rows WHERE document_id = $1', [documentId]);
      assert.deepEqual(followed.rows, [{ is_current: true, status: 'ready' }], 'rows follow the document (0852 trigger)');
    });

    test('a chunk id of another document, another profile or another tenant is refused and nothing is written', async () => {
      await assertIndexerFunctions(db);
      const documentId = await insertDocument('A');
      const otherDocument = await insertDocument('A');
      const own = await insertChunk(documentId);
      const otherProfile = await insertChunk(documentId, { profile: 'p-alt' });
      const elsewhere = await insertChunk(otherDocument);
      const foreignTenant = multi ? await insertChunk(await insertDocument('B')) : await insertChunk(documentId, { plantTenant: tenantB });
      await service(db, WRITE_ROWS, [tenantA, documentId, 'legacy', JSON.stringify([tableRow('k:t0', 0, [own])])]);
      for (const bad of [elsewhere, otherProfile, foreignTenant]) {
        assert.equal(await failure(db, WRITE_ROWS, [tenantA, documentId, 'legacy', JSON.stringify([tableRow('k:t0', 0, [own]), tableRow('k:t0', 1, [bad])])]), '42501');
      }
      const kept = await db.query<Row>('SELECT row_index, chunk_ids FROM rag_table_rows WHERE document_id = $1', [documentId]);
      assert.deepEqual(kept.rows, [{ row_index: 0, chunk_ids: [own] }], 'the earlier rows are unchanged');
      if (multi) {
        const foreignDocument = await insertDocument('B');
        const foreignChunk = await insertChunk(foreignDocument);
        assert.equal(await failure(db, WRITE_ROWS, [tenantA, foreignDocument, 'legacy', JSON.stringify([tableRow('k:t0', 0, [foreignChunk])])]), '42501');
        const none = await db.query<Row>('SELECT count(*)::int AS n FROM rag_table_rows WHERE document_id = $1', [foreignDocument]);
        assert.equal(none.rows[0]?.n, 0);
      }
    });

    test('rows above the caps are rejected with 22023', async () => {
      await assertIndexerFunctions(db);
      const documentId = await insertDocument('A');
      const chunkId = await insertChunk(documentId);
      const many = Array.from({ length: 1001 }, (_, i) => tableRow('k:t0', i, [chunkId]));
      assert.equal(await failure(db, WRITE_ROWS, [tenantA, documentId, 'legacy', JSON.stringify(many)]), '22023');
      const wide = { ...tableRow('k:t0', 0, [chunkId]), header: Array.from({ length: 33 }, (_, i) => `h${i}`), cell_tokens: Array.from({ length: 33 }, () => []) };
      assert.equal(await failure(db, WRITE_ROWS, [tenantA, documentId, 'legacy', JSON.stringify([wide])]), '22023');
      const long = { ...tableRow('k:t0', 0, [chunkId]), cells: { Kelmo: 'q'.repeat(513), Darvi: 'rosk' } };
      assert.equal(await failure(db, WRITE_ROWS, [tenantA, documentId, 'legacy', JSON.stringify([long])]), '22023');
      const mismatch = { ...tableRow('k:t0', 0, [chunkId]), cell_tokens: [['plin']] };
      assert.equal(await failure(db, WRITE_ROWS, [tenantA, documentId, 'legacy', JSON.stringify([mismatch])]), '22023');
      assert.equal(await failure(db, READ_CHUNKS, [tenantA, documentId, null, 1001]), '22023');
      assert.equal(await failure(db, BACKFILL, [tenantA, 'everything', null, 10]), '22023');
    });

    test('rag_index_document_chunks pages one document of the tenant, every profile, and nothing of another tenant', async () => {
      await assertIndexerFunctions(db);
      const documentId = await insertDocument('A');
      const ids = [await insertChunk(documentId, { index: 0 }), await insertChunk(documentId, { index: 1 }), await insertChunk(documentId, { profile: 'p-alt', index: 0 })].sort();
      const planted = multi ? null : await insertChunk(documentId, { plantTenant: tenantB, index: 9 });
      const first = await service(db, READ_CHUNKS, [tenantA, documentId, null, 2]);
      assert.deepEqual(first.map((row) => row.id), ids.slice(0, 2));
      const rest = await service(db, READ_CHUNKS, [tenantA, documentId, first[1]?.id, 2]);
      assert.deepEqual(rest.map((row) => row.id), ids.slice(2));
      assert.deepEqual(Object.keys(first[0] ?? {}).sort(), ['chunk_index', 'chunking_profile_id', 'content', 'id', 'section_path']);
      assert.deepEqual(first[0]?.section_path, ['Zorvat']);
      if (planted) assert.equal([...first, ...rest].some((row) => row.id === planted), false);
      if (multi) {
        assert.deepEqual(await service(db, READ_CHUNKS, [tenantB, documentId, null, 10]), [], "tenant B reads nothing of tenant A's document");
      }
    });

    test('rag_index_backfill_documents lists ready current and superseded documents, not provisional or unfinished ones, of the tenant only', async () => {
      await assertIndexerFunctions(db);
      await db.exec('DELETE FROM rag_table_rows; DELETE FROM document_chunks; DELETE FROM documents;');
      const current = await insertDocument('A');
      const superseded = await insertDocument('A', { isCurrent: false, supersededBy: current });
      await insertDocument('A', { provisional: true });
      await insertDocument('A', { status: 'processing', isCurrent: false });
      await insertDocument('A', { status: 'failed', isCurrent: false });
      if (multi) await insertDocument('B');
      const listed = (await service(db, BACKFILL, [tenantA, 'tables', null, 100])).map((row) => row.document_id);
      assert.deepEqual(listed, [current, superseded].sort());
      const page = await service(db, BACKFILL, [tenantA, 'tables', null, 1]);
      assert.equal(page.length, 1);
      assert.deepEqual((await service(db, BACKFILL, [tenantA, 'tables', page[0]?.document_id, 10])).map((row) => row.document_id), listed.slice(1));

      const indexed = await insertChunk(current);
      await insertChunk(superseded);
      await service(db, WRITE_IDS, [tenantA, current, JSON.stringify([{ chunk_id: indexed, raw: [], norm: [] }])]);
      assert.deepEqual((await service(db, BACKFILL, [tenantA, 'identifiers', null, 100])).map((row) => row.document_id), [superseded]);
    });

    test('applying every migration a second time leaves the 0860 functions unchanged', async () => {
      await assertIndexerFunctions(db);
      const first = await functionDump(db);
      assert.equal(first.length, SIGNATURES.length);
      await applyMigrations(db, mode);
      assert.deepEqual(await functionDump(db), first);
    });
  });
}

describe('write stage on the two-tenant fixture: RAG_TABLE_LOOKUP (D-15, D-45, T-04.2-65)', () => {
  let fixture: TwoTenantDatabase;
  const fixtureDb = (): PGlite => fixture.db;
  let edge: FakeEdge;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let ingestDeps: typeof import('@/lib/rag/ingest/deps');
  let ingestConfig: typeof import('@/lib/rag/ingest/config');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let ragDeps: typeof import('@/lib/rag/deps');
  let ragConfig: typeof import('@/lib/rag/config');
  let activeChunking: typeof import('@/lib/rag/chunking/active');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let tableLookup: 'true' | 'false' = 'false';
  const KEY_A = `u:${TWO_TENANT_IDS.userA}`;
  const KEY_B = `u:${TWO_TENANT_IDS.userB}`;

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const scopeOf = (userId: string): TenantScope => scopeModule.mintScope('personal', userId, null);
  const indexerCalls = (): number => edge.calls.filter((call) => /\/rpc\/rag_(index_document_chunks|write_table_rows|write_chunk_identifiers|identifier_patterns_list)$/.test(call.path)).length;

  const documentText = (title: string, value: string): string =>
    `# ${title}\n\n## Zorvat\n\nBrelo tasku vimen orlat.\n\n| Kelmo | Darvi | Quenta |\n| --- | --- | --- |\n| ${value} 41 | rosk | 7 |\n| vatu 52 | ${value} | 9 |\n`;

  const upload = (userId: string, sourceKey: string, text: string) =>
    ingestModule.ingest({
      scope: scopeOf(userId),
      source: 'config_upload',
      sourceKey,
      text,
      filename: `${sourceKey.replace(/\//g, '-')}.md`,
      mimeType: 'text/markdown',
      docType: 'contract_legal',
      signal: new AbortController().signal,
    });

  before(async () => {
    const emptyCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'table-rows-corpus-'));
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
    ragConfig = await import('@/lib/rag/config');
    activeChunking = await import('@/lib/rag/chunking/active');
    scopeModule = await import('@/lib/rag/tenant/scope');
    objectStoreModule.setObjectStoreForTests((await import('../helpers/fake-object-store')).createFakeObjectStore());
    ingestConfig.resetIngestConfigForTests();
    ingestDeps.setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'off' }) });
    ragDeps.setRagDepsForTests({
      ragEnv: () => ({ RAG_TABLE_LOOKUP: tableLookup, ...(process.env.RAG_PIPELINE ? { RAG_PIPELINE: process.env.RAG_PIPELINE } : {}) }),
    });
  });

  afterEach(() => {
    mock.restoreAll();
    delete process.env.RAG_PIPELINE;
    ragConfig.resetRagConfigForTests();
  });

  after(async () => {
    objectStoreModule?.resetObjectStoreForTests();
    ingestDeps?.resetIngestDepsForTests();
    ingestConfig?.resetIngestConfigForTests();
    ragDeps?.resetRagDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  test('switch off: the document is ingested as before and no indexer function is called', async () => {
    await assertIndexerFunctions(fixtureDb());
    tableLookup = 'false';
    const calls = indexerCalls();
    const result = await upload(TWO_TENANT_IDS.userA, 'rows/off', documentText('Ledger off', 'kaso'));
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.warnings.filter((warning) => warning.startsWith('index_')), []);
    assert.equal(indexerCalls(), calls);
    assert.equal((await rows('SELECT count(*)::int AS n FROM rag_table_rows WHERE document_id = $1', [result.documentId]))[0]?.n, 0);
  });

  test('switch on: each tenant gets the rows of its own document, current and ready after publish', async () => {
    await assertIndexerFunctions(fixtureDb());
    tableLookup = 'true';
    const a = await upload(TWO_TENANT_IDS.userA, 'rows/one', documentText('Ledger A', 'lumo'));
    const b = await upload(TWO_TENANT_IDS.userB, 'rows/one', documentText('Ledger B', 'ferra'));
    for (const [result, key, value] of [
      [a, KEY_A, 'lumo'],
      [b, KEY_B, 'ferra'],
    ] as const) {
      assert.equal(result.status, 'ready');
      const stored = await rows('SELECT * FROM rag_table_rows WHERE document_id = $1 ORDER BY row_index', [result.documentId]);
      assert.equal(stored.length, 2, `${key} has two rows`);
      for (const row of stored) {
        assert.equal(row.tenant_key, key);
        assert.equal(row.version, 1);
        assert.equal(row.is_current, true);
        assert.equal(row.status, 'ready');
        assert.equal(row.chunking_profile_id, 'legacy');
        assert.deepEqual(row.header, ['Kelmo', 'Darvi', 'Quenta']);
        const owners = await rows('SELECT DISTINCT document_id, tenant_key FROM document_chunks WHERE id = ANY($1::uuid[])', [row.chunk_ids]);
        assert.deepEqual(owners, [{ document_id: result.documentId, tenant_key: key }]);
      }
      assert.deepEqual(stored[0]?.cells, { Kelmo: `${value} 41`, Darvi: 'rosk', Quenta: '7' });
    }
    const crossed = await rows('SELECT r.id FROM rag_table_rows r JOIN documents d ON d.id = r.document_id WHERE r.tenant_key <> d.tenant_key');
    assert.deepEqual(crossed, [], 'no row is stored under a tenant other than its document');
  });

  test('a new version gets its own rows; the old version keeps its rows with is_current false', async () => {
    await assertIndexerFunctions(fixtureDb());
    tableLookup = 'true';
    const first = await rows("SELECT id FROM documents WHERE tenant_key = $1 AND source_key = 'rows/one' AND is_current", [KEY_A]);
    const oldId = String(first[0]?.id);
    const next = await upload(TWO_TENANT_IDS.userA, 'rows/one', documentText('Ledger A', 'grumo'));
    assert.equal(next.status, 'ready');
    assert.equal(next.version, 2);
    const old = await rows('SELECT DISTINCT is_current, version FROM rag_table_rows WHERE document_id = $1', [oldId]);
    assert.deepEqual(old, [{ is_current: false, version: 1 }]);
    const fresh = await rows('SELECT DISTINCT is_current, version FROM rag_table_rows WHERE document_id = $1', [next.documentId]);
    assert.deepEqual(fresh, [{ is_current: true, version: 2 }]);
  });

  test('RAG_PIPELINE=v2 dual-write: the rows are stored for the legacy chunks and for the building profile children', async () => {
    await assertIndexerFunctions(fixtureDb());
    tableLookup = 'true';
    await fixture.db.query(
      `INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
       VALUES ('p256', 'contract_legal', 256, 'none', NULL, 'building', '256/1024') ON CONFLICT (id, doc_type) DO NOTHING`,
    );
    process.env.RAG_PIPELINE = 'v2';
    ragConfig.resetRagConfigForTests();
    await activeChunking.refreshActiveChunkingProfiles();
    const result = await upload(TWO_TENANT_IDS.userB, 'rows/dual', documentText('Ledger dual', 'sevo'));
    assert.equal(result.status, 'ready');
    const profiles = await rows('SELECT chunking_profile_id, count(*)::int AS n FROM rag_table_rows WHERE document_id = $1 GROUP BY 1 ORDER BY 1', [result.documentId]);
    assert.deepEqual(profiles, [
      { chunking_profile_id: 'legacy', n: 2 },
      { chunking_profile_id: 'p256', n: 2 },
    ]);
    const children = await rows(
      "SELECT r.chunk_ids FROM rag_table_rows r WHERE r.document_id = $1 AND r.chunking_profile_id = 'p256'",
      [result.documentId],
    );
    for (const child of children) {
      const owner = await rows('SELECT DISTINCT chunking_profile_id FROM document_chunks WHERE id = ANY($1::uuid[])', [child.chunk_ids]);
      assert.deepEqual(owner, [{ chunking_profile_id: 'p256' }]);
    }
    await fixture.db.query("DELETE FROM chunking_profiles WHERE id = 'p256'");
  });

  test('an indexer failure never fails ingestion: published, one [Ingest] warning with the error class, index_tables_failed in the warnings', async () => {
    await assertIndexerFunctions(fixtureDb());
    tableLookup = 'true';
    const warn = mock.method(console, 'warn', () => undefined);
    await fixture.db.query('ALTER FUNCTION public.rag_write_table_rows(text, uuid, text, jsonb) RENAME TO rag_write_table_rows_disabled');
    try {
      const result = await upload(TWO_TENANT_IDS.userA, 'rows/fails', documentText('Ledger fails', 'pirra'));
      assert.equal(result.status, 'ready');
      assert.equal(result.version, 1);
      assert.ok(result.warnings.includes('index_tables_failed'), JSON.stringify(result.warnings));
      const document = await rows('SELECT status, is_current FROM documents WHERE id = $1', [result.documentId]);
      assert.deepEqual(document, [{ status: 'ready', is_current: true }]);
      const lines = warn.mock.calls.filter((call) => String(call.arguments[0]).startsWith('[Ingest] lookup indexing failed'));
      assert.equal(lines.length, 1);
      const detail = lines[0]?.arguments[1] as Record<string, unknown>;
      assert.equal(detail.code, 'index_tables_failed');
      assert.equal(detail.error, 'IngestWriterError');
      assert.equal(JSON.stringify(detail).includes('pirra'), false, 'no cell value is logged');
    } finally {
      await fixture.db.query('ALTER FUNCTION public.rag_write_table_rows_disabled(text, uuid, text, jsonb) RENAME TO rag_write_table_rows');
    }
  });

  describe('backfill command rag:table-rows (D-15, T-04.2-120)', () => {
    const ROW_COLUMNS = 'document_id, tenant_key, chunking_profile_id, table_key, row_index, header, cells, chunk_ids, version, is_current, status';
    const tenantRows = (key: string) => rows(`SELECT ${ROW_COLUMNS} FROM rag_table_rows WHERE tenant_key = $1 ORDER BY document_id, chunking_profile_id, table_key, row_index`, [key]);
    const knownUsers = new Set<string>([TWO_TENANT_IDS.userA, TWO_TENANT_IDS.userB]);
    const fakeAuthAdmin = () => ({
      auth: {
        admin: {
          getUserById: async (id: string) =>
            knownUsers.has(id) ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'not found', status: 404 } },
        },
      },
      from: () => {
        throw new Error('not used');
      },
    });
    const run = async (argv: string[], signal?: AbortSignal, onLine?: (line: string) => void) => {
      const cli = await import('@/lib/rag/tables/cli');
      const out: string[] = [];
      const err: string[] = [];
      const code = await cli.main(argv, { out: (line) => (out.push(line), onLine?.(line)), err: (line) => err.push(line) }, signal);
      return { code, out, err };
    };
    const eligible = async (key: string) =>
      rows(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE is_current)::int AS current FROM documents
         WHERE tenant_key = $1 AND status = 'ready' AND NOT provisional AND (is_current OR superseded_by IS NOT NULL)`,
        [key],
      );

    before(async () => {
      tableLookup = 'false';
      ragDeps.setRagDepsForTests({ adminClient: () => fakeAuthAdmin() as never });
      // Existing documents without rows: tenant A's rows are cleared, as if they were stored before the switch existed.
      await fixture.db.query('DELETE FROM rag_table_rows WHERE tenant_key = $1', [KEY_A]);
    });

    test('a dry run counts current and superseded documents per tenant and writes nothing', async () => {
      await assertIndexerFunctions(fixtureDb());
      const bRows = await tenantRows(KEY_B);
      const result = await run(['--tenant', KEY_A, '--dry-run']);
      assert.equal(result.code, 0, result.err.join('\n'));
      const [count] = await eligible(KEY_A);
      assert.ok((count?.n as number) > (count?.current as number), 'tenant A has a superseded version');
      assert.ok(result.out.includes(`[RAG Tables] dry run, nothing written`), result.out.join('\n'));
      assert.ok(
        result.out.includes(`[RAG Tables] ${KEY_A}: would index ${count?.n} documents (${count?.current} current, ${(count?.n as number) - (count?.current as number)} superseded)`),
        result.out.join('\n'),
      );
      assert.deepEqual(await tenantRows(KEY_A), []);
      assert.deepEqual(await tenantRows(KEY_B), bRows);
    });

    test('a key that does not resolve or belongs to the other deployment mode exits 2 and writes nothing', async () => {
      const stranger = await run(['--tenant', 'u:00000000-0000-4000-8000-00000000ffff']);
      assert.equal(stranger.code, 2, stranger.err.join('\n'));
      const single = await run(['--tenant', 's:default', '--dry-run']);
      assert.equal(single.code, 2, single.err.join('\n'));
      assert.deepEqual(await tenantRows(KEY_A), []);
    });

    test('an interrupted run stops between batches with exit code 130 and a resume cursor', async () => {
      const controller = new AbortController();
      const result = await run(['--tenant', KEY_A, '--batch-size', '1'], controller.signal, (line) => {
        if (/ batch 1:/.test(line)) controller.abort(new Error('interrupted'));
      });
      assert.equal(result.code, 130, [...result.out, ...result.err].join('\n'));
      assert.ok(result.err.some((line) => new RegExp(`--tenant ${KEY_A} --resume-after [0-9a-f-]{36}`).test(line)), result.err.join('\n'));
      await fixture.db.query('DELETE FROM rag_table_rows WHERE tenant_key = $1', [KEY_A]);
    });

    test('a real run writes the rows of current and superseded documents of that tenant only; counts only in the output', async () => {
      const bRows = await tenantRows(KEY_B);
      const result = await run(['--tenant', KEY_A, '--batch-size', '2']);
      assert.equal(result.code, 0, [...result.out, ...result.err].join('\n'));
      assert.ok(result.out.some((line) => line.includes('after npm run rag:rechunk')), 'the run states when to run it');
      const stored = await tenantRows(KEY_A);
      const [off] = await rows("SELECT id FROM documents WHERE tenant_key = $1 AND source_key = 'rows/off'", [KEY_A]);
      assert.equal(stored.filter((row) => row.document_id === off?.id).length, 2, 'a document ingested with the switch off gets its rows');
      const superseded = await rows("SELECT id FROM documents WHERE tenant_key = $1 AND source_key = 'rows/one' AND NOT is_current", [KEY_A]);
      assert.equal(superseded.length, 1);
      const old = stored.filter((row) => row.document_id === superseded[0]?.id);
      assert.equal(old.length, 2, 'the superseded version gets its rows');
      for (const row of old) assert.deepEqual([row.is_current, row.version], [false, 1]);
      for (const row of stored) assert.equal(row.tenant_key, KEY_A);
      assert.deepEqual(await tenantRows(KEY_B), bRows, "tenant B's rows are untouched");
      for (const line of [...result.out, ...result.err]) {
        for (const value of ['Kelmo', 'Darvi', 'lumo', 'kaso', 'grumo', 'rosk']) assert.equal(line.includes(value), false, `no cell or header in the output: ${line}`);
      }
      assert.ok(result.out.some((line) => new RegExp(`^\\[RAG Tables\\] ${KEY_A}: \\d+ documents indexed, 0 failed, ${stored.length} rows written`).test(line)), result.out.join('\n'));
    });

    test('running it again leaves the same rows', async () => {
      const before = await tenantRows(KEY_A);
      assert.ok(before.length > 0);
      const again = await run(['--tenant', KEY_A]);
      assert.equal(again.code, 0, again.err.join('\n'));
      assert.deepEqual(await tenantRows(KEY_A), before);
    });
  });
});

// Runs after the two-tenant suite, whose before() sets the fixture environment the app modules read at import.
describe('single-tenant: indexDocumentForLookup writes table rows through the tenant-bound writer', () => {
  let db: PGlite;
  const fixtureDb = (): PGlite => db;

  before(async () => {
    ({ db } = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' }));
  });

  after(async () => {
    await db?.close();
  });

  test('a seeded document gets its rows for every profile; a header-less continuation chunk joins the table', async () => {
    await assertIndexerFunctions(fixtureDb());
    const { createIngestWriter } = await import('@/lib/rag/ingest/writer');
    const { indexDocumentForLookup } = await import('@/lib/rag/ingest/write-indexers');
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const documentId = crypto.randomUUID();
    await db.query("INSERT INTO documents (id, filename, content, status, is_current, lineage_id) VALUES ($1, 'rows.md', '', 'ready', true, $1)", [documentId]);
    const chunk = async (index: number, content: string, profile = 'legacy'): Promise<string> => {
      const id = crypto.randomUUID();
      await db.query(
        "INSERT INTO document_chunks (id, document_id, content, metadata, chunk_index, chunking_profile_id, section_path) VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, ARRAY['Zorvat'])",
        [id, documentId, content, index, profile],
      );
      return id;
    };
    const first = await chunk(0, `Brelo tasku.\n\n${TABLE}`);
    const second = await chunk(1, '| tiro 63 | salvo | 11 |');
    await chunk(0, TABLE, 'p-alt');
    const scope = mintScope('single', null, null);
    const writer = createIngestWriter({ db: serviceRpc(db), scope, signal: new AbortController().signal });
    const report = await indexDocumentForLookup({ writer, scope, documentId, tables: true, identifiers: false, signal: new AbortController().signal });
    assert.deepEqual(report.warnings, []);
    assert.equal(report.tables?.rowsWritten, 5);
    const rows = await db.query<Row>('SELECT chunking_profile_id, table_key, row_index, cells, chunk_ids FROM rag_table_rows WHERE document_id = $1 ORDER BY chunking_profile_id, row_index', [documentId]);
    assert.deepEqual(
      rows.rows.map((row) => [row.chunking_profile_id, row.table_key, row.row_index]),
      [
        ['legacy', `${documentId}:t0`, 0],
        ['legacy', `${documentId}:t0`, 1],
        ['legacy', `${documentId}:t0`, 2],
        ['p-alt', `${documentId}:t0`, 0],
        ['p-alt', `${documentId}:t0`, 1],
      ],
    );
    assert.deepEqual(rows.rows[2]?.cells, { Kelmo: 'tiro 63', Darvi: 'salvo', Quenta: '11' });
    assert.deepEqual(rows.rows[2]?.chunk_ids, [second]);
    assert.deepEqual(rows.rows[0]?.chunk_ids, [first]);
  });
});
