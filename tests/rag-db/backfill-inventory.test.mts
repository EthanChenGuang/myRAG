import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import { createTwoTenantDatabase, TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { inventory } from '@/lib/rag/ingest/backfill/inventory';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { SourceItem } from '@/lib/rag/ingest/backfill/sources';

const TENANT_SINGLE = 's:default';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const TENANT_O = `o:${TWO_TENANT_IDS.orgO}`;
const SCOPE_SINGLE = mintScope('single', null, null);
const SCOPE_A = mintScope('personal', TWO_TENANT_IDS.userA, null);
const SCOPE_B = mintScope('personal', TWO_TENANT_IDS.userB, null);
const SCOPE_O = mintScope('org', null, TWO_TENANT_IDS.orgO);
const SCOPES: Record<string, ReturnType<typeof mintScope>> = { [TENANT_SINGLE]: SCOPE_SINGLE, [TENANT_A]: SCOPE_A, [TENANT_B]: SCOPE_B, [TENANT_O]: SCOPE_O };

const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

/**
 * The two backfill RPCs the inventory calls, executed as service_role against the real SQL of migration 0356 (the
 * same way PostgREST would), so the row shape, the grants and the tenant filter are the ones production runs.
 */
function sqlRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const run = async (): Promise<RpcResponse> => {
        await db.exec('SET ROLE service_role');
        try {
          if (fn === 'rag_existing_file_hashes') {
            const result = await db.query(`SELECT id, file_sha256, tenant_key, source_key FROM rag_existing_file_hashes($1, $2::text[])`, [args.p_tenant_key, args.p_hashes]);
            return { data: result.rows, error: null };
          }
          if (fn === 'rag_update_ingestion_batch') {
            const result = await db.query(`SELECT * FROM rag_update_ingestion_batch($1::uuid)`, [args.p_batch_id]);
            return { data: result.rows[0] ?? null, error: null };
          }
          if (fn === 'rag_enqueue_backfill_jobs') {
            const result = await db.query<{ n: number }>(`SELECT rag_enqueue_backfill_jobs($1::uuid, $2::jsonb) AS n`, [args.p_batch_id, JSON.stringify(args.p_jobs)]);
            return { data: result.rows, error: null };
          }
          throw new Error(`unexpected rpc ${fn}`);
        } catch (error) {
          const code = typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : undefined;
          return { data: null, error: { message: error instanceof Error ? error.message : String(error), code } };
        } finally {
          await db.exec('RESET ROLE');
        }
      };
      const pending = run();
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => pending.then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

function item(sourceKey: string, text: string): SourceItem {
  const bytes = Buffer.from(text);
  return {
    sourceKey,
    size: bytes.byteLength,
    ext: 'pdf',
    async open() {
      return Readable.from([bytes]);
    },
  };
}

async function* from<T>(values: T[]): AsyncGenerator<T> {
  for (const value of values) yield value;
}

async function createBatch(db: PGlite, tenant: string): Promise<string> {
  const row = (await db.query<{ id: string }>(`SELECT id FROM rag_create_ingestion_batch($1, 'folder', '/data/backfill', 50, 2, 'worker', 'test')`, [tenant])).rows[0];
  assert.ok(row?.id);
  return row.id;
}

async function skippedRows(db: PGlite, batchId: string): Promise<Array<{ source_key: string; status: string; tenant_key: string; file_sha256: string; document_id: string | null }>> {
  return (
    await db.query<{ source_key: string; status: string; tenant_key: string; file_sha256: string; document_id: string | null }>(
      `SELECT source_key, status, tenant_key, file_sha256, document_id::text AS document_id FROM ingestion_jobs WHERE batch_id = $1 ORDER BY source_key`,
      [batchId],
    )
  ).rows;
}

async function expectSqlRefusal(db: PGlite, sql: string, params: unknown[]): Promise<void> {
  await assert.rejects(async () => {
    await db.query(sql, params);
  }, (error: { code?: string; message: string }) => error.code === '22023' || /22023|refused|tenant/.test(error.message));
}

const TWELVE: Array<[string, string]> = [
  ...Array.from({ length: 9 }, (_, i): [string, string] => [`file-${i}.pdf`, `unique-${i}`]),
  ['file-9.pdf', 'unique-0'],
  ['file-10.pdf', 'unique-1'],
  ['file-11.pdf', 'tenant-existing-only'],
];

async function singleTenantDatabase(): Promise<PGlite> {
  // 0409_search_rpc_revoke.sql names a multi-tenant-only function, so migrations: true fails in single-tenant mode on this trunk
  // (deferred-items.md). Everything this test needs is applied; only that revoke is left out.
  const { db } = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant', supabaseGrants: true, migrations: false });
  await applyMigrationFiles(db, migrationFiles('single-tenant').filter((file) => !file.includes('0409_search_rpc_revoke')));
  return db;
}

async function insertSingleDocument(db: PGlite, fileSha256: string): Promise<string> {
  const row = (
    await db.query<{ id: string }>(
      `INSERT INTO documents (id, filename, content, lineage_id, source_key, file_sha256, status, is_current)
       VALUES (gen_random_uuid(), 'existing.pdf', 'existing', gen_random_uuid(), $2, $1, 'ready', true) RETURNING id`,
      [fileSha256, `existing/${fileSha256.slice(0, 8)}`],
    )
  ).rows[0];
  assert.ok(row?.id);
  return row.id;
}

describe('backfill inventory against the real SQL (single-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = await singleTenantDatabase();
  });
  after(async () => {
    await db.close();
  });

  test('12 files: 9 new, 3 skipped_duplicate ledger rows, totals reconcile; running it again adds nothing', async () => {
    const docId = await insertSingleDocument(db, sha('tenant-existing-only'));
    const batchId = await createBatch(db, TENANT_SINGLE);
    const signal = new AbortController().signal;
    const run = () => inventory({ id: batchId, scope: SCOPE_SINGLE }, from(TWELVE.map(([key, text]) => item(key, text))), { rpc: sqlRpc(db), signal });

    const result = await run();
    assert.deepEqual(result.totals, { total: 12, uniqueNew: 9, inInventoryDuplicates: 2, existingDuplicates: 1, unreadable: 0 });
    assert.equal(result.totals.total, result.totals.uniqueNew + result.totals.inInventoryDuplicates + result.totals.existingDuplicates);

    const rows = await skippedRows(db, batchId);
    assert.deepEqual(
      rows.map((r) => [r.source_key, r.status, r.tenant_key]),
      [
        ['file-10.pdf', 'skipped_duplicate', TENANT_SINGLE],
        ['file-11.pdf', 'skipped_duplicate', TENANT_SINGLE],
        ['file-9.pdf', 'skipped_duplicate', TENANT_SINGLE],
      ],
    );
    assert.ok(rows.every((r) => r.document_id === null));
    assert.equal(rows.find((r) => r.source_key === 'file-11.pdf')?.file_sha256, sha('tenant-existing-only'));
    assert.ok(docId);

    const again = await run();
    assert.deepEqual(again.totals, result.totals);
    assert.equal((await skippedRows(db, batchId)).length, 3);
  });

  test('a not-current or not-ready document is not a duplicate', async () => {
    const draft = sha('only-a-draft');
    const old = sha('only-an-old-version');
    await db.query(
      `INSERT INTO documents (id, filename, content, lineage_id, source_key, file_sha256, status, is_current)
       VALUES (gen_random_uuid(), 'draft.pdf', 'x', gen_random_uuid(), 'draft', $1, 'processing', true),
              (gen_random_uuid(), 'old.pdf', 'x', gen_random_uuid(), 'old', $2, 'ready', false)`,
      [draft, old],
    );
    const batchId = await createBatch(db, TENANT_SINGLE);
    const result = await inventory({ id: batchId, scope: SCOPE_SINGLE }, from([item('d.pdf', 'only-a-draft'), item('o.pdf', 'only-an-old-version')]), {
      rpc: sqlRpc(db),
      signal: new AbortController().signal,
    });
    assert.equal(result.totals.uniqueNew, 2);
    assert.equal((await skippedRows(db, batchId)).length, 0);
  });

  test('only one tenant exists: the SQL refuses a user or organization key for a batch and for the hash lookup', async () => {
    await expectSqlRefusal(db, `SELECT id FROM rag_create_ingestion_batch($1, 'folder', '/x', NULL, 1, 'worker')`, [TENANT_A]);
    await expectSqlRefusal(db, `SELECT id FROM rag_create_ingestion_batch($1, 'folder', '/x', NULL, 1, 'worker')`, [TENANT_O]);
    await expectSqlRefusal(db, `SELECT id FROM rag_existing_file_hashes($1, ARRAY[$2]::text[])`, [TENANT_A, sha('x')]);
    const batchId = await createBatch(db, TENANT_SINGLE);
    const result = await inventory({ id: batchId, scope: SCOPE_A }, from([item('a.pdf', 'a')]), { rpc: sqlRpc(db), signal: new AbortController().signal }).catch((error: Error) => error);
    assert.ok(result instanceof Error);
    assert.equal(result.message, '[Backfill] batch tenant mismatch');
    assert.equal((await skippedRows(db, batchId)).length, 0);
  });
});

describe('backfill inventory against the real SQL (multi-tenant, two tenants and an organization)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
    // Same content, three tenants: B and the organization have "shared"; A has only its own "a-only".
    await db.query(`UPDATE documents SET file_sha256 = $1, status = 'ready', is_current = true WHERE id = $2`, [sha('shared-contract'), TWO_TENANT_IDS.docB]);
    await db.query(`UPDATE documents SET file_sha256 = $1, status = 'ready', is_current = true WHERE id = $2`, [sha('shared-contract'), TWO_TENANT_IDS.docO]);
    await db.query(`UPDATE documents SET file_sha256 = $1, status = 'ready', is_current = true WHERE id = $2`, [sha('a-only'), TWO_TENANT_IDS.docA]);
  });
  after(async () => {
    await db.close();
  });

  async function inventoryFor(tenant: string, files: Array<[string, string]>) {
    const batchId = await createBatch(db, tenant);
    const result = await inventory({ id: batchId, scope: SCOPES[tenant] as ReturnType<typeof mintScope> }, from(files.map(([key, text]) => item(key, text))), { rpc: sqlRpc(db), signal: new AbortController().signal });
    return { batchId, result, rows: await skippedRows(db, batchId) };
  }

  const FILES: Array<[string, string]> = [
    ['shared.pdf', 'shared-contract'],
    ['a.pdf', 'a-only'],
    ['fresh.pdf', 'fresh-content'],
  ];

  test("each tenant's inventory sees only its own current files: the same content is new for the tenants that do not have it", async () => {
    const a = await inventoryFor(TENANT_A, FILES);
    assert.deepEqual(a.result.totals, { total: 3, uniqueNew: 2, inInventoryDuplicates: 0, existingDuplicates: 1, unreadable: 0 });
    assert.deepEqual(a.result.entries.map((e) => e.sourceKey), ['shared.pdf', 'fresh.pdf']);
    assert.deepEqual(a.rows.map((r) => [r.source_key, r.tenant_key]), [['a.pdf', TENANT_A]]);

    const b = await inventoryFor(TENANT_B, FILES);
    assert.deepEqual(b.result.totals, { total: 3, uniqueNew: 2, inInventoryDuplicates: 0, existingDuplicates: 1, unreadable: 0 });
    assert.deepEqual(b.result.entries.map((e) => e.sourceKey), ['a.pdf', 'fresh.pdf']);
    assert.deepEqual(b.rows.map((r) => [r.source_key, r.tenant_key]), [['shared.pdf', TENANT_B]]);

    const o = await inventoryFor(TENANT_O, FILES);
    assert.deepEqual(o.result.totals, { total: 3, uniqueNew: 2, inInventoryDuplicates: 0, existingDuplicates: 1, unreadable: 0 });
    assert.deepEqual(o.result.entries.map((e) => e.sourceKey), ['a.pdf', 'fresh.pdf']);
    assert.deepEqual(o.rows.map((r) => [r.source_key, r.tenant_key]), [['shared.pdf', TENANT_O]]);
  });

  test('a tenant with nothing in common gets every file as new and no ledger rows', async () => {
    const nothing = await inventoryFor(TENANT_B, [['a.pdf', 'a-only'], ['fresh.pdf', 'fresh-content']]);
    assert.equal(nothing.result.totals.uniqueNew, 2);
    assert.equal(nothing.rows.length, 0);
  });

  test('12 files: 9 new, 3 skipped_duplicate ledger rows, totals reconcile; running it again adds nothing', async () => {
    await db.query(`UPDATE documents SET file_sha256 = $1, status = 'ready', is_current = true WHERE id = $2`, [sha('tenant-existing-only'), TWO_TENANT_IDS.docA]);
    const { batchId, result, rows } = await inventoryFor(TENANT_A, TWELVE);
    assert.deepEqual(result.totals, { total: 12, uniqueNew: 9, inInventoryDuplicates: 2, existingDuplicates: 1, unreadable: 0 });
    assert.equal(result.totals.total, result.totals.uniqueNew + result.totals.inInventoryDuplicates + result.totals.existingDuplicates);
    assert.deepEqual(rows.map((r) => r.source_key), ['file-10.pdf', 'file-11.pdf', 'file-9.pdf']);
    assert.ok(rows.every((r) => r.status === 'skipped_duplicate' && r.tenant_key === TENANT_A));

    const again = await inventory({ id: batchId, scope: SCOPE_A }, from(TWELVE.map(([key, text]) => item(key, text))), { rpc: sqlRpc(db), signal: new AbortController().signal });
    assert.deepEqual(again.totals, result.totals);
    assert.equal((await skippedRows(db, batchId)).length, 3);
  });

  test("a batch of tenant A run with tenant B's scope fails closed: nothing is written to A's batch and B's hashes are not probed", async () => {
    const batchId = await createBatch(db, TENANT_A);
    const before = (await skippedRows(db, batchId)).length;
    await assert.rejects(
      inventory({ id: batchId, scope: SCOPE_B }, from([item('shared.pdf', 'shared-contract'), item('x.pdf', 'shared-contract')]), {
        rpc: sqlRpc(db),
        signal: new AbortController().signal,
      }),
      (error: Error) => error.message === '[Backfill] batch tenant mismatch',
    );
    assert.equal((await skippedRows(db, batchId)).length, before);
  });

  test("a batch of tenant A with tenant A's scope still dedupes against A only (the shared file is new for A)", async () => {
    const batchId = await createBatch(db, TENANT_A);
    const result = await inventory({ id: batchId, scope: SCOPE_A }, from([item('shared.pdf', 'shared-contract')]), { rpc: sqlRpc(db), signal: new AbortController().signal });
    assert.equal(result.totals.uniqueNew, 1);
    assert.equal((await skippedRows(db, batchId)).length, 0);
  });
});
