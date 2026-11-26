import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { createPgliteAdmin } from '../helpers/pglite-admin.ts';
import { importQuestions, prepareQuestions } from '../../src/lib/rag/monitor/questions-import.ts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const NOW = new Date('2026-11-26T10:00:00Z');
const QUESTIONS = ['question-0001', 'question-0002', 'question-0002', 'Where is the sample report for person@example.invalid?'];

type Row = Record<string, unknown>;

async function itemsOf(db: PGlite, tenant: string): Promise<Row[]> {
  return (
    await db.query<Row>(
      `SELECT i.query_masked, i.reasons, i.retrieval_log_id, i.trace_id, i.mining_window, s.source, s.stratum, s.sampling_weight
         FROM rag_review_items i LEFT JOIN rag_review_item_strata s ON s.review_item_id = i.id
        WHERE i.tenant_key = $1 ORDER BY i.query_masked`,
      [tenant],
    )
  ).rows;
}

for (const mode of MODES) {
  describe(`historical questions import (${mode})`, () => {
    let db: PGlite;
    let tenantA: string;
    let tenantB: string;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      tenantA = mode === 'single-tenant' ? 's:default' : `o:${crypto.randomUUID()}`;
      tenantB = `o:${crypto.randomUUID()}`;
    });

    after(async () => {
      await db.close();
    });

    test('a dry run computes the counts and writes nothing', async () => {
      const admin = createPgliteAdmin(db);
      const counts = await importQuestions(admin as never, { tenantKey: tenantA, prepared: prepareQuestions(QUESTIONS), dryRun: true, now: NOW });
      assert.deepEqual({ added: counts.added, duplicates: counts.duplicates, read: counts.read }, { added: 3, duplicates: 1, read: 4 });
      assert.equal((await itemsOf(db, tenantA)).length, 0);
    });

    test('rows go to the one tenant, masked, as historical representative items with a strata row and no log row', async () => {
      const other = mode === 'multi-tenant' ? await itemsOf(db, tenantB) : [];
      if (mode === 'multi-tenant') {
        const admin = createPgliteAdmin(db);
        await importQuestions(admin as never, { tenantKey: tenantB, prepared: prepareQuestions(['question-0009']), dryRun: false, now: NOW });
      }
      const before = mode === 'multi-tenant' ? await itemsOf(db, tenantB) : other;

      const admin = createPgliteAdmin(db);
      const counts = await importQuestions(admin as never, { tenantKey: tenantA, prepared: prepareQuestions(QUESTIONS), dryRun: false, now: NOW });
      assert.equal(counts.added, 3);
      assert.equal(counts.duplicates, 1);

      const rows = await itemsOf(db, tenantA);
      assert.deepEqual(
        rows.map((row) => row.query_masked),
        ['Where is the sample report for [EMAIL]?', 'question-0001', 'question-0002'],
      );
      for (const row of rows) {
        assert.deepEqual(row.reasons, ['representative']);
        assert.equal(row.retrieval_log_id, null);
        assert.equal(row.trace_id, null);
        assert.equal(row.source, 'historical');
        assert.match(String(row.stratum), /^historical\|[a-z]{2,3}(-[A-Za-z0-9]+)?\|import$|^historical\|und\|import$/);
        assert.equal(row.sampling_weight, 1);
        assert.equal(new Date(String(row.mining_window)).toISOString(), '2026-11-23T00:00:00.000Z');
      }
      if (mode === 'multi-tenant') assert.deepEqual(await itemsOf(db, tenantB), before);
      const leaked = (await db.query<Row>("SELECT count(*)::int AS n FROM rag_review_items WHERE query_masked LIKE '%@example.invalid%'")).rows[0];
      assert.equal(leaked?.n, 0);
    });

    test('importing the same file again, also in a later week, adds nothing', async () => {
      const admin = createPgliteAdmin(db);
      const again = await importQuestions(admin as never, {
        tenantKey: tenantA,
        prepared: prepareQuestions(QUESTIONS),
        dryRun: false,
        now: new Date('2026-12-10T10:00:00Z'),
      });
      assert.equal(again.added, 0);
      assert.equal(again.duplicates, 4);
      assert.equal((await itemsOf(db, tenantA)).length, 3);
    });
  });
}
