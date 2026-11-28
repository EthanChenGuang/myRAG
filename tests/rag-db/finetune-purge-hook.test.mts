import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const MIGRATION = 'supabase/migrations/0992_rag_purge_hook_finetune.sql';
const USER_A = '00000000-0000-4000-8000-0000000061a1';
const USER_B = '00000000-0000-4000-8000-0000000061b1';
const SIGNATURE = 'public.rag_purge_hook_finetune(text, uuid, uuid[])';

type Role = 'anon' | 'authenticated' | 'service_role';

interface VersionRow {
  id: string;
  status: string;
  tenant_keys: string[];
  tainted: boolean;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function hookExists(db: PGlite): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(`SELECT to_regprocedure('${SIGNATURE}') IS NOT NULL AS ok`);
  return r.rows[0]!.ok;
}

async function hook(db: PGlite, tenantKey: string, lineageId: string | null, documentIds: string[] | null): Promise<number> {
  const r = await db.query<{ n: string | number }>('SELECT public.rag_purge_hook_finetune($1, $2, $3::uuid[]) AS n', [
    tenantKey,
    lineageId,
    documentIds,
  ]);
  return Number(r.rows[0]!.n);
}

async function grant(db: PGlite, tenantKey: string, scope: 'private' | 'deployment'): Promise<void> {
  await db.query('SELECT * FROM public.rag_finetune_set_consent($1, $2, $3, $4)', [tenantKey, scope, 'TICKET-6101', 'admin:test']);
}

async function insertVersion(db: PGlite, id: string, scope: 'deployment' | 'tenant', tenantKeys: string[]): Promise<void> {
  await db.query(
    `INSERT INTO public.embedding_model_versions
       (id, base_model, base_revision, scope, tenant_keys, dataset_manifest_sha256, training_config_sha256, offline_metrics, probe,
        query_prompt, document_prompt, dims, artifact_uri, created_by)
     VALUES ($1, 'example-org/example-embedding', $2, $3, $4::text[], $5, $6, '{}'::jsonb, '{}'::jsonb, 'query: ', 'passage: ', 1024, $7,
             'admin:test')`,
    [id, 'a'.repeat(40), scope, [...tenantKeys].sort(), 'b'.repeat(64), 'c'.repeat(64), `s3://models-bucket/${id}`],
  );
}

async function versions(db: PGlite): Promise<VersionRow[]> {
  const r = await db.query<VersionRow>(
    'SELECT id, status, tenant_keys, tainted_at IS NOT NULL AS tainted FROM public.embedding_model_versions ORDER BY id',
  );
  return r.rows;
}

async function consent(db: PGlite): Promise<Record<string, string>> {
  const r = await db.query<{ tenant_key: string; scope: string }>('SELECT tenant_key, scope FROM public.rag_finetune_consent ORDER BY tenant_key');
  return Object.fromEntries(r.rows.map((row) => [row.tenant_key, row.scope]));
}

async function insertDoc(db: PGlite, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO documents (id, filename, content, metadata, user_id, lineage_id, source_key, status, is_current, version)
     VALUES ($1, $2, 'placeholder', '{}'::jsonb, $3, $1, $4, 'ready', true, 1)`,
    [id, `doc-${id}.md`, userId, `legacy:${id}`],
  );
  return id;
}

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';
  const TENANT_A = multi ? `u:${USER_A}` : 's:default';
  const TENANT_B = `u:${USER_B}`;
  const OTHER_MODE_KEY = multi ? 's:default' : `u:${USER_A}`;

  describe(`rag_purge_hook_finetune 0992 (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [
        USER_A,
        'tenant-a@example.invalid',
        USER_B,
        'tenant-b@example.invalid',
      ]);
    });

    after(async () => {
      await db?.close();
    });

    beforeEach(async () => {
      await db.exec('DELETE FROM public.embedding_model_versions; DELETE FROM public.rag_finetune_consent; DELETE FROM documents;');
      await grant(db, TENANT_A, 'deployment');
      await insertVersion(db, 'ft-own-model-a1', multi ? 'tenant' : 'deployment', [TENANT_A]);
      if (multi) {
        await grant(db, TENANT_B, 'deployment');
        await insertVersion(db, 'ft-shared-model-ab', 'deployment', [TENANT_A, TENANT_B]);
        await insertVersion(db, 'ft-other-model-b1', 'tenant', [TENANT_B]);
      }
    });

    test('the hook exists, is invoker with an empty search_path and is service_role only', async () => {
      assert.ok(await hookExists(db), `${SIGNATURE} is missing`);
      const r = await db.query<{ prosecdef: boolean; proconfig: string[] | null; anon: boolean; authenticated: boolean; service_role: boolean }>(
        `SELECT p.prosecdef, p.proconfig,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
           FROM pg_proc p WHERE p.oid = '${SIGNATURE}'::regprocedure`,
      );
      const row = r.rows[0]!;
      assert.equal(row.prosecdef, false);
      assert.ok((row.proconfig ?? []).includes('search_path=""'), JSON.stringify(row.proconfig));
      assert.deepEqual([row.anon, row.authenticated, row.service_role], [false, false, true]);
    });

    test('a tenant purge deletes the consent row, taints every version trained on the tenant and strips its key', async () => {
      assert.ok(await hookExists(db), `${SIGNATURE} is missing`);
      const n = await asRole(db, 'service_role', () => hook(db, TENANT_A, null, null));
      assert.equal(n, multi ? 3 : 2, 'one consent row and every version of the tenant');
      const left = await consent(db);
      assert.equal(left[TENANT_A], undefined, 'the consent row is gone');
      const rows = await versions(db);
      const own = rows.find((row) => row.id === 'ft-own-model-a1')!;
      assert.deepEqual([own.status, own.tainted, own.tenant_keys], ['tainted', true, []]);
      for (const row of rows) assert.ok(!row.tenant_keys.includes(TENANT_A), `${row.id} still names the tenant`);
      if (multi) {
        assert.equal(left[TENANT_B], 'deployment', 'the other tenant keeps its consent');
        const shared = rows.find((row) => row.id === 'ft-shared-model-ab')!;
        assert.deepEqual([shared.status, shared.tenant_keys], ['tainted', [TENANT_B]]);
        const other = rows.find((row) => row.id === 'ft-other-model-b1')!;
        assert.deepEqual([other.status, other.tainted, other.tenant_keys], ['registered', false, [TENANT_B]]);
      }
    });

    test('a second identical call returns 0 and changes nothing', async () => {
      assert.ok(await hookExists(db), `${SIGNATURE} is missing`);
      await hook(db, TENANT_A, null, null);
      const before = [await versions(db), await consent(db)];
      assert.equal(await hook(db, TENANT_A, null, []), 0);
      assert.deepEqual([await versions(db), await consent(db)], before);
    });

    test('a document purge taints the tenant\'s versions and keeps the consent row and the keys', async () => {
      assert.ok(await hookExists(db), `${SIGNATURE} is missing`);
      const doc = await insertDoc(db, USER_A);
      assert.equal(await hook(db, TENANT_A, doc, [doc]), multi ? 2 : 1);
      assert.equal((await consent(db))[TENANT_A], 'deployment');
      const own = (await versions(db)).find((row) => row.id === 'ft-own-model-a1')!;
      assert.deepEqual([own.status, own.tenant_keys], ['tainted', [TENANT_A]]);
      assert.equal(await hook(db, TENANT_A, doc, [doc]), 0, 'already tainted');
    });

    if (multi) {
      test('a document of another tenant is refused with 22023 and changes nothing', async () => {
        assert.ok(await hookExists(db), `${SIGNATURE} is missing`);
        const docB = await insertDoc(db, USER_B);
        const before = await versions(db);
        await assert.rejects(() => hook(db, TENANT_A, null, [docB]), (error: unknown) => codeOf(error) === '22023');
        assert.deepEqual(await versions(db), before);
      });
    }

    test('a key of the other deployment mode raises 22023', async () => {
      assert.ok(await hookExists(db), `${SIGNATURE} is missing`);
      await assert.rejects(() => hook(db, OTHER_MODE_KEY, null, null), (error: unknown) => codeOf(error) === '22023');
    });

    test('anon and authenticated get 42501', async () => {
      assert.ok(await hookExists(db), `${SIGNATURE} is missing`);
      for (const role of ['anon', 'authenticated'] as const) {
        await assert.rejects(
          () => asRole(db, role, () => hook(db, TENANT_A, null, null)),
          (error: unknown) => codeOf(error) === '42501',
        );
      }
    });

    test('0992 applies twice and the hook still works', async () => {
      await applyMigrationFiles(db, [MIGRATION, MIGRATION]);
      assert.ok(await hookExists(db), `${SIGNATURE} is missing`);
      const r = await db.query<{ hooks: number; inventory: string | null }>(
        `SELECT (SELECT count(*)::int FROM pg_proc WHERE proname = 'rag_purge_hook_finetune') AS hooks,
                to_regprocedure('public.rag_purge_store_inventory()')::text AS inventory`,
      );
      assert.equal(r.rows[0]!.hooks, 1);
      assert.equal(await hook(db, TENANT_A, null, null), multi ? 3 : 2);
    });
  });
}
