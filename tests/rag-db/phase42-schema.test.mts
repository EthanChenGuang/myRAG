import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const ANON_KEY = 'fixture-anon-key-placeholder';
const SERVICE_KEY = 'fixture-service-role-key-placeholder';
const PHASE42_FILES = [
  'supabase/migrations/0851_lexical_dict_version.sql',
  'supabase/migrations/0852_rag_table_rows.sql',
  'supabase/migrations/0853_dup_clusters.sql',
  'supabase/migrations/0854_identifier_index.sql',
];
const NEW_TABLES = ['rag_table_rows', 'rag_dup_clusters', 'rag_identifier_patterns'] as const;
const NEW_CHUNK_COLUMNS: Record<string, string> = {
  lexical_dict_version: 'text',
  dup_cluster_id: 'uuid',
  simhash: 'bigint',
  identifiers_norm: 'text[]',
  identifiers_raw: 'text[]',
};
const NEW_DOCUMENT_COLUMNS: Record<string, string> = { identifiers_norm: 'text[]', identifiers_raw: 'text[]' };
const PURGE_HOOKS = ['rag_purge_hook_table_rows', 'rag_purge_hook_dup_clusters', 'rag_purge_hook_identifiers'];
const PROFILE = 'openai-3-small-1536';

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return sqlState(error) || String(error);
  }
}

async function tableExists(db: PGlite, table: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`]);
  return result.rows[0]?.present === true;
}

async function columnTypes(db: PGlite, table: string): Promise<Record<string, string>> {
  const result = await db.query<{ column: string; type: string }>(
    `SELECT a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type
     FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
    [`public.${table}`],
  );
  return Object.fromEntries(result.rows.map((row) => [row.column, row.type]));
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated' | 'service_role', run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [FIXTURE_USER_ID]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function assertPhase42Schema(db: PGlite): Promise<void> {
  for (const table of NEW_TABLES) assert.ok(await tableExists(db, table), `${table} exists`);
  const chunk = await columnTypes(db, 'document_chunks');
  for (const column of Object.keys(NEW_CHUNK_COLUMNS)) assert.ok(column in chunk, `document_chunks.${column} exists`);
}

/** Public schema objects that the four files create or touch; equal before and after a second application. */
async function schemaDump(db: PGlite): Promise<string[]> {
  const queries = [
    `SELECT 'col' AS k, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attnum > 0 AND NOT a.attisdropped`,
    `SELECT 'con' AS k, conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
    `SELECT 'idx' AS k, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    `SELECT 'trg' AS k, tgrelid::regclass::text, tgname, pg_get_triggerdef(oid) FROM pg_trigger
     WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)`,
    `SELECT 'fn' AS k, p.oid::regprocedure::text, pg_get_functiondef(p.oid), p.proacl::text FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'rag\\_%' AND p.prokind = 'f'`,
    `SELECT 'tbl' AS k, c.relname, c.relrowsecurity, c.relacl::text FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`,
    `SELECT 'pol' AS k, tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public'`,
  ];
  const out: string[] = [];
  for (const sql of queries) for (const row of (await db.query(sql)).rows) out.push(JSON.stringify(row));
  return out.sort();
}

for (const mode of MODES) {
  describe(`Phase 4.2 schema 0851-0854 (${mode})`, () => {
    let db: PGlite;
    let edge: FakeEdge;
    const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
    const foreignTenant = `u:${crypto.randomUUID()}`;

    async function insertDocument(): Promise<string> {
      const id = crypto.randomUUID();
      if (mode === 'multi-tenant') {
        await db.query("INSERT INTO documents (id, filename, content, user_id) VALUES ($1, 'p42.md', 'neutral body', $2)", [id, FIXTURE_USER_ID]);
      } else {
        await db.query("INSERT INTO documents (id, filename, content) VALUES ($1, 'p42.md', 'neutral body')", [id]);
      }
      return id;
    }

    async function insertChunk(documentId: string, metadata: Record<string, unknown> = {}): Promise<string> {
      const id = crypto.randomUUID();
      await db.query("INSERT INTO document_chunks (id, document_id, content, metadata) VALUES ($1, $2, 'neutral chunk text', $3::jsonb)", [
        id,
        documentId,
        JSON.stringify(metadata),
      ]);
      return id;
    }

    async function insertCluster(tenantKey = tenant): Promise<string> {
      const id = crypto.randomUUID();
      await db.query('INSERT INTO rag_dup_clusters (id, tenant_key, embedding_profile_id) VALUES ($1, $2, $3)', [id, tenantKey, PROFILE]);
      return id;
    }

    async function isDirty(clusterId: string): Promise<boolean | undefined> {
      return (await db.query<{ dirty: boolean }>('SELECT dirty FROM rag_dup_clusters WHERE id = $1', [clusterId])).rows[0]?.dirty;
    }

    before(async () => {
      db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS })).db;
      edge = await startFakeEdge({ db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
    });

    after(async () => {
      await edge?.close();
      await db?.close();
    });

    test('new chunk and document columns exist with their types and are null on every seeded row', async () => {
      const chunk = await columnTypes(db, 'document_chunks');
      for (const [column, type] of Object.entries(NEW_CHUNK_COLUMNS)) assert.equal(chunk[column], type, `document_chunks.${column}`);
      const document = await columnTypes(db, 'documents');
      for (const [column, type] of Object.entries(NEW_DOCUMENT_COLUMNS)) assert.equal(document[column], type, `documents.${column}`);
      const seeded = await db.query<{ total: number; set: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE lexical_dict_version IS NOT NULL OR dup_cluster_id IS NOT NULL OR simhash IS NOT NULL
                                    OR identifiers_norm IS NOT NULL OR identifiers_raw IS NOT NULL)::int AS set
         FROM document_chunks`,
      );
      assert.ok((seeded.rows[0]?.total ?? 0) > 0, 'the corpus seeds chunks');
      assert.equal(seeded.rows[0]?.set, 0);
      const docs = await db.query<{ set: number }>('SELECT count(*) FILTER (WHERE identifiers_norm IS NOT NULL OR identifiers_raw IS NOT NULL)::int AS set FROM documents');
      assert.equal(docs.rows[0]?.set, 0);
    });

    test('the three new tables exist, RLS on with zero policies, service_role only', async () => {
      for (const table of NEW_TABLES) {
        assert.ok(await tableExists(db, table), `${table} exists`);
        const rls = await db.query<{ enabled: boolean; policies: number }>(
          `SELECT c.relrowsecurity AS enabled, (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = $1) AS policies
           FROM pg_class c WHERE c.oid = to_regclass($2)`,
          [table, `public.${table}`],
        );
        assert.deepEqual(rls.rows[0], { enabled: true, policies: 0 }, table);
        const privileges = await db.query<{ role: string; select: boolean; insert: boolean; update: boolean; delete: boolean }>(
          `SELECT r.role, has_table_privilege(r.role, $1, 'SELECT') AS select, has_table_privilege(r.role, $1, 'INSERT') AS insert,
                  has_table_privilege(r.role, $1, 'UPDATE') AS update, has_table_privilege(r.role, $1, 'DELETE') AS delete
           FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
          [`public.${table}`],
        );
        for (const row of privileges.rows) {
          const expected = row.role === 'service_role';
          assert.deepEqual([row.select, row.insert, row.update, row.delete], [expected, expected, expected, expected], `${table} ${row.role}`);
        }
      }
    });

    test('rag_table_rows has its unique row key and the cell_norm GIN index', async () => {
      await assertPhase42Schema(db);
      const columns = await columnTypes(db, 'rag_table_rows');
      assert.deepEqual(
        Object.keys(columns).sort(),
        ['cell_norm', 'cell_tokens', 'cells', 'chunk_ids', 'chunking_profile_id', 'created_at', 'document_id', 'header', 'id', 'is_current', 'row_index', 'status', 'table_key', 'tenant_key', 'version'].sort(),
      );
      assert.equal(columns.header, 'text[]');
      assert.equal(columns.cell_norm, 'text[]');
      assert.equal(columns.cells, 'jsonb');
      assert.equal(columns.cell_tokens, 'jsonb');
      assert.equal(columns.chunk_ids, 'uuid[]');
      const unique = await db.query<{ def: string }>(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.rag_table_rows'::regclass AND contype = 'u'",
      );
      assert.deepEqual(unique.rows.map((row) => row.def), ['UNIQUE (document_id, chunking_profile_id, table_key, row_index)']);
      const gin = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'rag_table_rows' AND indexdef ILIKE '%USING gin (cell_norm)%'",
      );
      assert.equal(gin.rows[0]?.n, 1);
    });

    test('anon and authenticated can neither read nor write the new tables; service_role can', async () => {
      await assertPhase42Schema(db);
      const documentId = await insertDocument();
      const inserts: Record<(typeof NEW_TABLES)[number], [string, unknown[]]> = {
        rag_table_rows: ["INSERT INTO rag_table_rows (document_id, table_key, row_index) VALUES ($1, 't1', $2)", [documentId]],
        rag_dup_clusters: ['INSERT INTO rag_dup_clusters (tenant_key, embedding_profile_id) VALUES ($1, $2)', [tenant, PROFILE]],
        rag_identifier_patterns: ["INSERT INTO rag_identifier_patterns (tenant_key, name, pattern) VALUES ($1, $2, '[A-Z]{2}[0-9]{4}')", [tenant]],
      };
      let rowIndex = 0;
      const params = (table: (typeof NEW_TABLES)[number]): unknown[] => {
        rowIndex += 1;
        const [, base] = inserts[table];
        if (table === 'rag_table_rows') return [base[0], rowIndex];
        if (table === 'rag_identifier_patterns') return [base[0], `pattern-${rowIndex}`];
        return base;
      };
      for (const table of NEW_TABLES) {
        for (const role of ['anon', 'authenticated'] as const) {
          assert.equal(await asRole(db, role, () => failure(db, `SELECT 1 FROM ${table} LIMIT 1`)), '42501', `${role} select ${table}`);
          assert.equal(await asRole(db, role, () => failure(db, inserts[table][0], params(table))), '42501', `${role} insert ${table}`);
        }
        await asRole(db, 'service_role', async () => {
          await db.query(inserts[table][0], params(table));
          const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
          assert.ok((count.rows[0]?.n ?? 0) >= 1, `service_role reads ${table}`);
        });
      }
    });

    test('the fake edge with the anon key returns an error and no row', async () => {
      await assertPhase42Schema(db);
      const ids = (await db.query<{ id: string }>('SELECT id::text AS id FROM rag_table_rows UNION ALL SELECT id::text FROM rag_dup_clusters UNION ALL SELECT id::text FROM rag_identifier_patterns')).rows.map(
        (row) => row.id,
      );
      for (const table of NEW_TABLES) {
        const response = await fetch(`${edge.url}/rest/v1/${table}?select=id`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${ANON_KEY}` } });
        const body = await response.text();
        assert.ok(response.status >= 400, `${table} status ${response.status}`);
        for (const id of ids) assert.ok(!body.includes(id));
      }
    });

    test('lexical_dict_version copies a well-formed metadata key, keeps its value without the key and ignores a malformed one', async () => {
      await assertPhase42Schema(db);
      const documentId = await insertDocument();
      const read = async (id: string) =>
        (await db.query<{ v: string | null }>('SELECT lexical_dict_version AS v FROM document_chunks WHERE id = $1', [id])).rows[0]?.v;
      const plain = await insertChunk(documentId);
      assert.equal(await read(plain), null);
      const shared = await insertChunk(documentId, { lexical_dict_version: 's12' });
      assert.equal(await read(shared), 's12');
      const layered = await insertChunk(documentId, { lexical_dict_version: 's12.w3' });
      assert.equal(await read(layered), 's12.w3');
      const malformed = await insertChunk(documentId, { lexical_dict_version: 'x12; drop' });
      assert.equal(await read(malformed), null);
      await db.query("UPDATE document_chunks SET metadata = '{\"other\": 1}'::jsonb WHERE id = $1", [layered]);
      assert.equal(await read(layered), 's12.w3', 'a write without the key leaves the column');
      await db.query("UPDATE document_chunks SET metadata = '{\"lexical_dict_version\": \"s13.w4\"}'::jsonb WHERE id = $1", [layered]);
      assert.equal(await read(layered), 's13.w4');
      await db.query("UPDATE document_chunks SET metadata = '{\"lexical_dict_version\": \"s14.\"}'::jsonb WHERE id = $1", [layered]);
      assert.equal(await read(layered), 's13.w4', 'a malformed value is ignored');
      await db.query("UPDATE document_chunks SET metadata = '{\"lexical_dict_version\": 15}'::jsonb WHERE id = $1", [layered]);
      assert.equal(await read(layered), 's13.w4', 'a non-string value is ignored');
    });

    test('rag_table_rows takes its tenant from the document and refuses another tenant', async () => {
      await assertPhase42Schema(db);
      const documentId = await insertDocument();
      const row = await db.query<{ tenant_key: string; version: number; is_current: boolean; status: string }>(
        "INSERT INTO rag_table_rows (document_id, table_key, row_index, cells) VALUES ($1, 't1', 0, '{\"a\": \"x\"}') RETURNING tenant_key, version, is_current, status",
        [documentId],
      );
      assert.deepEqual(row.rows[0], { tenant_key: tenant, version: 1, is_current: true, status: 'ready' });
      assert.equal(
        await failure(db, "INSERT INTO rag_table_rows (tenant_key, document_id, table_key, row_index) VALUES ($1, $2, 't1', 1)", [foreignTenant, documentId]),
        '42501',
      );
      assert.equal(await failure(db, "UPDATE rag_table_rows SET tenant_key = $1 WHERE document_id = $2", [foreignTenant, documentId]), '42501');
    });

    test('rag_table_rows follow their document: is_current, status and delete', async () => {
      await assertPhase42Schema(db);
      const documentId = await insertDocument();
      const other = await insertDocument();
      await db.query("INSERT INTO rag_table_rows (document_id, table_key, row_index) VALUES ($1, 't1', 0), ($1, 't1', 1), ($2, 't1', 0)", [documentId, other]);
      const state = async (id: string) =>
        (await db.query<{ is_current: boolean; status: string }>('SELECT DISTINCT is_current, status FROM rag_table_rows WHERE document_id = $1', [id])).rows;

      await db.query('UPDATE documents SET is_current = false WHERE id = $1', [documentId]);
      assert.deepEqual(await state(documentId), [{ is_current: false, status: 'ready' }]);
      assert.deepEqual(await state(other), [{ is_current: true, status: 'ready' }], 'other documents are untouched');

      await db.query("UPDATE documents SET status = 'quarantined' WHERE id = $1", [documentId]);
      assert.deepEqual(await state(documentId), [{ is_current: false, status: 'quarantined' }]);

      await db.query("UPDATE documents SET filename = 'renamed.md' WHERE id = $1", [other]);
      assert.deepEqual(await state(other), [{ is_current: true, status: 'ready' }]);

      await db.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);
      await db.query('DELETE FROM documents WHERE id = $1', [documentId]);
      assert.deepEqual(await state(documentId), []);
    });

    test('a chunk can point only to a duplicate cluster of its own tenant', async () => {
      await assertPhase42Schema(db);
      const documentId = await insertDocument();
      const chunkId = await insertChunk(documentId);
      const own = await insertCluster();
      await db.query('UPDATE document_chunks SET dup_cluster_id = $1 WHERE id = $2', [own, chunkId]);
      if (mode === 'single-tenant') {
        assert.equal(await failure(db, 'INSERT INTO rag_dup_clusters (tenant_key, embedding_profile_id) VALUES ($1, $2)', [foreignTenant, PROFILE]), '22023');
        await db.exec("SET session_replication_role = 'replica'");
      }
      let foreign: string;
      try {
        foreign = await insertCluster(foreignTenant);
      } finally {
        if (mode === 'single-tenant') await db.exec("SET session_replication_role = 'origin'");
      }
      assert.equal(await failure(db, 'UPDATE document_chunks SET dup_cluster_id = $1 WHERE id = $2', [foreign, chunkId]), '23503');
      const kept = await db.query<{ c: string }>('SELECT dup_cluster_id::text AS c FROM document_chunks WHERE id = $1', [chunkId]);
      assert.equal(kept.rows[0]?.c, own);
      assert.equal(await failure(db, 'INSERT INTO rag_dup_clusters (tenant_key, embedding_profile_id) VALUES ($1, $2)', ['not-a-tenant', PROFILE]), '22023');
    });

    test('deleting, superseding or changing the status of a chunk marks its former cluster dirty; other updates do not', async () => {
      await assertPhase42Schema(db);
      const documentId = await insertDocument();
      const cluster = await insertCluster();
      const [a, b, c, d] = [await insertChunk(documentId), await insertChunk(documentId), await insertChunk(documentId), await insertChunk(documentId)];
      await db.query('UPDATE document_chunks SET dup_cluster_id = $1 WHERE id = ANY ($2::uuid[])', [cluster, [a, b, c, d]]);
      const reset = () => db.query('UPDATE rag_dup_clusters SET dirty = false WHERE id = $1', [cluster]);
      await reset();

      await db.query("UPDATE document_chunks SET content = 'edited neutral text', simhash = 42 WHERE id = $1", [a]);
      assert.equal(await isDirty(cluster), false, 'an unrelated update marks nothing');

      await db.query('UPDATE document_chunks SET is_current = false WHERE id = $1', [a]);
      assert.equal(await isDirty(cluster), true, 'is_current change');
      await reset();

      await db.query("UPDATE document_chunks SET status = 'quarantined' WHERE id = $1", [b]);
      assert.equal(await isDirty(cluster), true, 'status change');
      await reset();

      await db.query('DELETE FROM document_chunks WHERE id = $1', [c]);
      assert.equal(await isDirty(cluster), true, 'delete');
      await reset();

      const other = await insertCluster();
      await db.query('UPDATE document_chunks SET is_current = false WHERE id = $1', [d]);
      assert.equal(await isDirty(other), false, 'a cluster without the chunk stays clean');
    });

    test('deleting a cluster clears dup_cluster_id on its chunks and keeps their tenant', async () => {
      await assertPhase42Schema(db);
      const documentId = await insertDocument();
      const chunkId = await insertChunk(documentId);
      const cluster = await insertCluster();
      await db.query('UPDATE document_chunks SET dup_cluster_id = $1 WHERE id = $2', [cluster, chunkId]);
      await db.query('DELETE FROM rag_dup_clusters WHERE id = $1', [cluster]);
      const row = await db.query<{ c: string | null; t: string }>('SELECT dup_cluster_id::text AS c, tenant_key AS t FROM document_chunks WHERE id = $1', [chunkId]);
      assert.deepEqual(row.rows[0], { c: null, t: tenant });
    });

    test('identifier columns have GIN indexes; rag_identifier_patterns enforces its checks', async () => {
      await assertPhase42Schema(db);
      const gin = await db.query<{ tablename: string }>(
        "SELECT tablename FROM pg_indexes WHERE schemaname = 'public' AND indexdef ILIKE '%USING gin (identifiers_norm)%' ORDER BY tablename",
      );
      assert.deepEqual(gin.rows.map((row) => row.tablename), ['document_chunks', 'documents']);
      assert.deepEqual(
        Object.keys(await columnTypes(db, 'rag_identifier_patterns')).sort(),
        ['created_at', 'created_by', 'enabled', 'flags', 'id', 'name', 'pattern', 'tenant_key', 'updated_at'],
      );
      const insert = 'INSERT INTO rag_identifier_patterns (tenant_key, name, pattern, flags) VALUES ($1, $2, $3, $4)';
      await db.query(insert, [tenant, 'shape-a', '[A-Z]{3}-[0-9]{3}', 'iu']);
      assert.equal(await failure(db, insert, [tenant, 'shape-a', '[0-9]+', 'u']), '23505', 'unique per tenant and name');
      assert.equal(await failure(db, insert, [tenant, 'n'.repeat(81), '[0-9]+', 'u']), '23514', 'name length');
      assert.equal(await failure(db, insert, [tenant, 'shape-b', 'p'.repeat(201), 'u']), '23514', 'pattern length');
      assert.equal(await failure(db, insert, [tenant, 'shape-c', '[0-9]+', 'g']), '23514', 'flags');
      assert.equal(await failure(db, insert, [tenant, '   ', '[0-9]+', 'u']), '23514', 'blank name');
      assert.equal(await failure(db, insert, ['malformed', 'shape-d', '[0-9]+', 'u']), '22023', 'tenant key format');
      await db.query(insert, [tenant, 'n'.repeat(80), 'p'.repeat(200), 'u']);
    });

    test('purge hooks clear the purged documents only, refuse a malformed tenant and are service_role only', async () => {
      await assertPhase42Schema(db);
      const purged = await insertDocument();
      const kept = await insertDocument();
      const purgedChunk = await insertChunk(purged);
      const keptChunk = await insertChunk(kept);
      const cluster = await insertCluster();
      await db.query('UPDATE rag_dup_clusters SET source_document_ids = $1::uuid[], member_count = 2 WHERE id = $2', [[purged, kept], cluster]);
      await db.query('UPDATE document_chunks SET dup_cluster_id = $1, simhash = 7, identifiers_norm = $2, identifiers_raw = $2 WHERE id = ANY ($3::uuid[])', [
        cluster,
        ['ab12'],
        [purgedChunk, keptChunk],
      ]);
      await db.query('UPDATE documents SET identifiers_norm = $1, identifiers_raw = $1 WHERE id = ANY ($2::uuid[])', [['ab12'], [purged, kept]]);
      await db.query("INSERT INTO rag_table_rows (document_id, table_key, row_index) VALUES ($1, 't1', 0), ($2, 't1', 0)", [purged, kept]);
      await db.query('UPDATE rag_dup_clusters SET dirty = false WHERE id = $1', [cluster]);

      for (const hook of PURGE_HOOKS) {
        const removed = await db.query<{ n: string }>(`SELECT public.${hook}($1, NULL, $2::uuid[])::text AS n`, [tenant, [purged]]);
        assert.ok(Number(removed.rows[0]?.n) > 0, `${hook} changed rows`);
        assert.equal(await failure(db, `SELECT public.${hook}($1, NULL, $2::uuid[])`, ['malformed', [purged]]), '22023');
        const privileges = await db.query<{ role: string; allowed: boolean }>(
          `SELECT r.role, has_function_privilege(r.role, $1, 'EXECUTE') AS allowed FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
          [`public.${hook}(text, uuid, uuid[])`],
        );
        assert.deepEqual(Object.fromEntries(privileges.rows.map((row) => [row.role, row.allowed])), { anon: false, authenticated: false, service_role: true });
      }
      const rows = await db.query<{ d: string }>('SELECT document_id::text AS d FROM rag_table_rows WHERE document_id = ANY ($1::uuid[])', [[purged, kept]]);
      assert.deepEqual(rows.rows.map((row) => row.d), [kept]);
      const chunks = await db.query<{ id: string; c: string | null; s: string | null; n: string[] | null }>(
        'SELECT id::text, dup_cluster_id::text AS c, simhash::text AS s, identifiers_norm AS n FROM document_chunks WHERE id = ANY ($1::uuid[])',
        [[purgedChunk, keptChunk]],
      );
      const byId = Object.fromEntries(chunks.rows.map((row) => [row.id, row]));
      assert.deepEqual(byId[purgedChunk], { id: purgedChunk, c: null, s: null, n: null });
      assert.deepEqual(byId[keptChunk], { id: keptChunk, c: cluster, s: '7', n: ['ab12'] });
      const clusterRow = await db.query<{ ids: string[]; dirty: boolean }>('SELECT source_document_ids::text[] AS ids, dirty FROM rag_dup_clusters WHERE id = $1', [cluster]);
      assert.deepEqual(clusterRow.rows[0], { ids: [kept], dirty: true });
      const docs = await db.query<{ id: string; n: string[] | null }>('SELECT id::text, identifiers_norm AS n FROM documents WHERE id = ANY ($1::uuid[]) ORDER BY id = $2', [
        [purged, kept],
        kept,
      ]);
      assert.deepEqual(docs.rows, [{ id: purged, n: null }, { id: kept, n: ['ab12'] }]);
    });

    test('new trigger functions are not executable by anon or authenticated and have an empty search_path', async () => {
      const functions = await db.query<{ name: string; config: string[] | null; anon: boolean; authenticated: boolean }>(
        `SELECT p.proname AS name, p.proconfig AS config, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY ($1::text[]) ORDER BY 1`,
        [
          [
            'rag_chunk_lexical_dict_version',
            'rag_table_rows_guard',
            'rag_table_rows_follow_document',
            'rag_row_tenant_key_guard',
            'rag_dup_clusters_mark_dirty_delete',
            'rag_dup_clusters_mark_dirty_update',
            ...PURGE_HOOKS,
          ],
        ],
      );
      assert.equal(functions.rows.length, 6 + PURGE_HOOKS.length);
      for (const row of functions.rows) {
        assert.deepEqual(row.config, ['search_path=""'], `${row.name} search_path`);
        assert.equal(row.anon, false, `${row.name} anon`);
        assert.equal(row.authenticated, false, `${row.name} authenticated`);
      }
    });
  });

  describe(`Phase 4.2 migrations apply twice with the same schema (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
    });

    after(async () => {
      await db?.close();
    });

    test('0851-0854 applied again leave the schema dump unchanged', async () => {
      for (const table of NEW_TABLES) assert.ok(await tableExists(db, table), `${table} exists`);
      const first = await schemaDump(db);
      await applyMigrationFiles(db, PHASE42_FILES);
      const second = await schemaDump(db);
      assert.deepEqual(second, first);
    });
  });
}
