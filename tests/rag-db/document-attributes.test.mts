import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

/**
 * TPL-03 / TPL-08 (D-02, D-12, D-22): attribute definitions per tenant, written and listed only through the service-role functions of
 * migration 1003, admitted by rag_upload_approval_keys. Definitions section (plan 03.3-08); plan 03.3-11 appends the values section.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/1003_attribute_definitions.sql';

const ORG_A = '00000000-0000-4000-8000-000000100301';
const ORG_B = '00000000-0000-4000-8000-000000100302';
const ADMIN_A = '00000000-0000-4000-8000-000000100311';
const ADMIN_B = '00000000-0000-4000-8000-000000100312';
const MEMBER_A = '00000000-0000-4000-8000-000000100313';
const KEY_A = `o:${ORG_A}`;
const KEY_B = `o:${ORG_B}`;

const FUNCTIONS = [
  'rag_attribute_definitions_list(uuid, text)',
  'rag_attribute_definitions_for(text)',
  'rag_attribute_definition_upsert(uuid, text, text, text, boolean, boolean, boolean, boolean)',
  'rag_attribute_definition_delete(uuid, text, text)',
];

type Row = Record<string, unknown>;

const LIST_SQL = 'SELECT * FROM rag_attribute_definitions_list(p_actor => $1, p_tenant_key => $2)';
const FOR_SQL = 'SELECT * FROM rag_attribute_definitions_for(p_tenant_key => $1)';
const UPSERT_SQL = `SELECT * FROM rag_attribute_definition_upsert(p_actor => $1, p_tenant_key => $2, p_key => $3, p_type => $4,
  p_filterable => $5, p_in_header => $6, p_in_identifier_index => $7, p_soft => $8)`;
const DELETE_SQL = 'SELECT rag_attribute_definition_delete(p_actor => $1, p_tenant_key => $2, p_key => $3) AS key';

interface Flags {
  filterable?: boolean | null;
  inHeader?: boolean | null;
  inIdentifierIndex?: boolean | null;
  soft?: boolean | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  try {
    return (await db.query<Row>(sql, params)).rows;
  } catch (error) {
    return assert.fail(`${sql.slice(0, 80).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
  }
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<{ message: string; code: string | null } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return { message: messageOf(error), code: codeOf(error) };
  }
}

function upsertParams(actor: string, tenantKey: string, key: string | null, type: string | null, flags: Flags = {}): unknown[] {
  return [
    actor,
    tenantKey,
    key,
    type,
    flags.filterable === undefined ? false : flags.filterable,
    flags.inHeader === undefined ? false : flags.inHeader,
    flags.inIdentifierIndex === undefined ? false : flags.inIdentifierIndex,
    flags.soft === undefined ? false : flags.soft,
  ];
}

async function upsert(db: PGlite, actor: string, tenantKey: string, key: string, type: string, flags: Flags = {}): Promise<Row> {
  const found = await rows(db, UPSERT_SQL, upsertParams(actor, tenantKey, key, type, flags));
  assert.equal(found.length, 1);
  return found[0] as Row;
}

async function refusal(db: PGlite, sql: string, params: unknown[], word: string): Promise<void> {
  const failed = await failure(db, sql, params);
  assert.ok(failed !== null, `expected ${word}`);
  assert.match(failed.message, new RegExp(`^${word}`), `expected ${word}, got a different refusal`);
}

async function malformed(db: PGlite, sql: string, params: unknown[]): Promise<void> {
  const failed = await failure(db, sql, params);
  assert.ok(failed !== null, 'expected a refusal');
  assert.equal(failed.code, '22023');
}

async function definitionCount(db: PGlite, tenantKey?: string): Promise<number> {
  const found = tenantKey
    ? await rows(db, 'SELECT count(*)::int AS n FROM public.rag_attribute_definitions WHERE tenant_key = $1', [tenantKey])
    : await rows(db, 'SELECT count(*)::int AS n FROM public.rag_attribute_definitions');
  return Number(found[0]?.n);
}

async function seedTemplate(db: PGlite, tenantKey: string, template: string): Promise<void> {
  await rows(
    db,
    `INSERT INTO public.rag_attribute_header_templates (tenant_key, template) VALUES ($1, $2)
     ON CONFLICT (tenant_key) DO UPDATE SET template = EXCLUDED.template`,
    [tenantKey, template],
  );
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated', run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [FIXTURE_USER_ID]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

const keys = (found: Row[]): string[] => found.map((row) => String(row.key));

describe('attribute definitions across two tenants (multi-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)', [
      ADMIN_A,
      'admin-a@example.invalid',
      ADMIN_B,
      'admin-b@example.invalid',
      MEMBER_A,
      'member-a@example.invalid',
    ]);
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false), ($5, $6, $7, $8, false)', [
      ORG_A,
      'Tenant A',
      'tenant-a-1003',
      ADMIN_A,
      ORG_B,
      'Tenant B',
      'tenant-b-1003',
      ADMIN_B,
    ]);
    await db.query(
      "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner'), ($1, $5, 'member') ON CONFLICT DO NOTHING",
      [ORG_A, ADMIN_A, ORG_B, ADMIN_B, MEMBER_A],
    );
  });

  after(async () => {
    await db?.close();
  });

  test('off state: no definition row exists after all migrations and before any call', async () => {
    assert.equal(await definitionCount(db), 0);
  });

  test('an upsert of a new key returns the stored row; a second upsert of the same key changes only the flags', async () => {
    const created = await upsert(db, ADMIN_A, KEY_A, 'alpha_code', 'code', { filterable: true, inIdentifierIndex: true });
    assert.deepEqual(
      { key: created.key, type: created.type, filterable: created.filterable, in_header: created.in_header, in_identifier_index: created.in_identifier_index, soft: created.soft },
      { key: 'alpha_code', type: 'code', filterable: true, in_header: false, in_identifier_index: true, soft: false },
    );
    assert.ok(created.updated_at instanceof Date || typeof created.updated_at === 'string');
    const changed = await upsert(db, ADMIN_A, KEY_A, 'alpha_code', 'code', { filterable: false, inHeader: true, soft: true });
    assert.deepEqual(
      { key: changed.key, type: changed.type, filterable: changed.filterable, in_header: changed.in_header, in_identifier_index: changed.in_identifier_index, soft: changed.soft },
      { key: 'alpha_code', type: 'code', filterable: false, in_header: true, in_identifier_index: false, soft: true },
    );
    assert.equal(await definitionCount(db, KEY_A), 1);
  });

  test("the list returns the tenant's rows in key order for an admin of it; the service read needs no actor", async () => {
    await upsert(db, ADMIN_A, KEY_A, 'beta_list', 'text_list', { filterable: true });
    await upsert(db, ADMIN_A, KEY_A, 'aaa_text', 'text');
    await upsert(db, ADMIN_B, KEY_B, 'gamma_text', 'text');
    assert.deepEqual(keys(await rows(db, LIST_SQL, [ADMIN_A, KEY_A])), ['aaa_text', 'alpha_code', 'beta_list']);
    assert.deepEqual(keys(await rows(db, LIST_SQL, [ADMIN_B, KEY_B])), ['gamma_text']);
    const served = await rows(db, FOR_SQL, [KEY_A]);
    assert.deepEqual(keys(served), ['aaa_text', 'alpha_code', 'beta_list']);
    const list = served.find((row) => row.key === 'beta_list') as Row;
    assert.deepEqual(
      { type: list.type, filterable: list.filterable, in_header: list.in_header, in_identifier_index: list.in_identifier_index, soft: list.soft },
      { type: 'text_list', filterable: true, in_header: false, in_identifier_index: false, soft: false },
    );
    for (const column of Object.keys(list)) assert.ok(!/tenant/.test(column), column);
  });

  test("an actor who is not an admin of the tenant lists nothing and cannot write; the other tenant's admin is refused the same way", async () => {
    for (const actor of [MEMBER_A, ADMIN_B]) {
      const before = await definitionCount(db, KEY_A);
      assert.deepEqual(await rows(db, LIST_SQL, [actor, KEY_A]), []);
      await refusal(db, UPSERT_SQL, upsertParams(actor, KEY_A, 'delta_text', 'text'), 'not_admin');
      await refusal(db, UPSERT_SQL, upsertParams(actor, KEY_A, 'alpha_code', 'code', { filterable: true }), 'not_admin');
      await refusal(db, DELETE_SQL, [actor, KEY_A, 'aaa_text'], 'not_admin');
      assert.equal(await definitionCount(db, KEY_A), before);
    }
    assert.deepEqual(await rows(db, LIST_SQL, [null, KEY_A]), []);
    assert.equal((await rows(db, FOR_SQL, [KEY_A])).find((row) => row.key === 'alpha_code')?.filterable, false);
  });

  test('an existing key cannot change type; in_identifier_index is allowed on code only', async () => {
    await refusal(db, UPSERT_SQL, upsertParams(ADMIN_A, KEY_A, 'alpha_code', 'text'), 'invalid_attribute_type');
    await refusal(db, UPSERT_SQL, upsertParams(ADMIN_A, KEY_A, 'epsilon_text', 'text', { inIdentifierIndex: true }), 'invalid_attribute_type');
    await refusal(db, UPSERT_SQL, upsertParams(ADMIN_A, KEY_A, 'beta_list', 'text_list', { inIdentifierIndex: true }), 'invalid_attribute_type');
    assert.equal((await rows(db, FOR_SQL, [KEY_A])).find((row) => row.key === 'alpha_code')?.type, 'code');
    assert.ok(!keys(await rows(db, FOR_SQL, [KEY_A])).includes('epsilon_text'));
  });

  test('malformed keys, types and NULL flags raise with ERRCODE 22023', async () => {
    const before = await definitionCount(db, KEY_A);
    for (const key of ['Upper_key', '1leading', `k${'x'.repeat(40)}`, '', null, 'with-dash', 'brace{x}']) {
      await malformed(db, UPSERT_SQL, upsertParams(ADMIN_A, KEY_A, key, 'text'));
    }
    for (const type of ['number', 'TEXT', '', null]) await malformed(db, UPSERT_SQL, upsertParams(ADMIN_A, KEY_A, 'zeta_text', type));
    for (const flag of ['filterable', 'inHeader', 'inIdentifierIndex', 'soft'] as const) {
      await malformed(db, UPSERT_SQL, upsertParams(ADMIN_A, KEY_A, 'zeta_text', 'text', { [flag]: null }));
    }
    for (const key of ['Upper_key', null]) await malformed(db, DELETE_SQL, [ADMIN_A, KEY_A, key]);
    assert.equal(await definitionCount(db, KEY_A), before);
  });

  test("delete removes the row; an unknown key or the other tenant's key is not_found and changes nothing", async () => {
    await upsert(db, ADMIN_A, KEY_A, 'eta_text', 'text');
    assert.deepEqual(await rows(db, DELETE_SQL, [ADMIN_A, KEY_A, 'eta_text']), [{ key: 'eta_text' }]);
    assert.ok(!keys(await rows(db, FOR_SQL, [KEY_A])).includes('eta_text'));
    const beforeA = await definitionCount(db, KEY_A);
    const beforeB = await definitionCount(db, KEY_B);
    await refusal(db, DELETE_SQL, [ADMIN_A, KEY_A, 'eta_text'], 'not_found');
    await refusal(db, DELETE_SQL, [ADMIN_A, KEY_A, 'gamma_text'], 'not_found');
    await refusal(db, DELETE_SQL, [ADMIN_B, KEY_B, 'alpha_code'], 'not_found');
    assert.equal(await definitionCount(db, KEY_A), beforeA);
    assert.equal(await definitionCount(db, KEY_B), beforeB);
  });

  test('the placeholder guard keeps a key that the stored header template names', async () => {
    await upsert(db, ADMIN_B, KEY_B, 'alpha_code', 'code', { inHeader: true });
    await upsert(db, ADMIN_A, KEY_A, 'theta_text', 'text', { inHeader: true });
    await seedTemplate(db, KEY_A, 'Head {alpha_code} / {beta_list}');
    await refusal(db, DELETE_SQL, [ADMIN_A, KEY_A, 'alpha_code'], 'unknown_placeholder');
    await refusal(db, UPSERT_SQL, upsertParams(ADMIN_A, KEY_A, 'alpha_code', 'code', { inHeader: false }), 'unknown_placeholder');
    const kept = (await rows(db, FOR_SQL, [KEY_A])).find((row) => row.key === 'alpha_code') as Row;
    assert.equal(kept.in_header, true);
    const flagged = await upsert(db, ADMIN_A, KEY_A, 'alpha_code', 'code', { inHeader: true, filterable: true });
    assert.equal(flagged.filterable, true);
    const unnamed = await upsert(db, ADMIN_A, KEY_A, 'theta_text', 'text', { inHeader: false });
    assert.equal(unnamed.in_header, false);
    assert.deepEqual(await rows(db, DELETE_SQL, [ADMIN_A, KEY_A, 'theta_text']), [{ key: 'theta_text' }]);
    const other = await upsert(db, ADMIN_B, KEY_B, 'alpha_code', 'code', { inHeader: false });
    assert.equal(other.in_header, false);
    assert.deepEqual(await rows(db, DELETE_SQL, [ADMIN_B, KEY_B, 'alpha_code']), [{ key: 'alpha_code' }]);
    assert.ok(keys(await rows(db, FOR_SQL, [KEY_A])).includes('alpha_code'));
  });

  test('at most 30 definitions per tenant; the 31st is limit_reached and the other tenant is not counted', async () => {
    const existing = await definitionCount(db, KEY_A);
    for (let index = existing; index < 30; index += 1) await upsert(db, ADMIN_A, KEY_A, `fill_${index}`, 'text');
    assert.equal(await definitionCount(db, KEY_A), 30);
    const snapshot = JSON.stringify(await rows(db, FOR_SQL, [KEY_A]));
    await refusal(db, UPSERT_SQL, upsertParams(ADMIN_A, KEY_A, 'one_more', 'text'), 'limit_reached');
    assert.equal(JSON.stringify(await rows(db, FOR_SQL, [KEY_A])), snapshot);
    const updated = await upsert(db, ADMIN_A, KEY_A, 'fill_29', 'text', { soft: true });
    assert.equal(updated.soft, true);
    const elsewhere = await upsert(db, ADMIN_B, KEY_B, 'one_more', 'text');
    assert.equal(elsewhere.key, 'one_more');
  });

  test('a tenant key of the wrong shape is rejected by the tenant assertion', async () => {
    for (const bad of ['s:default', 'o:not-a-uuid', '', `O:${ORG_A}`]) {
      assert.ok((await failure(db, FOR_SQL, [bad])) !== null, `for ${bad}`);
      assert.ok((await failure(db, LIST_SQL, [ADMIN_A, bad])) !== null, `list ${bad}`);
      assert.ok((await failure(db, UPSERT_SQL, upsertParams(ADMIN_A, bad, 'kappa_text', 'text'))) !== null, `upsert ${bad}`);
      assert.ok((await failure(db, DELETE_SQL, [ADMIN_A, bad, 'alpha_code'])) !== null, `delete ${bad}`);
    }
  });

  test('anon and an authenticated JWT cannot execute any function', async () => {
    const calls: [string, unknown[]][] = [
      [LIST_SQL, [ADMIN_A, KEY_A]],
      [FOR_SQL, [KEY_A]],
      [UPSERT_SQL, upsertParams(ADMIN_A, KEY_A, 'lambda_text', 'text')],
      [DELETE_SQL, [ADMIN_A, KEY_A, 'alpha_code']],
    ];
    for (const role of ['anon', 'authenticated'] as const) {
      for (const [sql, params] of calls) {
        const failed = await asRole(db, role, () => failure(db, sql, params));
        assert.equal(failed?.code, '42501', `${role}: ${sql.slice(14, 60)}`);
      }
    }
  });
});

describe('attribute definitions (single-tenant)', () => {
  let db: PGlite;
  const ADMIN = '00000000-0000-4000-8000-000000100321';
  const USER = '00000000-0000-4000-8000-000000100322';

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [ADMIN, 'admin@example.invalid', USER, 'user@example.invalid']);
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
  });

  after(async () => {
    await db?.close();
  });

  test('off state: no definition row exists', async () => {
    assert.equal(await definitionCount(db), 0);
  });

  test('a deployment admin manages the s:default definitions; another user cannot', async () => {
    const created = await upsert(db, ADMIN, 's:default', 'alpha_code', 'code', { inIdentifierIndex: true });
    assert.equal(created.key, 'alpha_code');
    await refusal(db, UPSERT_SQL, upsertParams(USER, 's:default', 'beta_list', 'text_list'), 'not_admin');
    await refusal(db, DELETE_SQL, [USER, 's:default', 'alpha_code'], 'not_admin');
    assert.deepEqual(keys(await rows(db, LIST_SQL, [ADMIN, 's:default'])), ['alpha_code']);
    assert.deepEqual(await rows(db, LIST_SQL, [USER, 's:default']), []);
    assert.deepEqual(keys(await rows(db, FOR_SQL, ['s:default'])), ['alpha_code']);
    await seedTemplate(db, 's:default', '{alpha_code}');
    await refusal(db, DELETE_SQL, [ADMIN, 's:default', 'alpha_code'], 'unknown_placeholder');
    await rows(db, 'DELETE FROM public.rag_attribute_header_templates WHERE tenant_key = $1', ['s:default']);
    assert.deepEqual(await rows(db, DELETE_SQL, [ADMIN, 's:default', 'alpha_code']), [{ key: 'alpha_code' }]);
  });

  test('a u: and an o: key raise in single-tenant mode', async () => {
    for (const bad of [`u:${USER}`, `o:${ORG_A}`]) {
      assert.ok((await failure(db, FOR_SQL, [bad])) !== null, `for ${bad}`);
      assert.ok((await failure(db, UPSERT_SQL, upsertParams(ADMIN, bad, 'kappa_text', 'text'))) !== null, `upsert ${bad}`);
      assert.ok((await failure(db, LIST_SQL, [ADMIN, bad])) !== null, `list ${bad}`);
      assert.ok((await failure(db, DELETE_SQL, [ADMIN, bad, 'kappa_text'])) !== null, `delete ${bad}`);
    }
    assert.equal(await definitionCount(db), 0);
  });
});

describe('migration 1003 catalog and idempotence', () => {
  for (const mode of ['multi-tenant', 'single-tenant'] as const) {
    test(`${mode}: INVOKER, empty search_path, service_role only, and applying 1003 again leaves the schema unchanged`, async () => {
      const db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      try {
        for (const signature of FUNCTIONS) {
          const found = (
            await rows(
              db,
              `SELECT p.prosecdef AS definer, p.proconfig AS config,
                      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
                      EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public
               FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
              [`public.${signature}`],
            )
          )[0];
          assert.ok(found, `${signature} exists`);
          assert.equal(found.definer, false, `${signature} is INVOKER`);
          assert.ok(
            Array.isArray(found.config) && (found.config as string[]).some((entry) => entry === 'search_path=' || entry === 'search_path=""'),
            `${signature} search_path`,
          );
          assert.deepEqual([found.anon, found.authenticated, found.public, found.service_role], [false, false, false, true], signature);
        }
        const dump = async () =>
          JSON.stringify(
            (
              await rows(
                db,
                `SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'rag_attribute_%' ORDER BY 1`,
              )
            ).map((row) => [row.sig, row.def, row.acl]),
          );
        const first = await dump();
        await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
        assert.equal(await dump(), first);
        assert.equal(await definitionCount(db), 0);
      } finally {
        await db.close();
      }
    });
  }
});
