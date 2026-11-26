import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

type Row = Record<string, unknown>;

const MIGRATION = 'supabase/migrations/0864_purge_hooks.sql';
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const HOOKS = ['rag_purge_hook_table_rows', 'rag_purge_hook_duplicate_clusters'] as const;
const PROFILE = 'openai-3-small-1536';
const OTHER_USER_ID = '00000000-0000-4000-8000-0000000000b9';

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : '';
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return sqlState(error) || String(error);
  }
}

/** Runs the call as service_role in its own transaction, so a raised error leaves nothing behind. */
async function asServiceRole(db: PGlite, sql: string, params: unknown[]): Promise<Row[]> {
  return db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    return (await tx.query<Row>(sql, params)).rows;
  });
}

async function serviceFailure(db: PGlite, sql: string, params: unknown[]): Promise<string | null> {
  try {
    await asServiceRole(db, sql, params);
    return null;
  } catch (error) {
    return sqlState(error) || String(error);
  }
}

for (const mode of MODES) {
  describe(`Phase 4.2 purge hooks 0864 (${mode}): table rows and duplicate clusters (D-20, D-56)`, () => {
    let db: PGlite;
    const tenantA = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
    const tenantB = `u:${OTHER_USER_ID}`;
    const lineage = crypto.randomUUID();
    const ids = {
      v1: crypto.randomUUID(),
      v2: crypto.randomUUID(),
      d3: crypto.randomUUID(),
      d4: crypto.randomUUID(),
      d5: crypto.randomUUID(),
      b1: crypto.randomUUID(),
      b2: crypto.randomUUID(),
    };
    const chunks: Record<string, string> = {};
    const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query<Row>(sql, params)).rows;

    async function insertDocument(id: string, owner: string, options: { lineageId?: string; version?: number; current?: boolean } = {}): Promise<void> {
      const columns = ['id', 'filename', 'content', 'status', 'is_current', 'lineage_id', 'version'];
      const values: unknown[] = [id, `purge-${id.slice(0, 8)}.md`, 'neutral body', 'ready', options.current ?? true, options.lineageId ?? id, options.version ?? 1];
      if (mode === 'multi-tenant') {
        columns.push('user_id');
        values.push(owner);
      }
      await db.query(`INSERT INTO documents (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, values);
    }

    async function insertChunk(name: string, documentId: string, current = true): Promise<string> {
      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, chunk_index, status, is_current) VALUES ($1, $2, 'neutral chunk text', 0, 'ready', $3)`,
        [id, documentId, current],
      );
      chunks[name] = id;
      return id;
    }

    async function insertCluster(tenant: string, members: string[]): Promise<string> {
      const [cluster] = await rows(
        `INSERT INTO rag_dup_clusters (tenant_key, embedding_profile_id, member_count, source_document_ids)
         SELECT $1, $2, count(*)::int, array_agg(DISTINCT c.document_id) FROM document_chunks c WHERE c.id = ANY($3::uuid[])
         RETURNING id`,
        [tenant, PROFILE, members.map((name) => chunks[name])],
      );
      const id = String(cluster?.id);
      await db.query('UPDATE document_chunks SET dup_cluster_id = $1 WHERE id = ANY($2::uuid[])', [id, members.map((name) => chunks[name])]);
      return id;
    }

    async function insertBands(name: string, tenant: string): Promise<void> {
      for (let band = 0; band < 8; band += 1) {
        await db.query(
          `INSERT INTO rag_dup_chunk_bands (chunk_id, tenant_key, embedding_profile_id, chunking_profile_id, band, value) VALUES ($1, $2, $3, 'legacy', $4, $5)`,
          [chunks[name], tenant, PROFILE, band, (band * 31) % 256],
        );
      }
    }

    async function insertTableRows(documentId: string, count: number): Promise<void> {
      for (let row = 0; row < count; row += 1) {
        await db.query(
          `INSERT INTO rag_table_rows (document_id, table_key, row_index, header, cells) VALUES ($1, 't0', $2, '{col}'::text[], $3::jsonb)`,
          [documentId, row, JSON.stringify({ col: `cell ${row}` })],
        );
      }
    }

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      if (mode === 'multi-tenant') {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [OTHER_USER_ID, 'tenant-b@example.invalid']);
      }
      await insertDocument(ids.v1, FIXTURE_USER_ID, { lineageId: lineage, version: 1, current: false });
      await insertDocument(ids.v2, FIXTURE_USER_ID, { lineageId: lineage, version: 2 });
      await insertDocument(ids.d3, FIXTURE_USER_ID);
      await insertDocument(ids.d4, FIXTURE_USER_ID);
      await insertDocument(ids.d5, FIXTURE_USER_ID);
      if (mode === 'multi-tenant') {
        await insertDocument(ids.b1, OTHER_USER_ID);
        await insertDocument(ids.b2, OTHER_USER_ID);
      }

      await insertTableRows(ids.v1, 2);
      await insertTableRows(ids.v2, 3);
      await insertTableRows(ids.d3, 2);
      if (mode === 'multi-tenant') await insertTableRows(ids.b1, 2);

      await insertChunk('v1', ids.v1, false);
      await insertChunk('v2a', ids.v2);
      await insertChunk('v2b', ids.v2);
      await insertChunk('d3', ids.d3);
      await insertChunk('d4', ids.d4);
      await insertChunk('d5', ids.d5);
      if (mode === 'multi-tenant') {
        await insertChunk('b1', ids.b1);
        await insertChunk('b2', ids.b2);
      }
    });

    after(async () => {
      await db?.close();
    });

    test('both hooks exist once each: SECURITY INVOKER, empty search_path, service_role only', async () => {
      for (const hook of HOOKS) {
        const found = await rows(
          `SELECT p.oid::regprocedure::text AS signature, p.prosecdef, p.proconfig, pg_get_function_result(p.oid) AS result
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
          [hook],
        );
        assert.equal(found.length, 1, `${hook}: exactly one function`);
        const [fn] = found as [Row];
        assert.equal(fn.signature, `${hook}(text,uuid,uuid[])`);
        assert.equal(fn.result, 'bigint');
        assert.equal(fn.prosecdef, false, `${hook} is SECURITY INVOKER`);
        assert.ok((fn.proconfig as string[] | null)?.some((setting) => setting === 'search_path=""'), `${hook} has an empty search_path`);
        const [grants] = await rows(
          `SELECT has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated,
                  has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS service_role`,
          [`public.${hook}(text, uuid, uuid[])`],
        );
        assert.deepEqual(grants, { anon: false, authenticated: false, service_role: true }, hook);
      }
    });

    test('anon and authenticated cannot execute either hook', async () => {
      for (const role of ['anon', 'authenticated']) {
        for (const hook of HOOKS) {
          let code: string | null = null;
          try {
            await db.transaction(async (tx) => {
              await tx.exec(`SET LOCAL ROLE ${role}`);
              await tx.query(`SELECT public.${hook}($1, $2::uuid, $3::uuid[])`, [tenantA, lineage, [ids.v1]]);
            });
          } catch (error) {
            code = sqlState(error);
          }
          assert.equal(code, '42501', `${role} on ${hook}`);
        }
      }
    });

    test('a tenant key of the other deployment mode is rejected', async () => {
      const wrong = mode === 'multi-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;
      for (const hook of HOOKS) {
        const code = await serviceFailure(db, `SELECT public.${hook}($1, $2::uuid, $3::uuid[])`, [wrong, lineage, [ids.v1]]);
        assert.ok(code, `${hook} rejects ${wrong}`);
      }
    });

    test('ids outside the lineage or the tenant are refused and nothing is removed', async () => {
      const before = await rows('SELECT count(*)::int AS n FROM rag_table_rows');
      const outside = [[ids.v1, ids.d3]];
      if (mode === 'multi-tenant') outside.push([ids.v1, ids.b1]);
      for (const documentIds of outside) {
        for (const hook of HOOKS) {
          const code = await serviceFailure(db, `SELECT public.${hook}($1, $2::uuid, $3::uuid[])`, [tenantA, lineage, documentIds]);
          assert.equal(code, '22023', `${hook} refuses ${documentIds.join(',')}`);
        }
      }
      if (mode === 'multi-tenant') {
        const code = await serviceFailure(db, 'SELECT public.rag_purge_hook_table_rows($1, $2::uuid, $3::uuid[])', [tenantB, lineage, [ids.v1, ids.v2]]);
        assert.equal(code, '22023', 'another tenant cannot name these versions');
      }
      assert.deepEqual(await rows('SELECT count(*)::int AS n FROM rag_table_rows'), before);
    });

    test('rag_purge_hook_table_rows removes the rows of the given versions only and returns the count', async () => {
      const result = await asServiceRole(db, 'SELECT public.rag_purge_hook_table_rows($1, $2::uuid, $3::uuid[])::int AS n', [tenantA, lineage, [ids.v1, ids.v2]]);
      assert.equal(result[0]?.n, 5);
      const left = await rows('SELECT document_id, count(*)::int AS n FROM rag_table_rows GROUP BY document_id ORDER BY document_id');
      const expected = [{ document_id: ids.d3, n: 2 }];
      if (mode === 'multi-tenant') expected.push({ document_id: ids.b1, n: 2 });
      assert.deepEqual(left, expected.sort((a, b) => a.document_id.localeCompare(b.document_id)));
      const again = await asServiceRole(db, 'SELECT public.rag_purge_hook_table_rows($1, $2::uuid, $3::uuid[])::int AS n', [tenantA, lineage, [ids.v1, ids.v2]]);
      assert.equal(again[0]?.n, 0, 'a second call removes nothing');
    });

    test('rag_purge_hook_duplicate_clusters removes memberships, bands and source ids; a one-member cluster dissolves', async () => {
      const kept = await insertCluster(tenantA, ['v2a', 'd3', 'd4']);
      const single = await insertCluster(tenantA, ['v2b', 'd5']);
      await db.query('UPDATE rag_dup_clusters SET source_document_ids = source_document_ids || $2::uuid WHERE id = $1', [kept, ids.v1]);
      let foreign: string | null = null;
      if (mode === 'multi-tenant') foreign = await insertCluster(tenantB, ['b1', 'b2']);
      await insertBands('v2a', tenantA);
      await insertBands('v1', tenantA);
      await insertBands('d3', tenantA);
      if (mode === 'multi-tenant') await insertBands('b1', tenantB);
      const foreignBefore = foreign ? await rows('SELECT * FROM rag_dup_clusters WHERE id = $1', [foreign]) : [];

      const result = await asServiceRole(db, 'SELECT public.rag_purge_hook_duplicate_clusters($1, $2::uuid, $3::uuid[])::int AS n', [
        tenantA,
        lineage,
        [ids.v1, ids.v2],
      ]);
      assert.equal(result[0]?.n, 2, 'two chunk memberships of the purged versions removed');

      const [k] = await rows('SELECT member_count, source_document_ids FROM rag_dup_clusters WHERE id = $1', [kept]);
      assert.equal(Number(k?.member_count), 2);
      assert.deepEqual((k?.source_document_ids as string[]).slice().sort(), [ids.d3, ids.d4].sort());
      const members = await rows('SELECT id FROM document_chunks WHERE dup_cluster_id = $1 ORDER BY id', [kept]);
      assert.deepEqual(members.map((row) => row.id), [chunks.d3, chunks.d4].sort());

      assert.equal((await rows('SELECT 1 FROM rag_dup_clusters WHERE id = $1', [single])).length, 0, 'the one-member cluster dissolved');
      const [d5] = await rows('SELECT dup_cluster_id FROM document_chunks WHERE id = $1', [chunks.d5]);
      assert.equal(d5?.dup_cluster_id, null);

      const purgedChunks = await rows('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = ANY($1::uuid[]) AND dup_cluster_id IS NOT NULL', [
        [ids.v1, ids.v2],
      ]);
      assert.equal(purgedChunks[0]?.n, 0);
      const bands = await rows('SELECT chunk_id, count(*)::int AS n FROM rag_dup_chunk_bands GROUP BY chunk_id ORDER BY chunk_id');
      const expectedBands = [{ chunk_id: chunks.d3, n: 8 }];
      if (mode === 'multi-tenant') expectedBands.push({ chunk_id: chunks.b1 as string, n: 8 });
      assert.deepEqual(bands, expectedBands.sort((a, b) => String(a.chunk_id).localeCompare(String(b.chunk_id))));

      if (foreign) {
        assert.deepEqual(await rows('SELECT * FROM rag_dup_clusters WHERE id = $1', [foreign]), foreignBefore, "tenant B's cluster is unchanged");
        const bMembers = await rows('SELECT count(*)::int AS n FROM document_chunks WHERE dup_cluster_id = $1', [foreign]);
        assert.equal(bMembers[0]?.n, 2);
      }

      const again = await asServiceRole(db, 'SELECT public.rag_purge_hook_duplicate_clusters($1, $2::uuid, $3::uuid[])::int AS n', [
        tenantA,
        lineage,
        [ids.v1, ids.v2],
      ]);
      assert.equal(again[0]?.n, 0, 'a second call removes nothing');
    });

    test('ids of versions already deleted are skipped, not refused', async () => {
      const gone = crypto.randomUUID();
      for (const hook of HOOKS) {
        const result = await asServiceRole(db, `SELECT public.${hook}($1, $2::uuid, $3::uuid[])::int AS n`, [tenantA, lineage, [gone]]);
        assert.equal(result[0]?.n, 0, hook);
      }
    });

    test('applying 0864 twice is a no-op', async () => {
      const dump = async () =>
        rows(
          `SELECT p.oid::regprocedure::text AS signature, pg_get_functiondef(p.oid) AS body, p.proacl::text AS acl FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'rag\\_purge\\_%' ORDER BY 1`,
        );
      const first = await dump();
      await applyMigrationFiles(db, [MIGRATION]);
      assert.deepEqual(await dump(), first);
      assert.equal(await failure(db, 'SELECT 1'), null);
    });
  });
}
