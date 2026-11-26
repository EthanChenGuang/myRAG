import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

// ---------------------------------------------------------------------------------------------------------------------------------------
// Values section (plan 03.3-11; D-22, D-23): migration 1005 writers, the chunk copy trigger and the document insert guard.
// ---------------------------------------------------------------------------------------------------------------------------------------

const VALUES_MIGRATION = 'supabase/migrations/1005_attribute_writers.sql';
const VALUE_FUNCTIONS = [
  'rag_attribute_values_check(text, jsonb)',
  'rag_apply_document_attributes(text, uuid, jsonb)',
  'rag_set_document_attributes(text, uuid, jsonb)',
  'rag_stage_document_attributes(text, jsonb)',
  'rag_staged_attributes_read(text, text, text[])',
  'rag_import_document_attributes(text, jsonb, boolean)',
  'rag_document_attributes_read(text, uuid[])',
];
const VALUES_PROFILE = 'attr-values-general-p256';
const LEGACY_EMBED_PROFILE = 'openai-3-small-1536';
const SOURCE = 'config_upload';

const CHECK_SQL = 'SELECT rag_attribute_values_check(p_tenant_key => $1, p_attributes => $2::jsonb) AS v';
const APPLY_SQL = 'SELECT * FROM rag_apply_document_attributes(p_tenant_key => $1, p_document_id => $2, p_explicit => $3::jsonb)';
const SET_SQL = 'SELECT * FROM rag_set_document_attributes(p_tenant_key => $1, p_document_id => $2, p_attributes => $3::jsonb)';
const STAGE_SQL = 'SELECT * FROM rag_stage_document_attributes(p_tenant_key => $1, p_rows => $2::jsonb)';
const STAGED_READ_SQL = 'SELECT * FROM rag_staged_attributes_read(p_tenant_key => $1, p_source => $2, p_source_keys => $3::text[])';
const IMPORT_SQL = 'SELECT * FROM rag_import_document_attributes(p_tenant_key => $1, p_rows => $2::jsonb, p_dry_run => $3)';
const DOC_READ_SQL = 'SELECT * FROM rag_document_attributes_read(p_tenant_key => $1, p_document_ids => $2::uuid[])';

interface ValueTenant {
  key: string;
  userId: string | null;
  orgId: string | null;
}

let valueSequence = 0;
const nextName = (label: string): string => `${label}-${++valueSequence}`;

async function defineKeys(db: PGlite, tenantKey: string): Promise<void> {
  await rows(
    db,
    `INSERT INTO public.rag_attribute_definitions (tenant_key, key, type) VALUES ($1, 'alpha_code', 'code'), ($1, 'beta_list', 'text_list'),
       ($1, 'gamma_text', 'text') ON CONFLICT (tenant_key, key) DO NOTHING`,
    [tenantKey],
  );
}

async function beginVersion(db: PGlite, tenant: ValueTenant, sourceKey: string): Promise<string> {
  const begun = (
    await rows(
      db,
      `SELECT outcome, document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, $4, $5, $6, $7, 'general', 'fallback', 'general-1', 1)`,
      [tenant.key, tenant.userId, tenant.orgId, SOURCE, sourceKey, `${sourceKey}.md`, crypto.createHash('sha256').update(nextName('sha')).digest('hex')],
    )
  )[0];
  assert.equal(begun?.outcome, 'created');
  return String(begun?.document_id);
}

async function writeTwoChunks(db: PGlite, tenant: ValueTenant, id: string, final = true): Promise<void> {
  const contents = [`${nextName('tok')} neutral probe sentence one`, `${nextName('tok')} neutral probe sentence two`];
  const chunks = contents.map((content, index) => ({ chunk_index: index, content, lexical_text: content, metadata: {} }));
  const vector = (seed: number) => Array.from({ length: 1536 }, (_, index) => (index === seed % 1536 ? 1 : 0));
  await rows(
    db,
    'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => $5, p_total => 2)',
    [id, tenant.key, JSON.stringify(chunks), JSON.stringify({ [LEGACY_EMBED_PROFILE]: [vector(1), vector(2)] }), final],
  );
}

async function publish(db: PGlite, tenant: ValueTenant, id: string): Promise<void> {
  await rows(db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [id, tenant.key]);
}

async function attributesOf(db: PGlite, id: string): Promise<{ document: unknown; chunks: unknown[] }> {
  const document = (await rows(db, 'SELECT attributes FROM documents WHERE id = $1', [id]))[0]?.attributes ?? null;
  const chunks = (await rows(db, 'SELECT attributes FROM document_chunks WHERE document_id = $1 ORDER BY chunking_profile_id NULLS FIRST, chunk_index', [id])).map(
    (row) => row.attributes,
  );
  return { document, chunks };
}

async function stagedCount(db: PGlite, tenantKey?: string): Promise<number> {
  const found = tenantKey
    ? await rows(db, 'SELECT count(*)::int AS n FROM public.rag_staged_attributes WHERE tenant_key = $1', [tenantKey])
    : await rows(db, 'SELECT count(*)::int AS n FROM public.rag_staged_attributes');
  return Number(found[0]?.n);
}

async function seedCacheFor(db: PGlite, tenantKey: string, documentId: string): Promise<void> {
  await rows(
    db,
    `INSERT INTO public.rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, is_refusal, expires_at)
     VALUES ($1, $2, 'p1', '[1,0,0,0]'::halfvec, 'masked placeholder', '{}'::jsonb, $3::jsonb, false, now() + interval '1 hour')`,
    [tenantKey, crypto.createHash('sha256').update(nextName('cache')).digest('hex'), JSON.stringify([{ document_id: documentId, version: 1 }])],
  );
}

async function cacheRows(db: PGlite, tenantKey: string): Promise<number> {
  return Number((await rows(db, 'SELECT count(*)::int AS n FROM public.rag_semantic_cache WHERE tenant_key = $1', [tenantKey]))[0]?.n);
}

async function valuesDatabase(mode: 'multi-tenant' | 'single-tenant'): Promise<{ db: PGlite; a: ValueTenant; b: ValueTenant | null }> {
  const db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
  await db.exec(`INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
    VALUES ('${VALUES_PROFILE}', 'general', 256, 'structure', 1024, 'building', '256/1024') ON CONFLICT DO NOTHING`);
  if (mode === 'single-tenant') {
    await defineKeys(db, 's:default');
    return { db, a: { key: 's:default', userId: null, orgId: null }, b: null };
  }
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [
    ADMIN_A,
    'values-a@example.invalid',
    ADMIN_B,
    'values-b@example.invalid',
  ]);
  await db.query(
    'INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false), ($5, $6, $7, $8, false) ON CONFLICT DO NOTHING',
    [ORG_A, 'Tenant A', 'tenant-a-1005', ADMIN_A, ORG_B, 'Tenant B', 'tenant-b-1005', ADMIN_B],
  );
  await db.query(
    "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner') ON CONFLICT DO NOTHING",
    [ORG_A, ADMIN_A, ORG_B, ADMIN_B],
  );
  await defineKeys(db, KEY_A);
  await defineKeys(db, KEY_B);
  return { db, a: { key: KEY_A, userId: ADMIN_A, orgId: ORG_A }, b: { key: KEY_B, userId: ADMIN_B, orgId: ORG_B } };
}

for (const mode of ['multi-tenant', 'single-tenant'] as const) {
  describe(`attribute values (${mode})`, () => {
    let db: PGlite;
    let a: ValueTenant;
    let b: ValueTenant | null;

    before(async () => {
      ({ db, a, b } = await valuesDatabase(mode));
    });

    after(async () => {
      await db?.close();
    });

    test('off state: a version written with the Phase 3 writers alone has NULL in every attribute column and nothing is staged', async () => {
      const id = await beginVersion(db, a, nextName('off'));
      await writeTwoChunks(db, a, id);
      await publish(db, a, id);
      const found = (await rows(db, 'SELECT attributes, attribute_header, attribute_header_stamp FROM documents WHERE id = $1', [id]))[0];
      assert.deepEqual(found, { attributes: null, attribute_header: null, attribute_header_stamp: null });
      assert.deepEqual((await attributesOf(db, id)).chunks, [null, null]);
      assert.equal(await stagedCount(db), 0);
    });

    test('the value check returns the canonical object and raises the four code words', async () => {
      const found = (await rows(db, CHECK_SQL, [a.key, JSON.stringify({ gamma_text: '  some words ', alpha_code: 'C-1', beta_list: [' one', 'two'] })]))[0];
      assert.deepEqual(found?.v, { alpha_code: 'C-1', beta_list: ['one', 'two'], gamma_text: 'some words' });
      assert.deepEqual((await rows(db, CHECK_SQL, [a.key, '{}']))[0]?.v, {});
      await refusal(db, CHECK_SQL, [a.key, JSON.stringify({ delta_text: 'x' })], 'unknown_attribute');
      await refusal(db, CHECK_SQL, [a.key, JSON.stringify({ alpha_code: ['x'] })], 'invalid_attribute_type');
      await refusal(db, CHECK_SQL, [a.key, JSON.stringify({ alpha_code: '   ' })], 'invalid_attribute_type');
      await refusal(db, CHECK_SQL, [a.key, JSON.stringify({ beta_list: 'x' })], 'invalid_attribute_type');
      await refusal(db, CHECK_SQL, [a.key, JSON.stringify({ beta_list: ['x', ' x'] })], 'invalid_attribute_type');
      await refusal(db, CHECK_SQL, [a.key, '[]'], 'invalid_attribute_type');
      await refusal(db, CHECK_SQL, [a.key, JSON.stringify({ beta_list: Array.from({ length: 51 }, (_, i) => `v${i}`) })], 'too_many_values');
      await refusal(db, CHECK_SQL, [a.key, JSON.stringify({ gamma_text: 'x'.repeat(201) })], 'value_too_long');
      assert.deepEqual((await rows(db, CHECK_SQL, [a.key, JSON.stringify({ gamma_text: 'é'.repeat(200) })]))[0]?.v, { gamma_text: 'é'.repeat(200) });
    });

    test('explicit values are applied before chunks; rag_write_chunks and rag_write_profile_chunks copy them onto every chunk', async () => {
      const id = await beginVersion(db, a, nextName('explicit'));
      const applied = (await rows(db, APPLY_SQL, [a.key, id, JSON.stringify({ alpha_code: ' K-7 ', beta_list: ['b1'] })]))[0];
      assert.deepEqual({ origin: applied?.origin, key_count: applied?.key_count, chunks_updated: applied?.chunks_updated }, { origin: 'explicit', key_count: 2, chunks_updated: 0 });
      await writeTwoChunks(db, a, id, false);
      await rows(
        db,
        `SELECT * FROM rag_write_profile_chunks(p_document_id => $1, p_tenant_key => $2, p_profile_id => $3, p_parents => $4::jsonb,
           p_children => $5::jsonb, p_embeddings => NULL, p_final => true, p_total => 1)`,
        [id, a.key, VALUES_PROFILE, JSON.stringify([{ parent_index: 0, content: 'profile parent neutral', token_count: 4 }]),
          JSON.stringify([{ chunk_index: 0, content: 'profile child neutral', parent_index: 0 }])],
      );
      const expected = { alpha_code: 'K-7', beta_list: ['b1'] };
      const found = await attributesOf(db, id);
      assert.deepEqual(found.document, expected);
      assert.ok(found.chunks.length >= 3, `chunks ${found.chunks.length}`);
      for (const chunk of found.chunks) assert.deepEqual(chunk, expected);
    });

    test('a chunk inserted with its own attributes still carries its document value; a document without attributes gives NULL', async () => {
      const id = await beginVersion(db, a, nextName('forced'));
      await rows(
        db,
        `INSERT INTO document_chunks (id, document_id, chunk_index, content, metadata, attributes) VALUES (gen_random_uuid(), $1, 0, 'neutral forced chunk', '{}'::jsonb, '{"alpha_code":"forged"}'::jsonb)`,
        [id],
      );
      assert.deepEqual((await attributesOf(db, id)).chunks, [null]);
    });

    test('explicit values on chunks that already exist are written to them too, and an empty explicit object wins', async () => {
      const id = await beginVersion(db, a, nextName('late'));
      await writeTwoChunks(db, a, id, false);
      const applied = (await rows(db, APPLY_SQL, [a.key, id, JSON.stringify({ gamma_text: 'late words' })]))[0];
      assert.equal(applied?.chunks_updated, 2);
      assert.deepEqual(await attributesOf(db, id), { document: { gamma_text: 'late words' }, chunks: [{ gamma_text: 'late words' }, { gamma_text: 'late words' }] });
      const emptied = (await rows(db, APPLY_SQL, [a.key, id, '{}']))[0];
      assert.equal(emptied?.origin, 'explicit');
      assert.deepEqual(await attributesOf(db, id), { document: {}, chunks: [{}, {}] });
    });

    test('a staged row is used and consumed by the first version of its key; a second apply keeps the value (resume)', async () => {
      const sourceKey = nextName('staged');
      const staged = (await rows(db, STAGE_SQL, [a.key, JSON.stringify([{ source: SOURCE, source_key: sourceKey, attributes: { alpha_code: 'S-1' } }])]))[0];
      assert.deepEqual(staged, { staged: 1, unchanged: 0 });
      const id = await beginVersion(db, a, sourceKey);
      assert.equal((await rows(db, APPLY_SQL, [a.key, id, null]))[0]?.origin, 'staged');
      assert.equal((await rows(db, STAGED_READ_SQL, [a.key, SOURCE, [sourceKey]])).length, 0);
      assert.equal((await rows(db, APPLY_SQL, [a.key, id, null]))[0]?.origin, 'none');
      await writeTwoChunks(db, a, id);
      assert.deepEqual(await attributesOf(db, id), { document: { alpha_code: 'S-1' }, chunks: [{ alpha_code: 'S-1' }, { alpha_code: 'S-1' }] });
    });

    test("a new version inherits the lineage's current value only while its own value is NULL", async () => {
      const sourceKey = nextName('inherit');
      const first = await beginVersion(db, a, sourceKey);
      await rows(db, APPLY_SQL, [a.key, first, JSON.stringify({ gamma_text: 'first words' })]);
      await writeTwoChunks(db, a, first);
      await publish(db, a, first);
      const second = await beginVersion(db, a, sourceKey);
      assert.notEqual(second, first);
      const applied = (await rows(db, APPLY_SQL, [a.key, second, null]))[0];
      assert.equal(applied?.origin, 'inherited');
      await writeTwoChunks(db, a, second);
      assert.deepEqual((await attributesOf(db, second)).chunks, [{ gamma_text: 'first words' }, { gamma_text: 'first words' }]);
      const plain = await beginVersion(db, a, nextName('plain'));
      assert.deepEqual((await rows(db, APPLY_SQL, [a.key, plain, null]))[0]?.origin, 'none');
      assert.equal((await attributesOf(db, plain)).document, null);
    });

    test('apply refuses a published version and invalid values, and stores nothing', async () => {
      const id = await beginVersion(db, a, nextName('published'));
      await writeTwoChunks(db, a, id);
      await publish(db, a, id);
      await refusal(db, APPLY_SQL, [a.key, id, JSON.stringify({ alpha_code: 'P-1' })], 'not_found');
      const fresh = await beginVersion(db, a, nextName('bad'));
      await refusal(db, APPLY_SQL, [a.key, fresh, JSON.stringify({ delta_text: 'x' })], 'unknown_attribute');
      assert.equal((await attributesOf(db, fresh)).document, null);
      assert.equal((await attributesOf(db, id)).document, null);
    });

    test('the setter changes a document and every chunk and drops its cached answers; an equal value writes nothing', async () => {
      const id = await beginVersion(db, a, nextName('setter'));
      await writeTwoChunks(db, a, id);
      await publish(db, a, id);
      await seedCacheFor(db, a.key, id);
      const before = await cacheRows(db, a.key);
      const set = (await rows(db, SET_SQL, [a.key, id, JSON.stringify({ beta_list: ['x1', 'x2'] })]))[0];
      assert.deepEqual({ changed: set?.changed, chunks_updated: set?.chunks_updated }, { changed: true, chunks_updated: 2 });
      assert.deepEqual((await attributesOf(db, id)).chunks, [{ beta_list: ['x1', 'x2'] }, { beta_list: ['x1', 'x2'] }]);
      assert.equal(await cacheRows(db, a.key), before - 1);
      await seedCacheFor(db, a.key, id);
      const again = (await rows(db, SET_SQL, [a.key, id, JSON.stringify({ beta_list: [' x1', 'x2'] })]))[0];
      assert.deepEqual({ changed: again?.changed, chunks_updated: again?.chunks_updated }, { changed: false, chunks_updated: 0 });
      assert.equal(await cacheRows(db, a.key), before);
      await rows(db, "UPDATE documents SET status = 'deleted', is_current = false WHERE id = $1", [id]);
      await refusal(db, SET_SQL, [a.key, id, JSON.stringify({ alpha_code: 'D-1' })], 'not_found');
    });

    test('staging upserts by source key and reads return only the caller tenant rows; more than 500 rows is 22023', async () => {
      const keys = [nextName('stage'), nextName('stage')];
      const payload = keys.map((sourceKey) => ({ source: SOURCE, source_key: sourceKey, attributes: { alpha_code: 'A-1' } }));
      assert.deepEqual((await rows(db, STAGE_SQL, [a.key, JSON.stringify(payload)]))[0], { staged: 2, unchanged: 0 });
      assert.deepEqual((await rows(db, STAGE_SQL, [a.key, JSON.stringify(payload)]))[0], { staged: 0, unchanged: 2 });
      payload[0] = { ...payload[0]!, attributes: { alpha_code: 'A-2' } };
      assert.deepEqual((await rows(db, STAGE_SQL, [a.key, JSON.stringify(payload)]))[0], { staged: 1, unchanged: 1 });
      const read = await rows(db, STAGED_READ_SQL, [a.key, SOURCE, keys]);
      assert.deepEqual(read.map((row) => [row.source_key, row.attributes]), [[keys[0], { alpha_code: 'A-2' }], [keys[1], { alpha_code: 'A-1' }]]);
      await refusal(db, STAGE_SQL, [a.key, JSON.stringify([{ source: SOURCE, source_key: nextName('k'), attributes: { delta_text: 'x' } }])], 'unknown_attribute');
      const many = Array.from({ length: 501 }, (_, i) => ({ source: SOURCE, source_key: `bulk-${i}`, attributes: {} }));
      await malformed(db, STAGE_SQL, [a.key, JSON.stringify(many)]);
      await malformed(db, STAGED_READ_SQL, [a.key, SOURCE, Array.from({ length: 501 }, (_, i) => `k${i}`)]);
      await malformed(db, DOC_READ_SQL, [a.key, Array.from({ length: 501 }, () => ADMIN_A)]);
      await malformed(db, IMPORT_SQL, [a.key, JSON.stringify(many), false]);
      await rows(db, 'DELETE FROM public.rag_staged_attributes WHERE tenant_key = $1', [a.key]);
    });

    test('import sets current and processing versions, stages unknown keys, dry run writes nothing, a repeat is unchanged', async () => {
      const known = nextName('import');
      const current = await beginVersion(db, a, known);
      await writeTwoChunks(db, a, current);
      await publish(db, a, current);
      const pending = await beginVersion(db, a, known);
      const unknown = nextName('import-unknown');
      const payload = JSON.stringify([
        { source: SOURCE, source_key: known, attributes: { alpha_code: 'I-1' } },
        { source: SOURCE, source_key: unknown, attributes: { gamma_text: 'later words' } },
      ]);
      await seedCacheFor(db, a.key, current);
      const cacheBefore = await cacheRows(db, a.key);
      const dry = (await rows(db, IMPORT_SQL, [a.key, payload, true]))[0];
      assert.equal(dry?.documents_changed, 2);
      assert.equal(dry?.chunks_updated, 2);
      assert.equal(dry?.staged, 1);
      assert.equal((await attributesOf(db, current)).document, null);
      assert.equal(await stagedCount(db, a.key), 0);
      assert.equal(await cacheRows(db, a.key), cacheBefore);
      const real = (await rows(db, IMPORT_SQL, [a.key, payload, false]))[0];
      assert.deepEqual(
        { ...real, changed_document_ids: [...((real?.changed_document_ids as string[]) ?? [])].sort() },
        { ...dry, changed_document_ids: [...((dry?.changed_document_ids as string[]) ?? [])].sort() },
      );
      assert.deepEqual(new Set(real?.changed_document_ids as string[]), new Set([current, pending]));
      assert.equal(real?.outbox_rows, 0);
      assert.deepEqual((await attributesOf(db, current)).chunks, [{ alpha_code: 'I-1' }, { alpha_code: 'I-1' }]);
      assert.deepEqual((await attributesOf(db, pending)).document, { alpha_code: 'I-1' });
      assert.equal(await cacheRows(db, a.key), cacheBefore - 1);
      assert.equal((await rows(db, STAGED_READ_SQL, [a.key, SOURCE, [unknown]])).length, 1);
      const repeat = (await rows(db, IMPORT_SQL, [a.key, payload, false]))[0];
      assert.deepEqual(
        [repeat?.documents_changed, repeat?.documents_unchanged, repeat?.chunks_updated, repeat?.staged, repeat?.staged_unchanged],
        [0, 2, 0, 0, 1],
      );
      const read = await rows(db, DOC_READ_SQL, [a.key, [current, pending]]);
      assert.equal(read.length, 2);
      await rows(db, 'DELETE FROM public.rag_staged_attributes WHERE tenant_key = $1', [a.key]);
    });

    test('import counts the vector_sync_outbox rows it adds while a sync target is enabled', async () => {
      const known = nextName('outbox');
      const id = await beginVersion(db, a, known);
      await writeTwoChunks(db, a, id);
      await publish(db, a, id);
      await rows(db, "UPDATE public.rag_vector_sync_targets SET enabled = true WHERE target = 'qdrant'");
      try {
        const before = Number((await rows(db, 'SELECT count(*)::int AS n FROM vector_sync_outbox WHERE tenant_key = $1', [a.key]))[0]?.n);
        const real = (await rows(db, IMPORT_SQL, [a.key, JSON.stringify([{ source: SOURCE, source_key: known, attributes: { alpha_code: 'O-1' } }]), false]))[0];
        const after = Number((await rows(db, 'SELECT count(*)::int AS n FROM vector_sync_outbox WHERE tenant_key = $1', [a.key]))[0]?.n);
        assert.equal(real?.outbox_rows, after - before);
      } finally {
        await rows(db, 'UPDATE public.rag_vector_sync_targets SET enabled = false');
      }
    });

    test('anon and authenticated cannot execute any function; a tenant key of the other mode is rejected', async () => {
      const id = await beginVersion(db, a, nextName('roles'));
      for (const role of ['anon', 'authenticated'] as const) {
        const refused = await asRole(db, role, () => failure(db, APPLY_SQL, [a.key, id, '{}']));
        assert.equal(refused?.code, '42501', role);
        const refusedRead = await asRole(db, role, () => failure(db, DOC_READ_SQL, [a.key, [id]]));
        assert.equal(refusedRead?.code, '42501', role);
      }
      const otherMode = mode === 'multi-tenant' ? ['s:default'] : [`o:${ORG_A}`, `u:${ADMIN_A}`];
      for (const bad of otherMode) {
        assert.ok((await failure(db, APPLY_SQL, [bad, id, '{}'])) !== null, bad);
        assert.ok((await failure(db, SET_SQL, [bad, id, '{}'])) !== null, bad);
        assert.ok((await failure(db, STAGE_SQL, [bad, '[]'])) !== null, bad);
        assert.ok((await failure(db, IMPORT_SQL, [bad, '[]', true])) !== null, bad);
        assert.ok((await failure(db, DOC_READ_SQL, [bad, [id]])) !== null, bad);
        assert.ok((await failure(db, STAGED_READ_SQL, [bad, SOURCE, ['k']])) !== null, bad);
        assert.ok((await failure(db, CHECK_SQL, [bad, '{}'])) !== null, bad);
      }
      assert.equal((await attributesOf(db, id)).document, null);
    });

    if (mode === 'multi-tenant') {
      test('tenant B reaches none of A: apply, set, stage, import and both reads', async () => {
        const other = b as ValueTenant;
        const idA = await beginVersion(db, a, nextName('iso'));
        await rows(db, APPLY_SQL, [a.key, idA, JSON.stringify({ alpha_code: 'A-ONLY' })]);
        await writeTwoChunks(db, a, idA);
        await publish(db, a, idA);
        const pendingA = await beginVersion(db, a, nextName('iso-pending'));
        await refusal(db, APPLY_SQL, [other.key, pendingA, '{}'], 'not_found');
        await refusal(db, SET_SQL, [other.key, idA, JSON.stringify({ alpha_code: 'B-1' })], 'not_found');
        assert.deepEqual(await rows(db, DOC_READ_SQL, [other.key, [idA, pendingA]]), []);
        const sourceKey = nextName('iso-stage');
        await rows(db, STAGE_SQL, [a.key, JSON.stringify([{ source: SOURCE, source_key: sourceKey, attributes: { alpha_code: 'A-ST' } }])]);
        assert.deepEqual(await rows(db, STAGED_READ_SQL, [other.key, SOURCE, [sourceKey]]), []);
        const idB = await beginVersion(db, other, sourceKey);
        assert.equal((await rows(db, APPLY_SQL, [other.key, idB, null]))[0]?.origin, 'none');
        assert.equal(await stagedCount(db, a.key), 1);
        const aSourceKey = String((await rows(db, 'SELECT source_key FROM documents WHERE id = $1', [idA]))[0]?.source_key);
        const imported = (await rows(db, IMPORT_SQL, [other.key, JSON.stringify([{ source: SOURCE, source_key: aSourceKey, attributes: { alpha_code: 'B-2' } }]), false]))[0];
        assert.equal(imported?.documents_changed, 0);
        assert.equal(imported?.staged, 1);
        assert.deepEqual((await attributesOf(db, idA)).chunks, [{ alpha_code: 'A-ONLY' }, { alpha_code: 'A-ONLY' }]);
        await rows(db, 'DELETE FROM public.rag_attribute_definitions WHERE tenant_key = $1 AND key = $2', [other.key, 'gamma_text']);
        await refusal(db, CHECK_SQL, [other.key, JSON.stringify({ gamma_text: 'x' })], 'unknown_attribute');
        assert.deepEqual((await rows(db, CHECK_SQL, [a.key, JSON.stringify({ gamma_text: 'x' })]))[0]?.v, { gamma_text: 'x' });
        await rows(db, 'DELETE FROM public.rag_staged_attributes');
      });

      test('a signed-in client cannot write the attribute columns through the tables', async () => {
        const personal: ValueTenant = { key: `u:${ADMIN_A}`, userId: ADMIN_A, orgId: null };
        const id = await beginVersion(db, personal, nextName('direct'));
        await writeTwoChunks(db, personal, id);
        await publish(db, personal, id);
        const asMember = async <T,>(run: () => Promise<T>): Promise<T> => {
          await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [ADMIN_A]);
          await db.exec('SET ROLE authenticated');
          try {
            return await run();
          } finally {
            await db.exec('RESET ROLE');
          }
        };
        const visible = await asMember(() => rows(db, 'SELECT count(*)::int AS n FROM documents WHERE id = $1', [id]));
        assert.equal(visible[0]?.n, 1, 'the member can see the document, so a refusal comes from the guard');
        const updateDoc = await asMember(() => failure(db, `UPDATE documents SET attributes = '{"alpha_code":"X"}'::jsonb WHERE id = $1`, [id]));
        const updateChunk = await asMember(() =>
          failure(db, `UPDATE document_chunks SET attributes = '{"alpha_code":"X"}'::jsonb WHERE document_id = $1`, [id]),
        );
        assert.equal(updateDoc?.code, '42501', 'document update');
        // No update policy on chunks: the statement either raises 42501 or touches no row.
        assert.ok(updateChunk === null || updateChunk.code === '42501', updateChunk?.message);
        assert.deepEqual((await attributesOf(db, id)).chunks, [null, null]);
        assert.equal((await attributesOf(db, id)).document, null);
        const own = crypto.randomUUID();
        await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [ADMIN_A]);
        await db.exec('SET ROLE authenticated');
        try {
          await db.query(
            `INSERT INTO documents (id, filename, content, metadata, user_id, attributes, attribute_header, attribute_header_stamp)
             VALUES ($1, 'direct.md', 'neutral', '{}'::jsonb, $2, '{"alpha_code":"X"}'::jsonb, 'forged header', 'forged-stamp')`,
            [own, ADMIN_A],
          );
        } finally {
          await db.exec('RESET ROLE');
        }
        const stored = (await rows(db, 'SELECT attributes, attribute_header, attribute_header_stamp FROM documents WHERE id = $1', [own]))[0];
        assert.deepEqual(stored, { attributes: null, attribute_header: null, attribute_header_stamp: null });
        const serviceDoc = crypto.randomUUID();
        await db.exec('SET ROLE service_role');
        try {
          await db.query(
            `INSERT INTO documents (id, filename, content, metadata, user_id, attributes) VALUES ($1, 'svc.md', 'neutral', '{}'::jsonb, $2, '{"alpha_code":"S"}'::jsonb)`,
            [serviceDoc, ADMIN_A],
          );
        } finally {
          await db.exec('RESET ROLE');
        }
        assert.deepEqual((await attributesOf(db, serviceDoc)).document, { alpha_code: 'S' });
      });
    }
  });
}

describe('migration 1005 catalog and idempotence', () => {
  for (const mode of ['multi-tenant', 'single-tenant'] as const) {
    test(`${mode}: INVOKER, empty search_path, service_role only, triggers in place, and applying 1005 again leaves the schema unchanged`, async () => {
      const db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      try {
        for (const signature of VALUE_FUNCTIONS) {
          const found = (
            await rows(
              db,
              `SELECT p.prosecdef AS definer, p.proconfig AS config,
                      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
               FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
              [`public.${signature}`],
            )
          )[0];
          assert.ok(found, `${signature} exists`);
          assert.equal(found.definer, false, `${signature} is INVOKER`);
          assert.ok((found.config as string[]).some((entry) => /^search_path=("")?$/.test(entry)), `${signature} search_path`);
          assert.deepEqual([found.anon, found.authenticated, found.service_role], [false, false, true], signature);
        }
        const triggers = await rows(
          db,
          `SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           WHERE t.tgname IN ('rag_chunks_x_document_attributes', 'rag_documents_x_attribute_insert_guard') ORDER BY 1`,
        );
        assert.deepEqual(triggers.map((row) => [row.tgname, row.relname]), [
          ['rag_chunks_x_document_attributes', 'document_chunks'],
          ['rag_documents_x_attribute_insert_guard', 'documents'],
        ]);
        const dump = async () =>
          JSON.stringify(
            await rows(
              db,
              `SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p
               WHERE p.pronamespace = 'public'::regnamespace
                 AND (p.proname LIKE 'rag_%attribute%' OR p.proname IN ('rag_chunks_x_document_attributes')) ORDER BY 1`,
            ),
          );
        const first = await dump();
        await db.exec(fs.readFileSync(path.join(REPO_ROOT, VALUES_MIGRATION), 'utf8'));
        assert.equal(await dump(), first);
        assert.equal(await stagedCount(db), 0);
      } finally {
        await db.close();
      }
    });
  }
});
