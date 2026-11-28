import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

// Plan 03.2-19 (0809, T-03.2-191..193): the rebuild ledger is service-role only, selects only real current documents of the tenant named
// with them, opens one held batch per tenant, keeps one open run per mechanism and settings, and its purge hook clears a tenant's rows.

type Row = Record<string, unknown>;

const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const HASH = 'b'.repeat(64);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated', run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

describe('0809 rebuild runs', () => {
  let fixture: TwoTenantDatabase;
  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  before(async () => {
    fixture = await createTwoTenantDatabase();
  });

  after(async () => {
    await fixture?.db.close();
  });

  const start = (items: unknown[], hash = HASH) =>
    rows(`SELECT * FROM rag_rebuild_start('reparse', $1, 'rebuild_batch', '{}'::jsonb, $2::jsonb, 0, 'test')`, [hash, JSON.stringify(items)]);

  test('anon and authenticated can neither call the functions nor read the tables', async () => {
    const calls = [
      `SELECT * FROM rag_rebuild_candidates(NULL, NULL, 10)`,
      `SELECT * FROM rag_rebuild_start('reparse', '${HASH}', 'rebuild_batch', '{}'::jsonb, '[]'::jsonb, 0, 'x')`,
      `SELECT * FROM rag_rebuild_progress('00000000-0000-4000-8000-000000000001'::uuid, NULL, NULL, NULL, NULL, NULL)`,
      `SELECT * FROM rag_rebuild_report('00000000-0000-4000-8000-000000000001'::uuid, 0, 0, 0, true)`,
      `SELECT * FROM rag_rebuild_record_evidence('00000000-0000-4000-8000-000000000001'::uuid, '{"passed":true}'::jsonb)`,
      `SELECT * FROM rag_rebuild_activate('00000000-0000-4000-8000-000000000001'::uuid, 'x')`,
      `SELECT * FROM rag_rebuild_rollback('00000000-0000-4000-8000-000000000001'::uuid, 'x')`,
      `SELECT * FROM rag_rebuild_list(NULL, 10)`,
      `SELECT * FROM rag_rebuild_items_page('00000000-0000-4000-8000-000000000001'::uuid, NULL, NULL, 10)`,
      `SELECT rag_rebuild_settle('00000000-0000-4000-8000-000000000001'::uuid)`,
      `SELECT rag_purge_hook_rebuild('${TENANT_A}', NULL, NULL)`,
      `SELECT * FROM rag_rebuild_runs`,
      `SELECT * FROM rag_rebuild_items`,
      `SELECT * FROM rag_rebuild_saved_vectors`,
    ];
    for (const role of ['anon', 'authenticated'] as const) {
      for (const sql of calls) {
        const message = await asRole(fixture.db, role, () => failure(fixture.db, sql));
        assert.match(String(message), /permission denied/, `${role}: ${sql.slice(0, 70)}`);
      }
    }
  });

  test('a document named with another tenant is ignored, each tenant gets its own held batch, and a second start returns the run', async () => {
    await assert.rejects(start([{ tenant_key: TENANT_B, document_id: TWO_TENANT_IDS.docA }]), /nothing_to_rebuild/);
    const [run] = await start([
      { tenant_key: TENANT_A, document_id: TWO_TENANT_IDS.docA },
      { tenant_key: TENANT_B, document_id: TWO_TENANT_IDS.docB },
      { tenant_key: TENANT_A, document_id: TWO_TENANT_IDS.docB },
    ]);
    assert.equal(run?.resumed, false);
    assert.equal(run?.total, 2);
    const items = await rows('SELECT document_id, tenant_key, batch_id FROM rag_rebuild_items WHERE run_id = $1 ORDER BY tenant_key', [run?.run_id]);
    assert.deepEqual(
      items.map((item) => [item.document_id, item.tenant_key]),
      [
        [TWO_TENANT_IDS.docA, TENANT_A],
        [TWO_TENANT_IDS.docB, TENANT_B],
      ],
    );
    const batches = await rows('SELECT b.id, b.tenant_key, b.hold_publish FROM ingestion_batches b WHERE b.source_ref = $1 ORDER BY b.tenant_key', [`rebuild:${run?.run_id}`]);
    assert.deepEqual(batches.map((batch) => [batch.tenant_key, batch.hold_publish]), [[TENANT_A, true], [TENANT_B, true]]);
    for (const item of items) assert.equal(batches.find((batch) => batch.tenant_key === item.tenant_key)?.id, item.batch_id);

    const [again] = await start([{ tenant_key: TENANT_A, document_id: TWO_TENANT_IDS.docA }]);
    assert.deepEqual([again?.run_id, again?.resumed, again?.total], [run?.run_id, true, 2]);
  });

  test('evidence must carry a boolean verdict; activation of a running run is refused as incomplete; rollback before activation is refused', async () => {
    const [run] = await rows(`SELECT id FROM rag_rebuild_runs WHERE settings_hash = $1`, [HASH]);
    assert.match(String(await failure(fixture.db, `SELECT * FROM rag_rebuild_record_evidence($1, '{"passed":"yes"}'::jsonb)`, [run?.id])), /invalid_evidence/);
    await rows(`SELECT * FROM rag_rebuild_record_evidence($1, '{"passed":true}'::jsonb)`, [run?.id]);
    assert.match(String(await failure(fixture.db, `SELECT * FROM rag_rebuild_activate($1, 'x')`, [run?.id])), /activation_refused: incomplete/);
    assert.match(String(await failure(fixture.db, `SELECT * FROM rag_rebuild_rollback($1, 'x')`, [run?.id])), /rollback_refused: not_activated/);
  });

  test("the purge hook removes one tenant's rows and leaves the other tenant's", async () => {
    const removed = await rows(`SELECT rag_purge_hook_rebuild($1, NULL, ARRAY[$2]::uuid[]) AS n`, [TENANT_A, TWO_TENANT_IDS.docA]);
    assert.equal(removed[0]?.n, 1);
    assert.match(String(await failure(fixture.db, `SELECT rag_purge_hook_rebuild($1, NULL, ARRAY[$2]::uuid[])`, ['not-a-key', TWO_TENANT_IDS.docB])), /tenant/i);
    const left = await rows('SELECT tenant_key FROM rag_rebuild_items');
    assert.deepEqual(left.map((row) => row.tenant_key), [TENANT_B]);
  });
});
