import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import {
  SELECTIVE_IDS,
  SELECTIVE_PROFILE,
  createSelectiveFilterDatabase,
  exactFilteredRanking,
  exactHybridTopK,
  measureSelectiveFilter,
  writeSelectiveFilterReport,
  selectiveQueryVectorLiteral,
  type SelectiveFixtureDatabase,
  type SelectiveScanMode,
} from '../../eval/harness/selective-filter.mts';

const K = 10;
const EXACT_CUTOFF = 1000;
const SMALL_TENANT = `u:${SELECTIVE_IDS.smallUser}`;
const BIG_TENANT = `u:${SELECTIVE_IDS.bigUser}`;

type DenseRow = { chunk_id: string; dense_mode: string | null };

async function hybridDense(
  db: PGlite,
  args: {
    tenantKey: string;
    docTypes?: string[] | null;
    iterativeScan: SelectiveScanMode | 'off';
    exactCutoff: number;
  },
): Promise<DenseRow[]> {
  const rows = await db.query<DenseRow>(
    `SELECT chunk_id::text, dense_mode
     FROM hybrid_search_chunks(
       p_tenant_key => $1,
       p_profile_id => $2,
       p_query_embedding => $3::vector,
       p_lexical_tokens => '{}'::text[],
       p_dense_limit => $4,
       p_lexical_limit => 0,
       p_doc_types => $5,
       p_iterative_scan => $6,
       p_exact_scan_cutoff => $7
     )
     WHERE leg = 'dense'
     ORDER BY rank`,
    [
      args.tenantKey,
      SELECTIVE_PROFILE,
      selectiveQueryVectorLiteral(),
      K,
      args.docTypes ?? null,
      args.iterativeScan,
      args.exactCutoff,
    ],
  );
  return rows.rows;
}

function recallAtK(exact: string[], got: string[], k: number): number {
  const want = new Set(exact.slice(0, k));
  let hit = 0;
  for (const id of got.slice(0, k)) {
    if (want.has(id)) hit += 1;
  }
  return hit / k;
}

async function gucSnapshot(db: PGlite): Promise<{ ef: string; it: string; seq: string; bitmap: string }> {
  const row = (
    await db.query<{ ef: string; it: string; seq: string; bitmap: string }>(
      `SELECT current_setting('hnsw.ef_search') AS ef,
              current_setting('hnsw.iterative_scan') AS it,
              current_setting('enable_seqscan') AS seq,
              current_setting('enable_bitmapscan') AS bitmap`,
    )
  ).rows[0];
  return row;
}

describe('selective filter HNSW database (RET-10)', () => {
  let fixture: SelectiveFixtureDatabase;
  let db: PGlite;

  before(async () => {
    fixture = await createSelectiveFilterDatabase();
    db = fixture.db;
    await db.exec('SET enable_seqscan = off');
    await db.exec('SET enable_bitmapscan = off');
  });

  after(async () => {
    await db.exec('RESET enable_seqscan');
    await db.exec('RESET enable_bitmapscan');
    await db.close();
  });

  async function runAsService<T>(fn: (tx: PGlite) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE service_role');
      return fn(tx as unknown as PGlite);
    });
  }

  test('negative control: iterative off returns fewer than k rows for small tenant', async () => {
    const rows = await runAsService((tx) => hybridDense(tx, { tenantKey: SMALL_TENANT, iterativeScan: 'off', exactCutoff: 0 }));
    assert.ok(rows.length < K, `expected negative control under-fill, got ${rows.length}`);
    console.info(`[Selective Filter] mode=off recall@${K}=${recallAtK(await exactFilteredRanking(db, { tenantKey: SMALL_TENANT, limit: K }), rows.map((r) => r.chunk_id), K)}`);
  });

  test('relaxed_order and strict_order return k rows with recall at least 0.9 for small tenant', async () => {
    const exact = await exactHybridTopK(db, { tenantKey: SMALL_TENANT, k: K, exactCutoff: EXACT_CUTOFF });
    for (const mode of ['relaxed_order', 'strict_order'] as const) {
      const rows = await runAsService((tx) => hybridDense(tx, { tenantKey: SMALL_TENANT, iterativeScan: mode, exactCutoff: 0 }));
      assert.equal(rows.length, K, `${mode} row count`);
      const recall = recallAtK(exact, rows.map((r) => r.chunk_id), K);
      assert.ok(recall >= 0.9, `${mode} recall ${recall}`);
      console.info(`[Selective Filter] mode=${mode} recall@${K}=${recall}`);
    }
  });

  test('rare doc type on big tenant meets the same expectations', async () => {
    const metrics = (await measureSelectiveFilter(db, { k: K, exactCutoff: EXACT_CUTOFF })).rare_doc_type;
    assert.ok(metrics.off.rows < K, `rare negative control returned ${metrics.off.rows}`);
    for (const mode of ['relaxed_order', 'strict_order'] as const) {
      assert.equal(metrics[mode].rows, K, `${mode} row count`);
      assert.ok(metrics[mode].recall_at_k >= 0.9, `${mode} recall ${metrics[mode].recall_at_k}`);
      console.info(`[Selective Filter] mode=${mode} rare_doc_type recall@${K}=${metrics[mode].recall_at_k}`);
    }
  });

  test('exact cutoff matches the exact ranking in order', async () => {
    const exact = await exactHybridTopK(db, { tenantKey: SMALL_TENANT, k: K, exactCutoff: EXACT_CUTOFF });
    const rows = await runAsService((tx) =>
      hybridDense(tx, { tenantKey: SMALL_TENANT, iterativeScan: 'off', exactCutoff: EXACT_CUTOFF }),
    );
    assert.equal(rows.length, K);
    assert.ok(rows.every((row) => row.dense_mode === 'exact'));
    assert.deepEqual(
      rows.map((row) => row.chunk_id),
      exact,
    );
    const recall = recallAtK(exact, rows.map((r) => r.chunk_id), K);
    console.info(`[Selective Filter] mode=exact recall@${K}=${recall}`);
  });

  test('superseded rows never appear in any mode', async () => {
    const superseded = (
      await db.query<{ id: string }>(
        `SELECT id::text FROM document_chunks WHERE tenant_key = $1 AND NOT is_current`,
        [SMALL_TENANT],
      )
    ).rows.map((row) => row.id);
    assert.equal(superseded.length, 20);
    const modes: Array<SelectiveScanMode | 'off'> = ['off', 'relaxed_order', 'strict_order'];
    for (const mode of modes) {
      const rows = await runAsService((tx) =>
        hybridDense(tx, { tenantKey: SMALL_TENANT, iterativeScan: mode, exactCutoff: mode === 'off' ? EXACT_CUTOFF : 0 }),
      );
      for (const id of superseded) {
        assert.ok(!rows.some((row) => row.chunk_id === id), `${mode} leaked superseded ${id}`);
      }
    }
  });

  test('hybrid_search_chunks resets HNSW GUCs after each call', async () => {
    const before = await gucSnapshot(db);
    await runAsService((tx) => hybridDense(tx, { tenantKey: SMALL_TENANT, iterativeScan: 'relaxed_order', exactCutoff: 0 }));
    const after = await gucSnapshot(db);
    assert.equal(after.ef, before.ef);
    assert.equal(after.it, before.it);
  });

  test('report JSON matches live measurements', async () => {
    const live = await measureSelectiveFilter(db, { k: K, exactCutoff: EXACT_CUTOFF });
    const tmp = path.join(os.tmpdir(), `selective-filter-${crypto.randomUUID()}.json`);
    await writeSelectiveFilterReport(tmp, live);
    const written = JSON.parse(fs.readFileSync(tmp, 'utf8')) as typeof live;
    fs.unlinkSync(tmp);
    for (const slice of ['small_tenant', 'rare_doc_type'] as const) {
      for (const mode of ['off', 'relaxed_order', 'strict_order', 'exact'] as const) {
        assert.deepEqual(written[slice][mode], live[slice][mode], `${slice}.${mode}`);
      }
    }
    assert.ok(written.small_tenant.off.rows < K);
    assert.ok(written.small_tenant.relaxed_order.recall_at_k >= 0.9);
    assert.ok(written.small_tenant.strict_order.recall_at_k >= 0.9);
    const exact = await exactHybridTopK(db, { tenantKey: SMALL_TENANT, k: K, exactCutoff: EXACT_CUTOFF });
    const exactRows = await runAsService((tx) =>
      hybridDense(tx, { tenantKey: SMALL_TENANT, iterativeScan: 'off', exactCutoff: EXACT_CUTOFF }),
    );
    assert.deepEqual(exactRows.map((r) => r.chunk_id), exact);
  });
});