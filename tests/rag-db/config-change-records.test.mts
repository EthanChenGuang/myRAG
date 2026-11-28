import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0960_rag_config_change_records.sql';
const HASH_A = 'a'.repeat(64);
const HASH_B = '0123456789abcdef'.repeat(4);

type Role = 'anon' | 'authenticated' | 'service_role';

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

interface RecordSpec {
  actor?: string;
  source?: string;
  changedKeys?: string[];
  beforeHash?: string;
  afterHash?: string;
  retrievalConfigHash?: string | null;
  gateResult?: string;
  gateSummary?: unknown;
  overrideReason?: string | null;
  uncalibratedCells?: string[];
}

async function insertRecord(db: PGlite, spec: RecordSpec = {}): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO public.rag_config_change_records
       (actor, source, changed_keys, before_hash, after_hash, retrieval_config_hash, gate_result, gate_summary, override_reason, uncalibrated_cells)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
     RETURNING id`,
    [
      spec.actor ?? 'local-config-ui',
      spec.source ?? 'config_ui',
      spec.changedKeys ?? ['RAG_RERANKER'],
      spec.beforeHash ?? HASH_A,
      spec.afterHash ?? HASH_B,
      spec.retrievalConfigHash === undefined ? null : spec.retrievalConfigHash,
      spec.gateResult ?? 'pass',
      JSON.stringify(spec.gateSummary ?? { offenders: [], metrics: 3 }),
      spec.overrideReason === undefined ? null : spec.overrideReason,
      spec.uncalibratedCells ?? [],
    ],
  );
  return result.rows[0]!.id;
}

for (const mode of MODES) {
  describe(`rag_config_change_records (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
    });

    after(async () => {
      await db?.close();
    });

    test('has the D-16 columns and no tenant or value column', async () => {
      const result = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'rag_config_change_records' ORDER BY column_name`,
      );
      assert.deepEqual(
        result.rows.map((row) => row.column_name),
        [
          'actor',
          'after_hash',
          'before_hash',
          'changed_keys',
          'created_at',
          'gate_result',
          'gate_summary',
          'id',
          'override_reason',
          'retrieval_config_hash',
          'source',
          'uncalibrated_cells',
        ],
      );
    });

    test('RLS is on with no policy', async () => {
      const rls = await db.query<{ relrowsecurity: boolean }>(
        "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rag_config_change_records'::regclass",
      );
      assert.equal(rls.rows[0]?.relrowsecurity, true);
      const policies = await db.query("SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rag_config_change_records'");
      assert.equal(policies.rows.length, 0);
    });

    test('service_role inserts and reads a record', async () => {
      const id = await asRole(db, 'service_role', () =>
        insertRecord(db, { gateResult: 'fail', overrideReason: 'Neutral override reason for a synthetic test.', uncalibratedCells: ['cell-a'] }),
      );
      const rows = await asRole(db, 'service_role', () =>
        db.query<{ gate_result: string; changed_keys: string[]; created_at: Date }>(
          'SELECT gate_result, changed_keys, created_at FROM public.rag_config_change_records WHERE id = $1',
          [id],
        ),
      );
      assert.equal(rows.rows[0]?.gate_result, 'fail');
      assert.deepEqual(rows.rows[0]?.changed_keys, ['RAG_RERANKER']);
      assert.ok(rows.rows[0]?.created_at);
    });

    for (const role of ['anon', 'authenticated'] as const) {
      test(`${role} gets 42501 on SELECT, INSERT, UPDATE and DELETE`, async () => {
        const refused = (run: () => Promise<unknown>) => assert.rejects(() => asRole(db, role, run), (error: unknown) => sqlState(error) === '42501');
        await refused(() => db.query('SELECT id FROM public.rag_config_change_records'));
        await refused(() => insertRecord(db));
        await refused(() => db.query("UPDATE public.rag_config_change_records SET gate_result = 'pass'"));
        await refused(() => db.query('DELETE FROM public.rag_config_change_records'));
      });
    }

    const rejected: [string, RecordSpec][] = [
      ['an unknown source', { source: 'browser' }],
      ['an unknown gate_result', { gateResult: 'maybe' }],
      ['a before_hash that is not 64 hex characters', { beforeHash: 'abc' }],
      ['an upper-case after_hash', { afterHash: 'A'.repeat(64) }],
      ['a retrieval_config_hash that is not 64 hex characters', { retrievalConfigHash: 'f'.repeat(63) }],
      ['an override_reason longer than 500 characters', { overrideReason: 'x'.repeat(501) }],
      ['a changed key that carries a value', { changedKeys: ['RAG_RERANKER=cohere'] }],
      ['a changed key with spaces', { changedKeys: ['some free text'] }],
    ];
    for (const [label, spec] of rejected) {
      test(`${label} is rejected by a CHECK`, async () => {
        await assert.rejects(
          () => asRole(db, 'service_role', () => insertRecord(db, spec)),
          (error: unknown) => sqlState(error) === '23514',
        );
      });
    }

    test('an override_reason of exactly 500 characters is accepted', async () => {
      await asRole(db, 'service_role', () => insertRecord(db, { overrideReason: 'x'.repeat(500) }));
    });

    test('every source and gate_result of D-16 is accepted', async () => {
      for (const source of ['config_ui', 'cli', 'release_override', 'local_prerelease', 'profile_activation']) {
        await asRole(db, 'service_role', () => insertRecord(db, { source }));
      }
      for (const gateResult of ['pass', 'fail', 'error', 'skipped', 'not_required']) {
        await asRole(db, 'service_role', () => insertRecord(db, { gateResult, retrievalConfigHash: HASH_A }));
      }
    });

    test('applying the file a second time raises no error', async () => {
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
      const count = await asRole(db, 'service_role', () => db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_config_change_records'));
      assert.ok((count.rows[0]?.n ?? 0) > 0);
    });
  });
}
