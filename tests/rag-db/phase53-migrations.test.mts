import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SETUP_FILES = ['supabase/single-tenant-setup.sql', 'supabase/multi-tenant-setup.sql'];
const PHASE_FILE = /^supabase\/migrations\/(09[67]\d)_[a-z0-9_]+(?:\.(?:single|multi)-tenant)?\.sql$/;
const PHASE_511_TABLES = ['rag_retrieval_log', 'rag_review_items'];
const CLIENT_READABLE_TABLES = new Set(['rag_judge_labels']);
/** 0966 references rag_retrieval_log(id) by foreign key and stops with 55000 without it (fail closed, plan 05.3-10). */
const REQUIRES_RETRIEVAL_LOG = /^supabase\/migrations\/0966_/;

export type Phase53FunctionKind = 'invoker' | 'trigger';

/** Every function created by the 0960 to 0979 files, by regprocedure signature without the schema. */
export const PHASE53_SERVICE_ROLE_FUNCTIONS: ReadonlyArray<{ signature: string; kind: Phase53FunctionKind }> = [
  { signature: 'rag_eval_run_request_enqueue(text,text,text)', kind: 'invoker' },
  { signature: 'rag_pilot_user_add(text,uuid,uuid)', kind: 'invoker' },
  { signature: 'rag_pilot_user_remove(text,uuid)', kind: 'invoker' },
  { signature: 'rag_monitor_purge(integer)', kind: 'invoker' },
  { signature: 'rag_monitor_alert_upsert(jsonb)', kind: 'invoker' },
  { signature: 'rag_monitor_alert_set_status(uuid,text,uuid)', kind: 'invoker' },
  { signature: 'rag_online_judge_scores_record(jsonb)', kind: 'invoker' },
  { signature: 'rag_review_items_enqueue(text,text,jsonb)', kind: 'invoker' },
  { signature: 'rag_query_clusters_write(text,jsonb,jsonb)', kind: 'invoker' },
  { signature: 'rag_query_cluster_assign(text,uuid,jsonb)', kind: 'invoker' },
  { signature: 'rag_drift_weekly_upsert(text,date,jsonb)', kind: 'invoker' },
  { signature: 'rag_monitor_aggregate(date)', kind: 'invoker' },
  { signature: 'rag_monitor_days_to_aggregate(integer)', kind: 'invoker' },
  { signature: 'rag_golden_evidence_register(text,text,jsonb)', kind: 'invoker' },
  { signature: 'rag_golden_evidence_pending(text,text)', kind: 'invoker' },
  { signature: 'rag_golden_evidence_clear(text,text,text[])', kind: 'invoker' },
  { signature: 'rag_golden_evidence_on_documents_update()', kind: 'trigger' },
  { signature: 'rag_golden_evidence_on_documents_delete()', kind: 'trigger' },
];

const normalise = (signature: string): string => signature.replace(/\s+/g, '');

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

function phaseFiles(mode: DeploymentMode): string[] {
  return migrationFiles(mode).filter((file) => PHASE_FILE.test(file));
}

function firstPhaseIndex(files: string[]): number {
  const index = files.findIndex((file) => PHASE_FILE.test(file));
  assert.ok(index >= 0, 'no Phase 5.3 migration found');
  return index;
}

interface Inventory {
  tables: string[];
  functions: string[];
  policies: string[];
  triggers: string[];
}

async function inventory(db: PGlite): Promise<Inventory> {
  const list = async (sql: string): Promise<string[]> => (await db.query<{ name: string }>(sql)).rows.map((row) => row.name).sort();
  return {
    tables: await list("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')"),
    functions: await list("SELECT p.oid::regprocedure::text AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'"),
    policies: await list("SELECT tablename || '.' || policyname AS name FROM pg_policies WHERE schemaname = 'public'"),
    triggers: await list("SELECT c.relname || '.' || t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal"),
  };
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated', run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function buildWithout(mode: DeploymentMode, skip: (file: string) => boolean): Promise<PGlite> {
  const { db } = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
  await applyMigrationFiles(db, migrationFiles(mode).filter((file) => !skip(file)));
  return db;
}

test('every Phase 5.3 migration file matches the harness name pattern and the 0960 to 0979 block', () => {
  const names = fs.readdirSync(path.join(REPO_ROOT, 'supabase/migrations')).filter((name) => /^09[67]\d_/.test(name));
  assert.ok(names.length >= 11, `expected at least 11 Phase 5.3 files, found ${names.length}`);
  for (const name of names) {
    assert.match(`supabase/migrations/${name}`, PHASE_FILE);
    const number = Number(name.slice(0, 4));
    assert.ok(number >= 960 && number <= 979, name);
  }
});

for (const mode of MODES) {
  describe(`Phase 5.3 migrations 0960 to 0979 (${mode})`, () => {
    let full: PGlite;
    let withoutPhase: PGlite;
    let phaseFunctions: string[];
    let phaseTables: string[];

    before(async () => {
      ({ db: full } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      withoutPhase = await buildWithout(mode, (file) => PHASE_FILE.test(file));
      const [a, b] = [await inventory(withoutPhase), await inventory(full)];
      phaseFunctions = b.functions.filter((name) => !a.functions.includes(name)).map(normalise);
      phaseTables = b.tables.filter((name) => !a.tables.includes(name));
    });

    after(async () => {
      await full?.close();
      await withoutPhase?.close();
    });

    test('re-applying every phase file raises no error and changes no table, function, policy or trigger count', async () => {
      const before = await inventory(full);
      await applyMigrationFiles(full, phaseFiles(mode));
      const afterApply = await inventory(full);
      assert.deepEqual(afterApply, before);
    });

    test('every phase file but the fail-closed 0966 applies twice on a database without the Phase 5.1.1 tables', async () => {
      const files = migrationFiles(mode);
      const start = firstPhaseIndex(files);
      const { db } = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
      try {
        await applyMigrationFiles(db, files.slice(0, start));
        await db.exec(PHASE_511_TABLES.map((table) => `DROP TABLE IF EXISTS public.${table} CASCADE;`).join('\n'));
        const tolerant = phaseFiles(mode).filter((file) => !REQUIRES_RETRIEVAL_LOG.test(file));
        const failClosed = phaseFiles(mode).filter((file) => REQUIRES_RETRIEVAL_LOG.test(file));
        assert.equal(failClosed.length, 1);
        await applyMigrationFiles(db, tolerant);
        await applyMigrationFiles(db, tolerant);
        await assert.rejects(() => applyMigrationFiles(db, failClosed), (error: unknown) => codeOf(error) === '55000');
        await db.exec('ROLLBACK');
        const present = await db.query<{ t: string | null }>(
          "SELECT to_regclass('public.rag_judge_labels')::text AS t UNION ALL SELECT to_regclass('public.rag_review_items')::text",
        );
        assert.deepEqual(present.rows.map((row) => row.t), [null, null], 'review-queue objects must stay absent');
        const evidence = await db.query<{ t: string | null }>("SELECT to_regclass('public.rag_golden_evidence_index')::text AS t");
        assert.equal(evidence.rows[0]!.t, 'rag_golden_evidence_index');
        const days = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_monitor_days_to_aggregate(7)');
        assert.equal(days.rows[0]!.n, 0, 'the aggregate is inert without the log');
      } finally {
        await db.close();
      }
    });

    test('no table or function of the phase appears in either setup file', () => {
      const names = [...phaseTables, ...phaseFunctions.map((signature) => signature.slice(0, signature.indexOf('(')))];
      assert.ok(names.includes('rag_golden_evidence_index'));
      for (const setup of SETUP_FILES) {
        const text = fs.readFileSync(path.join(REPO_ROOT, setup), 'utf8');
        for (const name of names) assert.ok(!new RegExp(`\\b${name}\\b`).test(text), `${name} is folded into ${setup}`);
      }
    });

    test('every function created by a 0960 to 0979 file is listed in PHASE53_SERVICE_ROLE_FUNCTIONS', () => {
      const listed = new Set(PHASE53_SERVICE_ROLE_FUNCTIONS.map((entry) => entry.signature));
      assert.deepEqual(phaseFunctions.filter((signature) => !listed.has(signature)), [], 'unlisted Phase 5.3 functions');
      assert.deepEqual(
        [...listed].filter((signature) => !phaseFunctions.includes(signature)),
        [],
        'listed functions that no 0960 to 0979 file creates',
      );
    });

    test(`phase 5.3 functions are service_role only (${mode})`, async () => {
      const rows = await full.query<{
        signature: string;
        anon: boolean;
        authenticated: boolean;
        service_role: boolean;
        public_exec: boolean;
        prosecdef: boolean;
        proconfig: string[] | null;
      }>(
        `SELECT p.oid::regprocedure::text AS signature,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
                COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), true) AS public_exec,
                p.prosecdef, p.proconfig
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'`,
      );
      const bySignature = new Map(rows.rows.map((row) => [normalise(row.signature), row]));
      for (const { signature, kind } of PHASE53_SERVICE_ROLE_FUNCTIONS) {
        const row = bySignature.get(signature);
        assert.ok(row, `${signature} is missing`);
        assert.equal(row.anon, false, `${signature} executable by anon`);
        assert.equal(row.authenticated, false, `${signature} executable by authenticated`);
        assert.equal(row.service_role, true, `${signature} not executable by service_role`);
        assert.equal(row.public_exec, false, `${signature} executable by PUBLIC`);
        assert.equal(row.prosecdef, kind === 'trigger', `${signature} SECURITY ${row.prosecdef ? 'DEFINER' : 'INVOKER'}`);
        assert.ok((row.proconfig ?? []).includes('search_path=""'), `${signature} search_path ${JSON.stringify(row.proconfig)}`);
      }
      await assertNoClientCallableRagFunctions(full);
    });

    test('anon and authenticated cannot read any phase table except rag_judge_labels', async () => {
      assert.ok(phaseTables.length >= 10, `expected the phase tables, found ${phaseTables.join(', ')}`);
      for (const role of ['anon', 'authenticated'] as const) {
        for (const table of phaseTables.filter((name) => !CLIENT_READABLE_TABLES.has(name))) {
          await assert.rejects(
            () => asRole(full, role, () => full.query(`SELECT 1 FROM public.${table} LIMIT 1`)),
            (error: unknown) => codeOf(error) === '42501',
            `${role} read ${table}`,
          );
        }
      }
    });
  });
}
