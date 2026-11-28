import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

/**
 * Plan 03.2-52 (D-31, D-50): an organization owner or admin who is not in admin_users saves translation targets for that organization only.
 * Another organization, a personal workspace and a plain member are refused in SQL, whatever the route did.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0816_translation_settings_org_admins.sql';

const ORG_O = TWO_TENANT_IDS.orgO;
const ORG_P = '00000000-0000-4000-8000-0000000052c2';
const O_ADMIN = '00000000-0000-4000-8000-0000000052f1';
const P_OWNER = '00000000-0000-4000-8000-0000000052f2';
const O_MEMBER = TWO_TENANT_IDS.userA;
const DEPLOYMENT_ADMIN = TWO_TENANT_IDS.userB;
const KEY_O = `o:${ORG_O}`;
const KEY_P = `o:${ORG_P}`;
const KEY_PERSONAL_B = `u:${TWO_TENANT_IDS.userB}`;
const KEY_PERSONAL_O_ADMIN = `u:${O_ADMIN}`;
const SET_SQL = 'SELECT * FROM rag_translation_settings_set($1, $2, $3::text[], $4)';

type Row = Record<string, unknown>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  try {
    return (await db.query<Row>(sql, params)).rows;
  } catch (error) {
    return assert.fail(`${sql.slice(0, 80).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
  }
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<{ message: string; code?: string } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return { message: messageOf(error), code: (error as { code?: string }).code };
  }
}

async function stored(db: PGlite, key: string): Promise<Row | undefined> {
  return (await rows(db, 'SELECT target_languages, enabled, updated_by FROM rag_translation_settings WHERE tenant_key = $1', [key]))[0];
}

describe('translation settings: organization admins (multi-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [O_ADMIN, 'o-admin@example.invalid', P_OWNER, 'p-owner@example.invalid']);
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [ORG_P, 'Tenant P', 'tenant-p', P_OWNER]);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin'), ($3, $4, 'owner')", [ORG_O, O_ADMIN, ORG_P, P_OWNER]);
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [DEPLOYMENT_ADMIN]);
  });

  after(async () => {
    await db?.close();
  });

  test('the organization admin is not in admin_users', async () => {
    assert.equal((await rows(db, 'SELECT count(*)::int AS n FROM admin_users WHERE id = $1', [O_ADMIN]))[0]?.n, 0);
  });

  test("an organization admin saves that organization's targets, recorded with the actor", async () => {
    const saved = (await rows(db, SET_SQL, [O_ADMIN, KEY_O, ['it', 'en'], true]))[0];
    assert.equal(saved?.tenant_key, KEY_O);
    assert.deepEqual(saved?.target_languages, ['it', 'en']);
    assert.equal(saved?.updated_by, O_ADMIN);
    assert.equal((await rows(db, SET_SQL, [P_OWNER, KEY_P, ['en'], true]))[0]?.tenant_key, KEY_P);
  });

  test('another organization, a personal workspace and a plain member are refused with 42501 and nothing is written', async () => {
    const refused: Array<[string, string]> = [
      [O_ADMIN, KEY_P],
      [O_ADMIN, KEY_PERSONAL_B],
      [O_ADMIN, KEY_PERSONAL_O_ADMIN],
      [P_OWNER, KEY_O],
      [O_MEMBER, KEY_O],
    ];
    const before = await stored(db, KEY_O);
    for (const [actor, key] of refused) {
      const err = await failure(db, SET_SQL, [actor, key, ['zh'], true]);
      assert.ok(err, `${actor} must not set ${key}`);
      assert.equal(err.code, '42501', err.message);
    }
    assert.deepEqual(await stored(db, KEY_O), before);
    assert.equal(await stored(db, KEY_PERSONAL_B), undefined);
    assert.equal(await stored(db, KEY_PERSONAL_O_ADMIN), undefined);
  });

  test('a deployment admin keeps its own personal workspace and is refused for an organization it does not administer', async () => {
    assert.equal((await rows(db, SET_SQL, [DEPLOYMENT_ADMIN, KEY_PERSONAL_B, ['en'], false]))[0]?.tenant_key, KEY_PERSONAL_B);
    assert.equal((await failure(db, SET_SQL, [DEPLOYMENT_ADMIN, KEY_O, ['en'], true]))?.code, '42501');
  });

  test('a demoted organization admin is refused at once', async () => {
    await db.query("UPDATE organization_members SET role = 'member' WHERE organization_id = $1 AND user_id = $2", [ORG_O, O_ADMIN]);
    try {
      assert.equal((await failure(db, SET_SQL, [O_ADMIN, KEY_O, ['en'], true]))?.code, '42501');
    } finally {
      await db.query("UPDATE organization_members SET role = 'admin' WHERE organization_id = $1 AND user_id = $2", [ORG_O, O_ADMIN]);
    }
  });

  test('a second apply of the migration keeps the rule, and the setter stays service_role only', async () => {
    await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
    assert.equal((await rows(db, SET_SQL, [O_ADMIN, KEY_O, ['en'], true]))[0]?.tenant_key, KEY_O);
    assert.equal((await failure(db, SET_SQL, [O_ADMIN, KEY_P, ['en'], true]))?.code, '42501');
    const grants = await rows(
      db,
      `SELECT r.rolname, has_function_privilege(r.rolname, 'public.rag_translation_settings_set(uuid, text, text[], boolean)', 'EXECUTE') AS can
       FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(rolname)`,
    );
    assert.deepEqual(
      Object.fromEntries(grants.map((row) => [row.rolname, row.can])),
      { anon: false, authenticated: false, service_role: true },
    );
    const config = await rows(
      db,
      "SELECT p.proconfig, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'rag_translation_settings_set'",
    );
    assert.equal(config.length, 1);
    assert.equal(config[0]?.prosecdef, false);
    assert.ok((config[0]?.proconfig as string[]).some((entry) => /^search_path=("")?$/.test(entry)), String(config[0]?.proconfig));
  });
});
