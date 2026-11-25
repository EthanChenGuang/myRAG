import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const M0354 = 'supabase/migrations/0354_parse_budget.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

const ACTOR = '00000000-0000-4000-8000-0000000000c1';
const TENANT_SINGLE = 's:default';

const OVERRIDE_FUNCTIONS = ['rag_get_parse_tier_overrides', 'rag_set_parse_tier_override'] as const;

type Role = 'anon' | 'authenticated' | 'service_role';

async function applyBudgetMigration(db: PGlite): Promise<void> {
  await db.exec(fs.readFileSync(path.join(REPO_ROOT, M0354), 'utf8'));
}

async function tryQuery(db: PGlite, sql: string, params: unknown[] = []): Promise<{ message: string; code: string | null } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : null;
    return { message, code };
  }
}

function expectSqlState(err: { message: string; code: string | null } | null, state: string): void {
  assert.ok(err, `expected SQLSTATE ${state}`);
  assert.ok(err.code === state || err.message.includes(state), `expected ${state}, got code=${err.code} message=${err.message}`);
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

for (const mode of MODES) {
  describe(`parse tier overrides (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS, supabaseGrants: true, migrations: true });
      db = fixture.db;
      await applyBudgetMigration(db);
    });

    after(async () => {
      await fixture.db.close();
    });

    test('override RPCs are executable by service_role only', async () => {
      const exposure = await db.query<{ proname: string; anon: boolean; authenticated: boolean; service: boolean }>(
        `SELECT p.proname,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
         FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)
         ORDER BY p.proname`,
        [OVERRIDE_FUNCTIONS],
      );
      assert.equal(exposure.rows.length, OVERRIDE_FUNCTIONS.length);
      for (const row of exposure.rows) {
        assert.deepEqual(
          { anon: row.anon, authenticated: row.authenticated, service: row.service },
          { anon: false, authenticated: false, service: true },
          row.proname,
        );
      }
    });

    test('anon and authenticated cannot call override RPCs', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        await asRole(db, role, async () => {
          const err = await tryQuery(db, 'SELECT rag_get_parse_tier_overrides()');
          expectSqlState(err, '42501');
        });
      }
    });

    test('set then get returns bounds; both null deletes', async () => {
      await db.query('SELECT rag_set_parse_tier_override($1, $2, $3, $4::uuid)', ['invoice_receipt', 'structured', 'premium', ACTOR]);
      const rows = await db.query<{ doc_type: string; min_tier: string; max_tier: string; updated_by: string; updated_at: Date }>(
        'SELECT doc_type, min_tier, max_tier, updated_by, updated_at FROM rag_get_parse_tier_overrides()',
      );
      const hit = rows.rows.find((row) => row.doc_type === 'invoice_receipt');
      assert.ok(hit);
      assert.equal(hit.min_tier, 'structured');
      assert.equal(hit.max_tier, 'premium');
      assert.equal(hit.updated_by, ACTOR);
      assert.ok(hit.updated_at instanceof Date);

      await db.query('SELECT rag_set_parse_tier_override($1, NULL, NULL, $2::uuid)', ['invoice_receipt', ACTOR]);
      const after = await db.query<{ doc_type: string }>('SELECT doc_type FROM rag_get_parse_tier_overrides()');
      assert.ok(!after.rows.some((row) => row.doc_type === 'invoice_receipt'));
    });

    test('unknown doc type and min above max raise 22023', async () => {
      const unknown = await tryQuery(db, 'SELECT rag_set_parse_tier_override($1, $2, $3, $4::uuid)', [
        'not_a_real_type',
        'fast',
        'premium',
        ACTOR,
      ]);
      expectSqlState(unknown, '22023');
      const order = await tryQuery(db, 'SELECT rag_set_parse_tier_override($1, $2, $3, $4::uuid)', [
        'general',
        'premium',
        'fast',
        ACTOR,
      ]);
      expectSqlState(order, '22023');
    });

    test('each set writes one rag_admin_audit row with the actor', async () => {
      const before = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_admin_audit');
      await db.query('SELECT rag_set_parse_tier_override($1, $2, $3, $4::uuid)', ['product_technical', 'structured', 'premium', ACTOR]);
      const after = await db.query<{ action: string; actor: string; rule_ids: string[] }>(
        'SELECT action, actor::text, rule_ids FROM rag_admin_audit ORDER BY created_at DESC LIMIT 1',
      );
      assert.equal(after.rows.length, 1);
      assert.equal(after.rows[0]?.action, 'set_parse_tier_override');
      assert.equal(after.rows[0]?.actor, ACTOR);
      assert.ok(after.rows[0]?.rule_ids.includes('product_technical'));
      const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_admin_audit');
      assert.equal(count.rows[0]?.n, (before.rows[0]?.n ?? 0) + 1);
    });
  });
}