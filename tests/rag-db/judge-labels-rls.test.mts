import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';

type Role = 'anon' | 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const MIGRATION = 'supabase/migrations/0965_rag_judge_labels.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejectsWithAny(run: () => Promise<unknown>, codes: string[]): Promise<void> {
  await assert.rejects(run, (error: unknown) => codes.includes(sqlState(error)));
}

async function asRole<T>(db: PGlite, role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId ?? '']);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  }
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function grantExpert(db: PGlite, tenantKey: string, userId: string): Promise<void> {
  await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2)', [tenantKey, userId]);
}

async function insertItem(db: PGlite, tenantKey: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (tenant_key, query_masked, query_fingerprint, reasons, mining_window)
     VALUES ($1, 'A synthetic question about the sample topic', $2, '{low_score}', '2026-11-23T00:00:00Z') RETURNING id`,
    [tenantKey, crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex')],
  );
  return (result.rows[0] as { id: string }).id;
}

async function labelAs(db: PGlite, userId: string, itemId: string, tenantKey: string, verdict: Partial<Record<'supported' | 'relevant' | 'unsupported_content', boolean>> = {}) {
  const v = { supported: true, relevant: true, unsupported_content: false, ...verdict };
  return asRole(db, 'authenticated', userId, () =>
    db.query(
      `INSERT INTO rag_judge_labels (review_item_id, tenant_key, supported, relevant, unsupported_content, labelled_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (review_item_id, labelled_by)
       DO UPDATE SET supported = EXCLUDED.supported, relevant = EXCLUDED.relevant,
         unsupported_content = EXCLUDED.unsupported_content, labelled_at = now()`,
      [itemId, tenantKey, v.supported, v.relevant, v.unsupported_content, userId],
    ),
  );
}

async function visibleLabels(db: PGlite, userId: string): Promise<Row[]> {
  return asRole(db, 'authenticated', userId, async () => (await db.query<Row>('SELECT * FROM rag_judge_labels ORDER BY review_item_id')).rows);
}

function orgKey(): string {
  return `o:${crypto.randomUUID()}`;
}

for (const mode of MODES) {
  describe(`rag_judge_labels RLS, two tenants (${mode})`, () => {
    let db: PGlite;
    let tenantA: string;
    let tenantB: string;
    let expertA: string;
    let expertA2: string;
    let expertB: string;
    let plainUser: string;
    let itemA: string;
    let itemB: string;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      tenantA = mode === 'single-tenant' ? 's:default' : orgKey();
      // In single-tenant mode only s:default is valid for retrieval; the second key still exercises the RLS rule on stored rows.
      tenantB = orgKey();
      expertA = await createUser(db);
      expertA2 = await createUser(db);
      expertB = await createUser(db);
      plainUser = await createUser(db);
      await grantExpert(db, tenantA, expertA);
      await grantExpert(db, tenantA, expertA2);
      await grantExpert(db, tenantB, expertB);
      itemA = await insertItem(db, tenantA);
      itemB = await insertItem(db, tenantB);
    });

    after(async () => {
      await db.close();
    });

    test('the table exists with RLS enabled', async () => {
      const row = (await db.query<{ rls: boolean | null }>("SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.rag_judge_labels')) AS rls")).rows[0];
      assert.equal(row?.rls, true);
    });

    test("an expert of tenant A labels an item of tenant A and reads it back", async () => {
      const result = await labelAs(db, expertA, itemA, tenantA);
      assert.equal(result.affectedRows, 1);
      const rows = await visibleLabels(db, expertA);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.review_item_id, itemA);
      assert.equal(rows[0]?.labelled_by, expertA);
      assert.equal(rows[0]?.supported, true);
    });

    test("tenant A reading tenant B: an expert of A sees zero of B's labels", async () => {
      await labelAs(db, expertB, itemB, tenantB, { supported: false });
      const ofA = await visibleLabels(db, expertA);
      assert.ok(ofA.every((row) => row.tenant_key === tenantA));
      const direct = await asRole(db, 'authenticated', expertA, async () => (await db.query('SELECT id FROM rag_judge_labels WHERE review_item_id = $1', [itemB])).rows);
      assert.equal(direct.length, 0);
      const ofB = await visibleLabels(db, expertB);
      assert.ok(ofB.length >= 1 && ofB.every((row) => row.tenant_key === tenantB));
    });

    test("tenant A writing tenant B: an expert of A cannot insert a label of B's item under B's key", async () => {
      await rejectsWithAny(() => labelAs(db, expertA, itemB, tenantB), ['42501']);
      const count = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_judge_labels WHERE labelled_by = $1 AND tenant_key = $2', [expertA, tenantB])).rows[0]?.n;
      assert.equal(count, 0);
    });

    test("tenant A writing tenant B: an expert of A cannot attach B's item under A's key", async () => {
      await rejectsWithAny(() => labelAs(db, expertA, itemB, tenantA), ['23503', '42501']);
    });

    test("tenant A writing tenant B: an expert of A cannot update B's label", async () => {
      const result = await asRole(db, 'authenticated', expertA, () => db.query('UPDATE rag_judge_labels SET supported = true WHERE review_item_id = $1', [itemB]));
      assert.equal(result.affectedRows ?? 0, 0);
      const row = (await db.query<Row>('SELECT supported FROM rag_judge_labels WHERE review_item_id = $1 AND labelled_by = $2', [itemB, expertB])).rows[0];
      assert.equal(row?.supported, false);
    });

    test("an expert cannot move a label of A to tenant B", async () => {
      await rejectsWithAny(
        () => asRole(db, 'authenticated', expertA, () => db.query('UPDATE rag_judge_labels SET tenant_key = $2 WHERE review_item_id = $1', [itemA, tenantB])),
        ['42501', '23503'],
      );
    });

    test("a label whose tenant_key differs from its item's tenant_key is rejected, also for the service role", async () => {
      await rejectsWithAny(
        () =>
          db.query(
            'INSERT INTO rag_judge_labels (review_item_id, tenant_key, supported, relevant, unsupported_content, labelled_by) VALUES ($1, $2, true, true, false, $3)',
            [itemA, tenantB, expertB],
          ),
        ['23503'],
      );
    });

    test('labelled_by must be the caller', async () => {
      const item = await insertItem(db, tenantA);
      await rejectsWithAny(
        () =>
          asRole(db, 'authenticated', expertA, () =>
            db.query(
              'INSERT INTO rag_judge_labels (review_item_id, tenant_key, supported, relevant, unsupported_content, labelled_by) VALUES ($1, $2, true, true, false, $3)',
              [item, tenantA, expertA2],
            ),
          ),
        ['42501'],
      );
    });

    test("another expert of the same tenant cannot overwrite someone else's label", async () => {
      const result = await asRole(db, 'authenticated', expertA2, () =>
        db.query('UPDATE rag_judge_labels SET supported = false WHERE review_item_id = $1 AND labelled_by = $2', [itemA, expertA]),
      );
      assert.equal(result.affectedRows ?? 0, 0);
      const row = (await db.query<Row>('SELECT supported FROM rag_judge_labels WHERE review_item_id = $1 AND labelled_by = $2', [itemA, expertA])).rows[0];
      assert.equal(row?.supported, true);
    });

    test('one label per item and labeller: a second save updates it', async () => {
      await labelAs(db, expertA, itemA, tenantA, { supported: false, unsupported_content: true });
      const rows = (await db.query<Row>('SELECT supported, unsupported_content FROM rag_judge_labels WHERE review_item_id = $1 AND labelled_by = $2', [itemA, expertA])).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.supported, false);
      assert.equal(rows[0]?.unsupported_content, true);
      await rejectsWithAny(
        () =>
          db.query(
            'INSERT INTO rag_judge_labels (review_item_id, tenant_key, supported, relevant, unsupported_content, labelled_by) VALUES ($1, $2, true, true, false, $3)',
            [itemA, tenantA, expertA],
          ),
        ['23505'],
      );
    });

    test('the three verdicts are required', async () => {
      const item = await insertItem(db, tenantA);
      await rejectsWithAny(
        () =>
          asRole(db, 'authenticated', expertA, () =>
            db.query('INSERT INTO rag_judge_labels (review_item_id, tenant_key, supported, relevant, labelled_by) VALUES ($1, $2, true, true, $3)', [item, tenantA, expertA]),
          ),
        ['23502'],
      );
    });

    test('anon is refused; a signed-in user who is no expert reads zero rows and cannot write', async () => {
      await rejectsWithAny(() => asRole(db, 'anon', null, () => db.query('SELECT * FROM rag_judge_labels')), ['42501']);
      await rejectsWithAny(
        () =>
          asRole(db, 'anon', null, () =>
            db.query('INSERT INTO rag_judge_labels (review_item_id, tenant_key, supported, relevant, unsupported_content, labelled_by) VALUES ($1, $2, true, true, false, $3)', [itemA, tenantA, expertA]),
          ),
        ['42501'],
      );
      assert.deepEqual(await visibleLabels(db, plainUser), []);
      await rejectsWithAny(() => labelAs(db, plainUser, itemA, tenantA), ['42501']);
    });

    test('authenticated cannot delete labels', async () => {
      await rejectsWithAny(() => asRole(db, 'authenticated', expertA, () => db.query('DELETE FROM rag_judge_labels WHERE review_item_id = $1', [itemA])), ['42501']);
    });

    test('revoking the expert grant removes read access', async () => {
      await db.query('DELETE FROM rag_domain_experts WHERE tenant_key = $1 AND user_id = $2', [tenantA, expertA2]);
      assert.deepEqual(await visibleLabels(db, expertA2), []);
    });

    test('deleting the review item deletes its labels', async () => {
      const item = await insertItem(db, tenantA);
      await labelAs(db, expertA, item, tenantA);
      await db.query('DELETE FROM rag_review_items WHERE id = $1', [item]);
      assert.equal((await db.query('SELECT 1 FROM rag_judge_labels WHERE review_item_id = $1', [item])).rows.length, 0);
    });

    test('0965 is idempotent: applying it again keeps three policies and the labels', async () => {
      const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_judge_labels')).rows[0]?.n;
      await applyMigrationFiles(db, [MIGRATION]);
      const policies = (await db.query<{ cmd: string }>("SELECT cmd FROM pg_policies WHERE tablename = 'rag_judge_labels' ORDER BY cmd")).rows.map((row) => row.cmd);
      assert.deepEqual(policies, ['INSERT', 'SELECT', 'UPDATE']);
      assert.equal((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_judge_labels')).rows[0]?.n, before);
    });
  });
}

describe('rag_judge_labels single-tenant admin rule', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
  });

  after(async () => {
    await db.close();
  });

  test('an admin labels an s:default item without a grant row; a non-admin cannot', async () => {
    const admin = await createUser(db);
    const plain = await createUser(db);
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [admin]);
    const item = await insertItem(db, 's:default');
    assert.equal((await labelAs(db, admin, item, 's:default')).affectedRows, 1);
    assert.equal((await visibleLabels(db, admin)).length, 1);
    await rejectsWithAny(() => labelAs(db, plain, item, 's:default'), ['42501']);
  });
});

describe('0965 without the Phase 5.1.1 tables', () => {
  test('applies as a no-op on a database without rag_review_items', async () => {
    const db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', migrations: false })).db;
    try {
      await db.exec('DROP TABLE IF EXISTS public.rag_judge_labels CASCADE; DROP TABLE IF EXISTS public.rag_review_items CASCADE;');
      await applyMigrationFiles(db, [MIGRATION]);
      const row = (await db.query<{ t: string | null }>("SELECT to_regclass('public.rag_judge_labels')::text AS t")).rows[0];
      assert.equal(row?.t, null);
    } finally {
      await db.close();
    }
  });
});
