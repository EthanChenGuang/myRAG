import crypto from 'node:crypto';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

/**
 * RET-12 deterministic table lookup (D-16, D-45, D-56): 0861 rag_table_lookup and the lookup module. Synthetic, neutral tables of
 * invented words; rows share values column by column, so only a row naming two of its own cell values matches with min_cells 2.
 */
type Row = Record<string, unknown>;

const USER_B = '00000000-0000-4000-8000-0000000024b1';
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const FN = 'rag_table_lookup';
const SIGNATURE = 'public.rag_table_lookup(text,text[],integer,integer,jsonb,text[])';
const LOOKUP = `SELECT row_id::text, document_id::text, table_key, row_index, header, cells, matched_cells, chunk_ids::text[] AS chunk_ids
  FROM public.${FN}($1, $2::text[], $3, $4, $5::jsonb, $6::text[])`;

const HEADER = ['Kelmo', 'Darvi', 'Quenta', 'Zemo'];
const ROWS: string[][] = [
  ['plin', 'rosk', 'sefa', 'brel'],
  ['vatu', 'rosk', 'sefa', 'tarn welo'],
  ['plin', 'mepra', 'sefa', 'brel'],
];

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : '';
}

async function assertLookupFunction(db: PGlite): Promise<void> {
  const result = await db.query<{ ok: boolean }>('SELECT to_regprocedure($1) IS NOT NULL AS ok', [SIGNATURE]);
  assert.equal(result.rows[0]?.ok, true, '0861 rag_table_lookup exists');
}

function serviceRpc(db: PGlite, calls?: string[]): RpcClient {
  return {
    rpc(fn, args) {
      calls?.push(fn);
      const keys = Object.keys(args);
      const sql = `SELECT * FROM public.${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const values = keys.map((key) => {
        const value = args[key];
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value;
      });
      const run = db
        .transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          return (await tx.query<Row>(sql, values)).rows;
        })
        .then((rows): RpcResponse => ({ data: rows as unknown[], error: null }))
        .catch((error: unknown): RpcResponse => ({ data: null, error: { code: sqlState(error) || 'P0001', message: error instanceof Error ? error.message : String(error) } }));
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

function cannedRpc(response: RpcResponse, calls: string[]): RpcClient {
  return {
    rpc(fn) {
      calls.push(fn);
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected) };
      return request;
    },
  };
}

function tableRows(tableKey: string, chunkId: string, rows: string[][] = ROWS, header: string[] = HEADER): Row[] {
  return rows.map((values, rowIndex) => {
    const cellTokens = values.map((value) => value.split(' '));
    return {
      table_key: tableKey,
      row_index: rowIndex,
      header,
      cells: Object.fromEntries(header.map((name, index) => [name, values[index] ?? ''])),
      cell_tokens: cellTokens,
      cell_norm: [...new Set(cellTokens.flat())],
      chunk_ids: [chunkId],
    };
  });
}

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';
  const tenantA = multi ? `u:${FIXTURE_USER_ID}` : 's:default';
  const tenantB = `u:${USER_B}`;
  const wrongModeKey = multi ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`0861 rag_table_lookup (${mode}, D-16, D-45, D-56)`, () => {
    let db: PGlite;
    const docs: Record<string, string> = {};
    const chunks: Record<string, string> = {};

    async function insertDocument(owner: 'A' | 'B', options: { isCurrent?: boolean; status?: string; version?: number; supersededBy?: string | null; lineage?: string; hash?: string } = {}): Promise<string> {
      const id = crypto.randomUUID();
      const columns = ['id', 'filename', 'content', 'status', 'is_current', 'version', 'provisional', 'superseded_by', 'lineage_id', 'content_hash'];
      const values: unknown[] = [id, 'rows.md', 'neutral body', options.status ?? 'ready', options.isCurrent ?? true, options.version ?? 1, false, options.supersededBy ?? null, options.lineage ?? id, options.hash ?? crypto.randomUUID()];
      if (multi) {
        columns.push('user_id');
        values.push(owner === 'A' ? FIXTURE_USER_ID : USER_B);
      }
      await db.query(`INSERT INTO documents (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, values);
      return id;
    }

    async function insertChunk(documentId: string, options: { profile?: string; index?: number; isCurrent?: boolean } = {}): Promise<string> {
      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, metadata, chunk_index, chunking_profile_id, is_current, status, provisional)
         VALUES ($1, $2, 'neutral table chunk', '{}'::jsonb, $3, $4, $5, 'ready', false)`,
        [id, documentId, options.index ?? 0, options.profile ?? 'legacy', options.isCurrent ?? true],
      );
      return id;
    }

    async function writeRows(tenant: string, documentId: string, profile: string, rows: Row[]): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE service_role');
        await tx.query('SELECT * FROM public.rag_write_table_rows($1, $2::uuid, $3, $4::jsonb)', [tenant, documentId, profile, JSON.stringify(rows)]);
      });
    }

    async function lookup(tenant: string, tokens: string[], minCells = 2, limit = 10, scope: unknown = null, identifiers: string[] | null = null): Promise<Row[]> {
      return db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE service_role');
        return (await tx.query<Row>(LOOKUP, [tenant, tokens, minCells, limit, scope === null ? null : JSON.stringify(scope), identifiers])).rows;
      });
    }

    async function failure(run: () => Promise<unknown>): Promise<string | null> {
      try {
        await run();
        return null;
      } catch (error) {
        return sqlState(error) || 'unknown';
      }
    }

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      if (multi) await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [USER_B, 'fixture-user-b@example.invalid']);

      docs.main = await insertDocument('A');
      chunks.main = await insertChunk(docs.main);
      await writeRows(tenantA, docs.main, 'legacy', tableRows(`${docs.main}:t0`, chunks.main));

      const lineage = crypto.randomUUID();
      docs.newer = await insertDocument('A', { lineage, version: 2 });
      chunks.newer = await insertChunk(docs.newer);
      await writeRows(tenantA, docs.newer, 'legacy', tableRows(`${docs.newer}:t0`, chunks.newer, [['gorap', 'nilt', 'sefa', 'brel']]));
      docs.older = await insertDocument('A', { lineage, version: 1, isCurrent: false, supersededBy: docs.newer });
      chunks.older = await insertChunk(docs.older, { isCurrent: false });
      await writeRows(tenantA, docs.older, 'legacy', tableRows(`${docs.older}:t0`, chunks.older, [['sorna', 'kibe', 'sefa', 'brel']]));

      docs.pending = await insertDocument('A', { status: 'quarantined' });
      chunks.pending = await insertChunk(docs.pending);
      await writeRows(tenantA, docs.pending, 'legacy', tableRows(`${docs.pending}:t0`, chunks.pending, [['hulme', 'drast', 'sefa', 'brel']]));

      if (multi) {
        docs.b = await insertDocument('B');
        chunks.b = await insertChunk(docs.b);
        await writeRows(tenantB, docs.b, 'legacy', tableRows(`${docs.b}:t0`, chunks.b, [['glor', 'fent', 'sefa', 'brel']]));
      }
    });

    after(async () => {
      await db?.close();
    });

    test('two cell values of one row return exactly that row first, with its header, cells and chunk', async () => {
      await assertLookupFunction(db);
      const rows = await lookup(tenantA, ['plin', 'mepra']);
      assert.equal(rows.length, 1, JSON.stringify(rows.map((row) => row.row_index)));
      const [row] = rows;
      assert.equal(row!.row_index, 2);
      assert.equal(row!.matched_cells, 2);
      assert.equal(row!.document_id, docs.main);
      assert.equal(row!.table_key, `${docs.main}:t0`);
      assert.deepEqual(row!.header, HEADER);
      assert.deepEqual(row!.cells, { Kelmo: 'plin', Darvi: 'mepra', Quenta: 'sefa', Zemo: 'brel' });
      assert.deepEqual(row!.chunk_ids, [chunks.main]);
    });

    test('one value is not enough with min_cells 2; with min_cells 1 every row holding it, by matched cells then row index', async () => {
      await assertLookupFunction(db);
      assert.deepEqual(await lookup(tenantA, ['plin']), []);
      const one = await lookup(tenantA, ['plin'], 1);
      assert.deepEqual(one.map((row) => row.row_index), [0, 2]);
      const ranked = await lookup(tenantA, ['plin', 'rosk'], 1);
      assert.deepEqual(ranked.map((row) => [row.row_index, row.matched_cells]), [[0, 2], [1, 1], [2, 1]]);
    });

    test('a two-token cell matches only when both tokens are in the query', async () => {
      await assertLookupFunction(db);
      assert.deepEqual(await lookup(tenantA, ['vatu', 'tarn']), []);
      const both = await lookup(tenantA, ['vatu', 'tarn', 'welo']);
      assert.deepEqual(both.map((row) => [row.row_index, row.matched_cells]), [[1, 2]]);
    });

    test('a value shared by every row counts once per row; quarantined documents never qualify', async () => {
      await assertLookupFunction(db);
      assert.deepEqual(await lookup(tenantA, ['sefa', 'brel'], 3), []);
      assert.deepEqual(await lookup(tenantA, ['hulme', 'drast']), []);
    });

    test('rows of a building chunking profile are never returned; after activation they are', async () => {
      await assertLookupFunction(db);
      await db.query(
        `INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
         VALUES ('p24-build', 'general', 256, 'none', NULL, 'building', '256/1024') ON CONFLICT DO NOTHING`,
      );
      const profileChunk = await insertChunk(docs.main, { profile: 'p24-build', index: 1 });
      await writeRows(tenantA, docs.main, 'p24-build', tableRows(`${docs.main}:t0`, profileChunk));
      const before = await lookup(tenantA, ['plin', 'mepra']);
      assert.deepEqual(before.map((row) => row.chunk_ids), [[chunks.main]]);
      await db.query(`UPDATE chunking_profiles SET status = 'ready' WHERE id = 'legacy' AND doc_type = 'general'`);
      await db.query(`UPDATE chunking_profiles SET status = 'active' WHERE id = 'p24-build' AND doc_type = 'general'`);
      try {
        const activated = await lookup(tenantA, ['plin', 'mepra']);
        assert.deepEqual(activated.map((row) => row.chunk_ids), [[profileChunk]]);
      } finally {
        await db.query(`UPDATE chunking_profiles SET status = 'building' WHERE id = 'p24-build' AND doc_type = 'general'`);
        await db.query(`UPDATE chunking_profiles SET status = 'active' WHERE id = 'legacy' AND doc_type = 'general'`);
      }
      assert.deepEqual((await lookup(tenantA, ['plin', 'mepra'])).map((row) => row.chunk_ids), [[chunks.main]]);
    });

    test('scope current returns no superseded row; scope all does; a malformed scope raises 22023', async () => {
      await assertLookupFunction(db);
      assert.deepEqual(await lookup(tenantA, ['sorna', 'kibe']), []);
      assert.deepEqual(await lookup(tenantA, ['sorna', 'kibe'], 2, 10, { mode: 'current' }), []);
      const all = await lookup(tenantA, ['sorna', 'kibe'], 2, 10, { mode: 'all' });
      assert.deepEqual(all.map((row) => row.document_id), [docs.older]);
      assert.deepEqual((await lookup(tenantA, ['gorap', 'nilt'], 2, 10, { mode: 'all' })).map((row) => row.document_id), [docs.newer]);
      assert.equal(await failure(() => lookup(tenantA, ['sorna', 'kibe'], 2, 10, { mode: 'later' })), '22023');
      assert.equal(await failure(() => lookup(tenantA, ['sorna', 'kibe'], 2, 10, { mode: 'all', from: '2026-01-01' })), '22023');
    });

    test('the identifier filter keeps only rows with a chunk carrying one of the identifiers', async () => {
      await assertLookupFunction(db);
      await db.query(`UPDATE document_chunks SET identifiers_norm = ARRAY['zq-41'] WHERE id = $1`, [chunks.main]);
      try {
        assert.equal((await lookup(tenantA, ['plin', 'mepra'], 2, 10, null, ['zq-41'])).length, 1);
        assert.deepEqual(await lookup(tenantA, ['plin', 'mepra'], 2, 10, null, ['zq-99']), []);
        assert.deepEqual(await lookup(tenantA, ['plin', 'mepra'], 2, 10, null, []), []);
      } finally {
        await db.query('UPDATE document_chunks SET identifiers_norm = NULL WHERE id = $1', [chunks.main]);
      }
    });

    test("another tenant's values return nothing", { skip: !multi }, async () => {
      await assertLookupFunction(db);
      assert.deepEqual(await lookup(tenantB, ['plin', 'mepra']), []);
      assert.deepEqual(await lookup(tenantA, ['glor', 'fent']), []);
      assert.deepEqual((await lookup(tenantB, ['glor', 'fent'])).map((row) => row.document_id), [docs.b]);
    });

    test('caps raise 22023, a tenant key of the other mode is rejected, no tokens return nothing', async () => {
      await assertLookupFunction(db);
      const many = Array.from({ length: 65 }, (_, index) => `w${index}`);
      assert.equal(await failure(() => lookup(tenantA, many)), '22023');
      assert.equal(await failure(() => lookup(tenantA, ['plin'], 1, 51)), '22023');
      assert.equal(await failure(() => lookup(tenantA, ['plin'], 1, 0)), '22023');
      assert.equal(await failure(() => lookup(tenantA, ['plin'], 0)), '22023');
      assert.equal(await failure(() => lookup(tenantA, ['plin'], 11)), '22023');
      assert.notEqual(await failure(() => lookup(wrongModeKey, ['plin', 'mepra'])), null);
      assert.deepEqual(await lookup(tenantA, []), []);
    });

    test('SECURITY INVOKER, empty search_path, service_role only; anon and authenticated get 42501', async () => {
      await assertLookupFunction(db);
      const rows = await db.query<{ definer: boolean; config: string[] | null }>('SELECT prosecdef AS definer, proconfig AS config FROM pg_proc WHERE oid = $1::regprocedure', [SIGNATURE]);
      assert.deepEqual(rows.rows[0], { definer: false, config: ['search_path=""'] });
      const privileges = await db.query<{ role: string; allowed: boolean }>(
        `SELECT r.role, has_function_privilege(r.role, $1, 'EXECUTE') AS allowed FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
        [SIGNATURE],
      );
      assert.deepEqual(Object.fromEntries(privileges.rows.map((row) => [row.role, row.allowed])), { anon: false, authenticated: false, service_role: true });
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          await assert.rejects(() => db.query(LOOKUP, [tenantA, ['plin', 'mepra'], 2, 10, null, null]), (error: unknown) => sqlState(error) === '42501');
        } finally {
          await db.exec('RESET ROLE');
        }
      }
    });

    test('re-applying 0861 keeps one function with the same definition and grants', async () => {
      await assertLookupFunction(db);
      const definition = async () =>
        (await db.query<{ def: string; acl: string }>(`SELECT pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p WHERE p.proname = '${FN}'`)).rows;
      const before = await definition();
      const files = migrationFiles(mode).filter((file) => path.basename(file).startsWith('0861_'));
      assert.equal(files.length, 1);
      await applyMigrationFiles(db, files);
      assert.deepEqual(await definition(), before);
    });

    describe('tableLookup and tableLookupStage', () => {
      const scopeA = async () => {
        const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
        return multi ? mintScope('personal', FIXTURE_USER_ID, null) : mintScope('single', null, null);
      };
      const params = { min_cells: 2, limit: 10, weight: 1 };

      test('looks up the scope tenant rows through the RPC', async () => {
        await assertLookupFunction(db);
        const { tableLookup } = await import('../../src/lib/rag/retrieval/table-lookup.ts');
        const rows = await tableLookup(await scopeA(), ['plin', 'mepra'], params, { client: serviceRpc(db), signal: new AbortController().signal });
        assert.deepEqual(rows.map((row) => [row.row_index, row.matched_cells, row.chunk_ids]), [[2, 2, [chunks.main]]]);
        assert.deepEqual(rows[0]!.header, HEADER);
        assert.deepEqual(rows[0]!.cells, { Kelmo: 'plin', Darvi: 'mepra', Quenta: 'sefa', Zemo: 'brel' });
        const all = await tableLookup(await scopeA(), ['sorna', 'kibe'], params, { client: serviceRpc(db), signal: new AbortController().signal, versionScope: { mode: 'all' } });
        assert.deepEqual(all.map((row) => row.document_id), [docs.older]);
      });

      test('the stage tokenizes the question and reports the token count', async () => {
        const { tableLookupStage } = await import('../../src/lib/rag/retrieval/table-lookup.ts');
        const result = await tableLookupStage('Plin mepra?', await scopeA(), params, { client: serviceRpc(db), signal: new AbortController().signal });
        assert.equal(result.tokenCount, 2);
        assert.deepEqual(result.rows.map((row) => row.row_index), [2]);
      });

      test('no tokens make no call; an RPC error becomes RetrievalBackendError with the code only; malformed rows are dropped', async () => {
        const { tableLookup, tableLookupStage } = await import('../../src/lib/rag/retrieval/table-lookup.ts');
        const { RetrievalBackendError } = await import('../../src/lib/rag/backend/supabase-rpc.ts');
        const calls: string[] = [];
        const none = cannedRpc({ data: [], error: null }, calls);
        assert.deepEqual(await tableLookup(await scopeA(), [], params, { client: none, signal: new AbortController().signal }), []);
        assert.deepEqual(await tableLookupStage('   ', await scopeA(), params, { client: none, signal: new AbortController().signal }), { rows: [], tokenCount: 0 });
        assert.deepEqual(calls, []);

        const failing = cannedRpc({ data: null, error: { code: '22023', message: 'detail that must not travel' } }, calls);
        const scope = await scopeA();
        await assert.rejects(
          () => tableLookup(scope, ['plin'], params, { client: failing, signal: new AbortController().signal }),
          (error: unknown) => error instanceof RetrievalBackendError && error.rpc === FN && error.code === '22023' && !error.message.includes('detail'),
        );

        const good = { row_id: crypto.randomUUID(), document_id: crypto.randomUUID(), table_key: 'k:t0', row_index: 0, header: ['A'], cells: { A: 'x' }, matched_cells: 2, chunk_ids: [crypto.randomUUID()] };
        const junk = cannedRpc({ data: [good, null, { ...good, chunk_ids: [] }, { ...good, row_index: 'x' }, { ...good, document_id: 5 }, 'text'], error: null }, calls);
        const rows = await tableLookup(await scopeA(), ['plin'], params, { client: junk, signal: new AbortController().signal });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.row_id, good.row_id);
      });

      test('an aborted signal stops before the call', async () => {
        const { tableLookup } = await import('../../src/lib/rag/retrieval/table-lookup.ts');
        const calls: string[] = [];
        const controller = new AbortController();
        controller.abort();
        const scope = await scopeA();
        await assert.rejects(() => tableLookup(scope, ['plin'], params, { client: cannedRpc({ data: [], error: null }, calls), signal: controller.signal }));
        assert.deepEqual(calls, []);
      });
    });
  });
}
