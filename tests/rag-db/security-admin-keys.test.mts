import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SIGNATURES = ['rag_security_admin_keys(uuid, boolean)', 'rag_security_uploader_in_tenant(text, uuid)'];

async function asService<T extends Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec('SET ROLE service_role');
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function keysOf(db: PGlite, actor: string | null, deploymentAdmin: boolean): Promise<string[]> {
  const rows = await asService<{ keys: string[] }>(db, 'SELECT public.rag_security_admin_keys($1::uuid, $2) AS keys', [actor, deploymentAdmin]);
  return rows[0]?.keys ?? [];
}

async function inTenant(db: PGlite, tenantKey: string, userId: string): Promise<boolean> {
  const rows = await asService<{ found: boolean }>(db, 'SELECT public.rag_security_uploader_in_tenant($1, $2::uuid) AS found', [tenantKey, userId]);
  return rows[0]?.found === true;
}

async function insertEvent(db: PGlite, tenantKey: string, uploader: string | null): Promise<void> {
  await asService(db, "INSERT INTO public.rag_security_events (tenant_key, source, action, detector, uploader_id) VALUES ($1, 'output_guard', 'removed', 'rules', $2)", [
    tenantKey,
    uploader,
  ]);
}

for (const mode of MODES) {
  describe(`security-events admin keys (${mode})`, () => {
    let db: PGlite;
    let admin: string;
    let orgAdmin: string;
    let orgMember: string;
    let expert: string;
    let stranger: string;
    let uploader: string;
    let orgA: string;
    let orgB: string;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseFunctionDefaults: true })).db;
      admin = await createUser(db);
      orgAdmin = await createUser(db);
      orgMember = await createUser(db);
      expert = await createUser(db);
      stranger = await createUser(db);
      uploader = await createUser(db);
      await db.query('INSERT INTO admin_users (id) VALUES ($1)', [admin]);
      orgA = crypto.randomUUID();
      orgB = crypto.randomUUID();
      if (mode === 'multi-tenant') {
        for (const id of [orgA, orgB]) {
          await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [id, 'Workspace', `ws-${id.slice(0, 8)}`, orgAdmin]);
        }
        await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING", [orgA, orgAdmin]);
        await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [orgA, orgMember]);
        await db.query("DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2", [orgB, orgAdmin]);
        await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2)', [`o:${orgB}`, expert]);
        await insertEvent(db, `o:${orgA}`, uploader);
        await insertEvent(db, `o:${orgB}`, null);
        await insertEvent(db, `u:${uploader}`, uploader);
      } else {
        await db.query("INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ('s:default', $1)", [expert]);
        await insertEvent(db, 's:default', uploader);
      }
    });

    after(async () => {
      await db.close();
    });

    test('both functions are SECURITY INVOKER, have an empty search_path and are callable by service_role only', async () => {
      for (const signature of SIGNATURES) {
        const row = (
          await db.query<{ anon: boolean; authenticated: boolean; service: boolean; definer: boolean; config: string[] | null }>(
            `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service, p.prosecdef AS definer, p.proconfig AS config
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
            [`public.${signature}`],
          )
        ).rows[0];
        assert.ok(row, signature);
        assert.equal(row.anon, false, signature);
        assert.equal(row.authenticated, false, signature);
        assert.equal(row.service, true, signature);
        assert.equal(row.definer, false, signature);
        assert.ok((row.config ?? []).some((entry) => entry === 'search_path=' || entry === 'search_path=""'), signature);
      }
    });

    test('a deployment admin gets every tenant with security rows; a non-admin claiming it is refused', async () => {
      const keys = await keysOf(db, admin, true);
      if (mode === 'single-tenant') {
        assert.deepEqual(keys, ['s:default']);
      } else {
        assert.deepEqual(keys, [`o:${orgA}`, `o:${orgB}`, `u:${uploader}`].sort());
      }
      await assert.rejects(keysOf(db, stranger, true), (error: unknown) => (error as { code?: string }).code === '42501');
    });

    test('organization admins get their organization, experts their granted tenant, members and strangers nothing', async () => {
      if (mode === 'single-tenant') {
        assert.deepEqual(await keysOf(db, orgAdmin, false), []);
        assert.deepEqual(await keysOf(db, expert, false), ['s:default']);
      } else {
        assert.deepEqual(await keysOf(db, orgAdmin, false), [`o:${orgA}`]);
        assert.deepEqual(await keysOf(db, expert, false), [`o:${orgB}`]);
      }
      assert.deepEqual(await keysOf(db, orgMember, false), []);
      assert.deepEqual(await keysOf(db, stranger, false), []);
      assert.deepEqual(await keysOf(db, null, false), []);
      assert.deepEqual(await keysOf(db, admin, false), []);
    });

    test('an uploader belongs to a tenant through its events; a user with nothing there does not', async () => {
      const tenant = mode === 'single-tenant' ? 's:default' : `o:${orgA}`;
      assert.equal(await inTenant(db, tenant, uploader), true);
      assert.equal(await inTenant(db, tenant, stranger), false);
      if (mode === 'multi-tenant') assert.equal(await inTenant(db, `o:${orgB}`, uploader), false);
      await assert.rejects(inTenant(db, 'not-a-key', uploader), (error: unknown) => (error as { code?: string }).code === '22023');
    });
  });
}
