import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * TPL-08 (D-02, D-22, D-23, D-29, D-37; plan 03.3-24): no Phase 3.3 store or path crosses tenants, in both deployment modes. The parent
 * process covers the SQL surface of migrations 1001 to 1009 (catalog, key-mode refusal, writers, staging and inheritance, resolver). One
 * child process per mode (the app reads the deployment mode once at import) covers the loader caches, the ingest services and the
 * attribute_resolve stage through the eval route; it prints one JSON report that holds ids and counts only. Test data is invented and
 * neutral: keys like alpha_code, two tenants a and b; value strings are only ever compared, never printed.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = fileURLToPath(import.meta.url);
const CHILD = process.env.PHASE33_MATRIX_CHILD;
/** The child process registers no test; it only prints its report. */
const suite = CHILD ? describe.skip : describe;
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const PHASE33_TABLES = [
  'rag_section_rule_sets',
  'rag_boilerplate_rules',
  'rag_attribute_definitions',
  'rag_attribute_header_templates',
  'rag_staged_attributes',
];
const MIGRATION_STEMS = ['1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009'];

const ORG_A = '00000000-0000-4000-8000-000000102401';
const ORG_B = '00000000-0000-4000-8000-000000102402';
const ADMIN_A = '00000000-0000-4000-8000-000000102411';
const ADMIN_B = '00000000-0000-4000-8000-000000102412';
const USER_B = '00000000-0000-4000-8000-000000102421';
const SOURCE = 'config_upload';
const LEGACY_EMBED_PROFILE = 'openai-3-small-1536';

/** Invented values with a fixed structure: tenant letter, a key letter and four digits. */
const VALUE_A = 'qa-k-4170';
const VALUE_A2 = 'qa-k-4171';
const VALUE_B = 'qb-k-9230';
const SOFT_A = 'qa-s-5512';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string | null;
  orgId: string | null;
}

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

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<{ message: string; code: string | null } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { message: messageOf(error), code: typeof code === 'string' ? code : null };
  }
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

/** Every function name a Phase 3.3 migration (1002 to 1009) creates, parsed from the files. */
function phase33FunctionNames(): string[] {
  const dir = path.join(REPO_ROOT, 'supabase/migrations');
  const names = new Set<string>();
  for (const file of fs.readdirSync(dir)) {
    if (!MIGRATION_STEMS.includes(file.slice(0, 4))) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.([a-z0-9_]+)\s*\(/g)) names.add(match[1]!);
  }
  return [...names].sort();
}

let sequence = 0;
const nextName = (label: string): string => `${label}-${++sequence}`;

async function defineKeys(db: PGlite, tenantKey: string): Promise<void> {
  await rows(
    db,
    `INSERT INTO public.rag_attribute_definitions (tenant_key, key, type, filterable, soft, in_header) VALUES
       ($1, 'alpha_code', 'code', true, false, true), ($1, 'beta_list', 'text_list', true, false, false), ($1, 'delta_text', 'text', true, true, false)
     ON CONFLICT (tenant_key, key) DO NOTHING`,
    [tenantKey],
  );
}

async function beginVersion(db: PGlite, tenant: Tenant, sourceKey: string): Promise<string> {
  const begun = (
    await rows(
      db,
      `SELECT outcome, document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, $4, $5, $6, $7, 'general', 'fallback', 'general-1', 1)`,
      [tenant.key, tenant.userId, tenant.orgId, SOURCE, sourceKey, `${sourceKey}.md`, crypto.createHash('sha256').update(nextName('sha')).digest('hex')],
    )
  )[0];
  assert.ok(begun?.document_id, `begin outcome ${String(begun?.outcome)}`);
  return String(begun.document_id);
}

async function writeChunk(db: PGlite, tenant: Tenant, id: string): Promise<void> {
  const content = `${nextName('tok')} neutral probe sentence`;
  const vector = Array.from({ length: 1536 }, (_, index) => (index === 1 ? 1 : 0));
  await rows(
    db,
    'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => 1)',
    [id, tenant.key, JSON.stringify([{ chunk_index: 0, content, lexical_text: content, metadata: {} }]), JSON.stringify({ [LEGACY_EMBED_PROFILE]: [vector] })],
  );
}

async function publish(db: PGlite, tenant: Tenant, id: string): Promise<void> {
  await rows(db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [id, tenant.key]);
}

async function apply(db: PGlite, tenant: Tenant, id: string, explicit: Row | null): Promise<Row> {
  return (
    await rows(db, 'SELECT * FROM rag_apply_document_attributes(p_tenant_key => $1, p_document_id => $2, p_explicit => $3::jsonb)', [
      tenant.key,
      id,
      explicit === null ? null : JSON.stringify(explicit),
    ])
  )[0] as Row;
}

async function stage(db: PGlite, tenantKey: string, sourceKey: string, attributes: Row): Promise<void> {
  await rows(db, 'SELECT * FROM rag_stage_document_attributes(p_tenant_key => $1, p_rows => $2::jsonb)', [
    tenantKey,
    JSON.stringify([{ source: SOURCE, source_key: sourceKey, attributes }]),
  ]);
}

async function attributesOf(db: PGlite, id: string): Promise<{ document: unknown; chunks: unknown[] }> {
  const document = (await rows(db, 'SELECT attributes FROM public.documents WHERE id = $1', [id]))[0]?.attributes ?? null;
  const chunks = (await rows(db, 'SELECT attributes FROM public.document_chunks WHERE document_id = $1 ORDER BY chunk_index', [id])).map((row) => row.attributes);
  return { document, chunks };
}

async function database(mode: DeploymentMode): Promise<{ db: PGlite; a: Tenant; b: Tenant | null }> {
  const db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
  if (mode === 'single-tenant') {
    await defineKeys(db, 's:default');
    return { db, a: { key: 's:default', userId: null, orgId: null }, b: null };
  }
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [
    ADMIN_A,
    'matrix-a@example.invalid',
    ADMIN_B,
    'matrix-b@example.invalid',
  ]);
  await db.query(
    'INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false), ($5, $6, $7, $8, false) ON CONFLICT DO NOTHING',
    [ORG_A, 'Tenant A', 'tenant-a-1024', ADMIN_A, ORG_B, 'Tenant B', 'tenant-b-1024', ADMIN_B],
  );
  await db.query(
    "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner') ON CONFLICT DO NOTHING",
    [ORG_A, ADMIN_A, ORG_B, ADMIN_B],
  );
  await defineKeys(db, `o:${ORG_A}`);
  await defineKeys(db, `o:${ORG_B}`);
  return { db, a: { key: `o:${ORG_A}`, userId: ADMIN_A, orgId: ORG_A }, b: { key: `o:${ORG_B}`, userId: ADMIN_B, orgId: ORG_B } };
}

interface FunctionInfo {
  name: string;
  signature: string;
  args: { name: string; type: string }[];
  returnsTrigger: boolean;
}

async function functionsOf(db: PGlite, names: string[]): Promise<FunctionInfo[]> {
  const found = await rows(
    db,
    `SELECT p.proname AS name, p.oid::regprocedure::text AS signature, p.prorettype = 'trigger'::regtype AS returns_trigger,
       COALESCE(p.proargnames, '{}'::text[]) AS arg_names, p.proargtypes::regtype[]::text[] AS arg_types, p.pronargs AS nargs, p.proargmodes AS modes
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY ($1::text[]) ORDER BY 2`,
    [names],
  );
  return found.map((row) => {
    const argNames = (row.arg_names as string[]).slice(0, Number(row.nargs));
    const argTypes = row.arg_types as string[];
    return {
      name: String(row.name),
      signature: String(row.signature),
      args: argNames.map((name, index) => ({ name, type: argTypes[index]! })),
      returnsTrigger: row.returns_trigger === true,
    };
  });
}

function tenantCall(fn: FunctionInfo): string {
  const parts = fn.args.map((arg) => (arg.name === 'p_tenant_key' ? 'p_tenant_key => $1' : `${arg.name} => NULL::${arg.type}`));
  return `SELECT * FROM public.${fn.name}(${parts.join(', ')})`;
}

const foreignModeKeys = (mode: DeploymentMode): string[] => (mode === 'multi-tenant' ? ['s:default'] : [`u:${ADMIN_A}`, `o:${ORG_A}`]);

for (const mode of MODES) {
  suite(`Phase 3.3 catalog and key mode (${mode})`, () => {
    let db: PGlite;
    let functions: FunctionInfo[];
    const names = phase33FunctionNames();

    before(async () => {
      ({ db } = await database(mode));
      functions = await functionsOf(db, names);
    });

    after(async () => {
      await db?.close();
    });

    test('every function name of migrations 1002 to 1009 exists exactly once', () => {
      assert.ok(names.length >= 30, `parsed ${names.length} names`);
      assert.ok(names.includes('rag_purge_hook_doc_attributes') && names.includes('rag_tenant_rule_data_delete'));
      assert.ok(names.includes('rag_attribute_identifier_documents'), '1007 branch: the identifier feed joins the matrix');
      assert.deepEqual(functions.map((fn) => fn.name).sort(), names, 'one function per name');
    });

    test('every function has an empty search_path and only service_role can execute it', async () => {
      for (const fn of functions) {
        const found = (
          await rows(
            db,
            `SELECT p.proconfig AS config,
               has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
               has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
               EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee = 0) AS public_exec
             FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
            [`public.${fn.signature}`],
          )
        )[0]!;
        assert.ok(Array.isArray(found.config) && (found.config as string[]).some((entry) => /^search_path=("")?$/.test(entry)), `${fn.name} search_path`);
        const expected = fn.returnsTrigger ? { anon: false, authed: false, public_exec: false } : { anon: false, authed: false, public_exec: false, service: true };
        const actual = fn.returnsTrigger
          ? { anon: found.anon, authed: found.authed, public_exec: found.public_exec }
          : { anon: found.anon, authed: found.authed, public_exec: found.public_exec, service: found.service };
        assert.deepEqual(actual, expected, fn.name);
      }
    });

    test('each function taking a tenant key rejects every key of the other deployment mode', async () => {
      const keyed = functions.filter((fn) => !fn.returnsTrigger && fn.args.some((arg) => arg.name === 'p_tenant_key'));
      assert.ok(keyed.length >= 25, `${keyed.length} keyed functions`);
      for (const fn of keyed) {
        for (const key of foreignModeKeys(mode)) {
          const failed = await failure(db, tenantCall(fn), [key]);
          assert.ok(failed !== null, `${fn.name} accepted a ${key.slice(0, 2)} key`);
          assert.equal(failed.code, '22023', `${fn.name}: ${failed.message.slice(0, 60)}`);
          assert.match(failed.message, /tenant key/, fn.name);
        }
      }
    });

    test('anon and authenticated cannot execute a keyed function (42501)', async () => {
      const keyed = functions.filter((fn) => !fn.returnsTrigger && fn.args.some((arg) => arg.name === 'p_tenant_key'));
      const key = mode === 'multi-tenant' ? `o:${ORG_A}` : 's:default';
      for (const role of ['anon', 'authenticated'] as const) {
        for (const fn of keyed) {
          const failed = await asRole(db, role, () => failure(db, tenantCall(fn), [key]));
          assert.equal(failed?.code, '42501', `${role} ${fn.name}`);
        }
      }
    });

    test('the five tables have row security on, no policy, and refuse anon and authenticated select and insert (42501)', async () => {
      for (const table of PHASE33_TABLES) {
        const state = (
          await rows(
            db,
            `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
             FROM pg_class c WHERE c.oid = to_regclass($1)`,
            [`public.${table}`],
          )
        )[0];
        assert.deepEqual(state, { rls: true, policies: 0 }, table);
        for (const role of ['anon', 'authenticated'] as const) {
          assert.equal((await asRole(db, role, () => failure(db, `SELECT * FROM public.${table} LIMIT 1`)))?.code, '42501', `${role} select ${table}`);
          assert.equal(
            (await asRole(db, role, () => failure(db, `INSERT INTO public.${table} (tenant_key) VALUES ('s:default')`)))?.code,
            '42501',
            `${role} insert ${table}`,
          );
        }
      }
    });
  });
}

const SET_UPSERT = 'SELECT * FROM rag_section_rule_set_upsert(p_actor => $1, p_tenant_key => $2, p_rule_set => $3::jsonb, p_id => NULL)';
const SET_LIST = 'SELECT * FROM rag_section_rule_sets_list(p_actor => $1, p_tenant_key => $2)';
const BP_UPSERT = 'SELECT * FROM rag_boilerplate_rule_upsert(p_actor => $1, p_tenant_key => $2, p_rule => $3::jsonb, p_id => NULL)';
const BP_LIST = 'SELECT * FROM rag_boilerplate_rules_list(p_actor => $1, p_tenant_key => $2)';
const DEF_UPSERT = `SELECT * FROM rag_attribute_definition_upsert(p_actor => $1, p_tenant_key => $2, p_key => $3, p_type => 'text',
  p_filterable => true, p_in_header => false, p_in_identifier_index => false, p_soft => false)`;
const DEF_LIST = 'SELECT * FROM rag_attribute_definitions_list(p_actor => $1, p_tenant_key => $2)';
const TPL_SET = 'SELECT * FROM rag_attribute_header_template_set(p_actor => $1, p_tenant_key => $2, p_template => $3)';
const TPL_GET = 'SELECT * FROM rag_attribute_header_template_get(p_actor => $1, p_tenant_key => $2)';
const VALUES_SQL = 'SELECT key, value FROM rag_attribute_filter_values(p_tenant_key => $1, p_limit => 1000)';
const DOCS_SQL = 'SELECT document_id FROM rag_attribute_documents(p_tenant_key => $1, p_filters => $2::jsonb, p_limit => 100)';
const FEED_SQL = 'SELECT document_id FROM rag_attribute_identifier_documents(p_tenant_key => $1, p_after => NULL, p_limit => 1000)';

suite('Phase 3.3 writers across two tenants (multi-tenant)', () => {
  let db: PGlite;
  let a: Tenant;
  let b: Tenant;

  before(async () => {
    const built = await database('multi-tenant');
    db = built.db;
    a = built.a;
    b = built.b!;
    await rows(db, SET_UPSERT, [ADMIN_A, a.key, JSON.stringify({ name: 'Rule set a', headings: [{ pattern: '^part\\b', flags: 'u', name: 'Part', level: 1 }] })]);
    await rows(db, BP_UPSERT, [ADMIN_A, a.key, JSON.stringify({ name: 'Line rule a', kind: 'line', pattern: '^neutral footer$', flags: 'u' })]);
    await rows(db, DEF_UPSERT, [ADMIN_A, a.key, 'epsilon_text']);
    await rows(db, TPL_SET, [ADMIN_A, a.key, 'Code: {alpha_code}']);
  });

  after(async () => {
    await db?.close();
  });

  test("tenant b's admin naming a's key is refused not_admin by every writer, and a's rows are unchanged", async () => {
    const counts = async () =>
      Object.fromEntries(
        await Promise.all(
          PHASE33_TABLES.slice(0, 4).map(async (table) => [table, Number((await rows(db, `SELECT count(*)::int AS n FROM public.${table} WHERE tenant_key = $1`, [a.key]))[0]?.n)]),
        ),
      );
    const before = await counts();
    const attempts: [string, unknown[]][] = [
      [SET_UPSERT, [ADMIN_B, a.key, JSON.stringify({ name: 'Rule set x', headings: [{ pattern: '^x\\b', flags: 'u', name: 'X', level: 1 }] })]],
      [BP_UPSERT, [ADMIN_B, a.key, JSON.stringify({ name: 'Line rule x', kind: 'line', pattern: '^x$', flags: 'u' })]],
      [DEF_UPSERT, [ADMIN_B, a.key, 'zeta_text']],
      [TPL_SET, [ADMIN_B, a.key, 'Other: {alpha_code}']],
    ];
    for (const [sql, params] of attempts) {
      const failed = await failure(db, sql, params);
      assert.match(failed?.message ?? '', /^not_admin/, sql.slice(0, 50));
    }
    assert.deepEqual(await counts(), before);
  });

  test("a list or read for b returns none of a's rows; b's admin listing a's key gets nothing", async () => {
    const aMarkers = ['Rule set a', 'Line rule a', 'epsilon_text'];
    const holdsA = (found: Row[]): boolean => found.some((row) => aMarkers.includes(String(row.name)) || aMarkers.includes(String(row.key)));
    for (const sql of [SET_LIST, BP_LIST, DEF_LIST]) {
      assert.equal(holdsA(await rows(db, sql, [ADMIN_B, b.key])), false, `${sql.slice(14, 50)} for b`);
      assert.deepEqual(await rows(db, sql, [ADMIN_B, a.key]), [], `${sql.slice(14, 50)} for b naming a`);
      assert.equal(holdsA(await rows(db, sql, [ADMIN_A, a.key])), true, `${sql.slice(14, 50)} for a`);
    }
    const own = await rows(db, TPL_GET, [ADMIN_B, b.key]);
    assert.ok(own.every((row) => row.template === null || row.template === undefined), 'b reads no template');
    const crossed = await failure(db, TPL_GET, [ADMIN_B, a.key]);
    if (crossed === null) {
      const got = await rows(db, TPL_GET, [ADMIN_B, a.key]);
      assert.ok(got.every((row) => row.template === null || row.template === undefined), "b read a's template");
    } else {
      assert.match(crossed.message, /^not_admin/);
    }
    const rulesForB = await rows(db, 'SELECT * FROM rag_tenant_rules_for(p_tenant_key => $1, p_doc_type => NULL, p_source => NULL)', [b.key]);
    assert.ok(rulesForB.every((row) => JSON.stringify(row).indexOf('Rule set a') < 0 && JSON.stringify(row).indexOf('neutral footer') < 0), "b's rules hold a's rule");
    const defsForB = await rows(db, 'SELECT key FROM rag_attribute_definitions_for(p_tenant_key => $1)', [b.key]);
    assert.ok(!defsForB.some((row) => row.key === 'epsilon_text'), "b's schema holds a's key");
    const tplForB = await rows(db, 'SELECT * FROM rag_attribute_header_template_for(p_tenant_key => $1)', [b.key]);
    assert.ok(tplForB.every((row) => row.template === null || row.template === undefined), "b's template read returned a's template");
  });
});

for (const mode of MODES) {
  suite(`Phase 3.3 staging, inheritance and resolver (${mode})`, () => {
    let db: PGlite;
    let a: Tenant;
    let b: Tenant | null;

    before(async () => {
      ({ db, a, b } = await database(mode));
    });

    after(async () => {
      await db?.close();
    });

    test("a's staged row for key K is never used by b's version of K; a's later version of K takes it", async () => {
      const key = nextName('shared-key');
      await stage(db, a.key, key, { alpha_code: VALUE_A });
      if (b) {
        const foreign = await beginVersion(db, b, key);
        const applied = await apply(db, b, foreign, null);
        assert.equal(applied.origin, 'none');
        await writeChunk(db, b, foreign);
        await publish(db, b, foreign);
        assert.deepEqual(await attributesOf(db, foreign), { document: null, chunks: [null] });
        const again = await beginVersion(db, b, key);
        assert.equal((await apply(db, b, again, null)).origin, 'none', "b's second version inherited nothing of a");
        await writeChunk(db, b, again);
        assert.deepEqual((await attributesOf(db, again)).chunks, [null]);
      }
      const own = await beginVersion(db, a, key);
      const applied = await apply(db, a, own, null);
      assert.equal(applied.origin, 'staged');
      await writeChunk(db, a, own);
      await publish(db, a, own);
      assert.deepEqual(await attributesOf(db, own), { document: { alpha_code: VALUE_A }, chunks: [{ alpha_code: VALUE_A }] });
      const next = await beginVersion(db, a, key);
      assert.equal((await apply(db, a, next, null)).origin, 'inherited');
      assert.deepEqual((await attributesOf(db, next)).document, { alpha_code: VALUE_A });
    });

    test("inheritance never crosses tenants and a chunk inserted for b's document never carries a's value", async () => {
      if (!b) return;
      const key = nextName('lineage');
      const ownA = await beginVersion(db, a, key);
      await apply(db, a, ownA, { alpha_code: VALUE_A2 });
      await writeChunk(db, a, ownA);
      await publish(db, a, ownA);
      const ownB = await beginVersion(db, b, key);
      assert.equal((await apply(db, b, ownB, null)).origin, 'none');
      await rows(db, "INSERT INTO public.document_chunks (id, document_id, chunk_index, content, metadata, tenant_key) VALUES (gen_random_uuid(), $1, 0, 'neutral', '{}'::jsonb, $2)", [ownB, b.key]);
      assert.deepEqual((await attributesOf(db, ownB)).chunks, [null]);
      const forged = await failure(
        db,
        "INSERT INTO public.document_chunks (id, document_id, chunk_index, content, metadata, tenant_key) VALUES (gen_random_uuid(), $1, 1, 'neutral', '{}'::jsonb, $2)",
        [ownA, b.key],
      );
      if (forged === null) {
        const stray = await rows(db, 'SELECT attributes FROM public.document_chunks WHERE document_id = $1 AND tenant_key = $2', [ownA, b.key]);
        for (const row of stray) assert.equal(row.attributes, null, "a chunk under b's key took a's value");
      }
    });

    test("resolver: b's key with a's value returns no id; the value read and the identifier feed list own rows only", async () => {
      const ownA = await beginVersion(db, a, nextName('resolve-a'));
      await apply(db, a, ownA, { alpha_code: VALUE_A, beta_list: ['qa-l-1'], delta_text: SOFT_A });
      await writeChunk(db, a, ownA);
      await publish(db, a, ownA);
      assert.deepEqual(
        (await rows(db, DOCS_SQL, [a.key, JSON.stringify({ alpha_code: [VALUE_A] })])).map((row) => row.document_id).includes(ownA),
        true,
      );
      const aFeed = (await rows(db, FEED_SQL, [a.key])).map((row) => String(row.document_id));
      assert.ok(aFeed.includes(ownA));
      if (!b) return;
      const ownB = await beginVersion(db, b, nextName('resolve-b'));
      await apply(db, b, ownB, { alpha_code: VALUE_B });
      await writeChunk(db, b, ownB);
      await publish(db, b, ownB);
      assert.deepEqual(await rows(db, DOCS_SQL, [b.key, JSON.stringify({ alpha_code: [VALUE_A] })]), [], "b resolved a's value");
      assert.deepEqual(await rows(db, DOCS_SQL, [b.key, JSON.stringify({ delta_text: [SOFT_A] })]), [], "b resolved a's soft value");
      const bValues = (await rows(db, VALUES_SQL, [b.key])).map((row) => String(row.value));
      assert.deepEqual(bValues, [VALUE_B], 'b lists only its own values');
      const bFeed = (await rows(db, FEED_SQL, [b.key])).map((row) => String(row.document_id));
      assert.ok(bFeed.includes(ownB));
      for (const id of aFeed) assert.ok(!bFeed.includes(id), "b's identifier feed listed a's document");
    });
  });
}

/** Child report: ids, counts and booleans only. */
interface ChildReport {
  mode: DeploymentMode;
  caches?: Record<string, { aHas: boolean; bHasForeign: boolean; bAfterInvalidateCached: boolean; aAfterInvalidateReloaded: boolean }>;
  resolver: { ownHard: number; crossHard: number; crossSoft: number; crossExplicit: number | 'refused' };
  services?: { inlineOrigin: string; queuedOrigin: string; bAttributes: number; ownOrigin: string };
  stage: Record<string, { candidates: number; foreign: number; own: number; attribute: Row | null; attrListForeign: number; attrListOwn: number }>;
  leaks: { trace: number; logs: number; logLines: number };
}

function runChild(mode: DeploymentMode): ChildReport {
  const out = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // Without the parent's test-runner context, so the child's node:test import stays inert and its stdout holds the report only.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')), PHASE33_MATRIX_CHILD: mode },
    timeout: 300_000,
  });
  assert.equal(out.status, 0, `child (${mode}) failed: ${out.stderr.slice(-2000)}`);
  const line = out.stdout.trim().split('\n').filter((entry) => entry.startsWith('{"mode"')).pop() ?? '';
  return JSON.parse(line) as ChildReport;
}

if (!CHILD) {
  for (const mode of MODES) {
    describe(`Phase 3.3 loaders, services and the attribute_resolve stage (${mode}, child process)`, () => {
      let report: ChildReport;

      before(() => {
        report = runChild(mode);
      });

      if (mode === 'multi-tenant') {
        test('caches: loadTenantRules, loadAttributeSchema, loadHeaderTemplate and attributeLexiconFor never serve a to b; invalidating a keeps b', () => {
          assert.deepEqual(Object.keys(report.caches ?? {}).sort(), ['attributeLexiconFor', 'loadAttributeSchema', 'loadHeaderTemplate', 'loadTenantRules']);
          for (const [name, entry] of Object.entries(report.caches ?? {})) {
            assert.deepEqual(entry, { aHas: true, bHasForeign: false, bAfterInvalidateCached: true, aAfterInvalidateReloaded: true }, name);
          }
        });

        test("services: inline and queued apply give b no attribute of a's staged key; a's ingest of the key takes a's values", () => {
          assert.deepEqual(report.services, { inlineOrigin: 'none', queuedOrigin: 'none', bAttributes: 0, ownOrigin: 'staged' });
        });
      }

      test("resolveAttributeFilter: b's scope with a's value resolves no id; a's own value resolves", () => {
        assert.ok(report.resolver.ownHard > 0);
        if (mode === 'multi-tenant') {
          assert.equal(report.resolver.crossHard, 0);
          assert.equal(report.resolver.crossSoft, 0);
          assert.ok(report.resolver.crossExplicit === 0 || report.resolver.crossExplicit === 'refused');
        }
      });

      test('stage hard: own scope applies the filter to own chunks only; the other tenant sees none of them and the block shows zero matched', () => {
        const own = report.stage.hardOwn!;
        assert.ok(own.candidates > 0 && own.foreign === 0 && own.own === own.candidates);
        assert.equal(own.attribute?.applied, true);
        assert.equal(own.attribute?.matched_attributes, 1);
        if (mode === 'multi-tenant') {
          const crossed = report.stage.hardCross!;
          assert.equal(crossed.foreign, 0, 'b saw a chunk of a');
          assert.equal(crossed.attribute?.matched_attributes, 0);
          assert.equal(crossed.attribute?.applied, false);
        }
      });

      test('stage soft: the attr:0 list holds own chunks only', () => {
        const own = report.stage.softOwn!;
        assert.ok(own.attrListOwn > 0, 'attr:0 found no own chunk');
        assert.equal(own.attrListForeign, 0);
        if (mode === 'multi-tenant') {
          const crossed = report.stage.softCross!;
          assert.equal(crossed.attrListForeign, 0, "b's attr:0 list held a chunk of a");
          assert.equal(crossed.foreign, 0);
        }
      });

      test('no trace field, stage detail or captured log line carries a value string of either tenant', () => {
        assert.ok(report.leaks.logLines > 0, 'no log line was captured');
        assert.deepEqual({ trace: report.leaks.trace, logs: report.leaks.logs }, { trace: 0, logs: 0 });
      });
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Child process: one deployment mode, the eval route over the fixture edge.
// ---------------------------------------------------------------------------------------------------------------------------------------

async function childMain(mode: DeploymentMode): Promise<ChildReport> {
  const captured: string[] = [];
  const capture = (...args: unknown[]) => {
    captured.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  console.debug = capture;

  const { prepareInProcessEval } = await import('../../eval/harness/run-eval.mts');
  const { embedText } = await import('../../eval/harness/fixture-embedder.mts');
  const { runFixtureRelex } = await import('../../eval/harness/pglite-supabase.mts');
  const { NextRequest } = await import('next/server');
  const prepared = await prepareInProcessEval({
    corpusDir: path.join(REPO_ROOT, 'eval/fixtures/corpus'),
    deploymentMode: mode,
    allowedScopes: mode === 'multi-tenant' ? [`user:${USER_B}`] : [],
    envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_DOC_ATTRIBUTES: 'true', RAG_ATTRIBUTE_FILTER: 'off' },
  });
  const report: ChildReport = { mode, resolver: { ownHard: 0, crossHard: 0, crossSoft: 0, crossExplicit: 0 }, stage: {}, leaks: { trace: 0, logs: 0, logLines: 0 } };
  const traces: string[] = [];
  try {
    const db = prepared.fixtureDb;
    const { resetRagConfigForTests } = await import('../../src/lib/rag/config.ts');
    const { resetV2StartupForTests, verifyV2Startup } = await import('../../src/lib/rag/v2/startup.ts');
    const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
    const attributes = await import('../../src/lib/rag/retrieval/attributes.ts');
    const rules = await import('../../src/lib/rag/ingest/rules/load.ts');
    const schema = await import('../../src/lib/rag/ingest/attributes/schema.ts');
    const header = await import('../../src/lib/rag/ingest/attributes/header.ts');
    const applyModule = await import('../../src/lib/rag/ingest/attributes/apply.ts');
    const { serviceRoleRpc } = await import('../../eval/harness/two-tenant-v2.mts');

    const a: Tenant = mode === 'multi-tenant' ? { key: `u:${FIXTURE_USER_ID}`, userId: FIXTURE_USER_ID, orgId: null } : { key: 's:default', userId: null, orgId: null };
    const b: Tenant | null = mode === 'multi-tenant' ? { key: `u:${USER_B}`, userId: USER_B, orgId: null } : null;
    const scopeA = mode === 'multi-tenant' ? mintScope('personal', FIXTURE_USER_ID, null) : mintScope('single', null, null);
    const scopeB = b ? mintScope('personal', USER_B, null) : null;
    if (b) {
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [USER_B, 'matrix-child-b@example.invalid']);
      await db.query('INSERT INTO public.admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [FIXTURE_USER_ID]);
    }
    await defineKeys(db, a.key);
    if (b) await defineKeys(db, b.key);

    const ownDocs = new Set<string>();
    const foreignDocs = new Set<string>();
    const document = async (tenant: Tenant, sourceKey: string, content: string, values: Row): Promise<string> => {
      const id = await beginVersion(db, tenant, sourceKey);
      await apply(db, tenant, id, values);
      await rows(
        db,
        'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => 1)',
        [id, tenant.key, JSON.stringify([{ chunk_index: 0, content, lexical_text: content, metadata: {} }]), JSON.stringify({ [LEGACY_EMBED_PROFILE]: [embedText(content)] })],
      );
      await publish(db, tenant, id);
      return id;
    };
    const content = (index: number) => `Probe family record ${index}. The service routine for this probe unit has four plain steps and one closing check.`;
    for (let index = 0; index < 4; index++) {
      ownDocs.add(await document(a, nextName('own'), content(index), { alpha_code: index === 0 ? VALUE_A : `qa-k-${5000 + index}`, ...(index === 1 ? { delta_text: SOFT_A } : {}) }));
    }
    if (b) {
      for (let index = 0; index < 3; index++) foreignDocs.add(await document(b, nextName('foreign'), content(index), { alpha_code: index === 0 ? VALUE_B : `qb-k-${6000 + index}` }));
    }
    await runFixtureRelex(db);

    // Resolver.
    const own = await attributes.resolveAttributeFilter(scopeA, `service routine for unit ${VALUE_A}`, null);
    report.resolver.ownHard = own.hardIds?.length ?? 0;
    if (scopeB) {
      const crossed = await attributes.resolveAttributeFilter(scopeB, `service routine for unit ${VALUE_A}`, null);
      report.resolver.crossHard = crossed.hardIds?.length ?? 0;
      const soft = await attributes.resolveAttributeFilter(scopeB, `service routine ${SOFT_A}`, null);
      report.resolver.crossSoft = soft.softIds.filter((id) => ownDocs.has(id)).length + (soft.hardIds ?? []).filter((id) => ownDocs.has(id)).length;
      try {
        const explicit = await attributes.resolveAttributeFilter(scopeB, 'service routine', { alpha_code: [VALUE_A] });
        report.resolver.crossExplicit = [...(explicit.explicitIds ?? []), ...(explicit.explicitCappedIds ?? [])].filter((id) => ownDocs.has(id)).length;
      } catch {
        report.resolver.crossExplicit = 'refused';
      }
    }

    // Caches (two tenants only).
    if (b && scopeB) {
      const signal = new AbortController().signal;
      await db.query(`INSERT INTO public.rag_section_rule_sets (tenant_key, name, rules) VALUES ($1, 'Rule set a', $2::jsonb)`, [
        a.key,
        JSON.stringify({ headings: [{ pattern: '^part\\b', flags: 'u', name: 'Part', level: 1 }] }),
      ]);
      await db.query(`INSERT INTO public.rag_attribute_definitions (tenant_key, key, type) VALUES ($1, 'epsilon_text', 'text') ON CONFLICT DO NOTHING`, [a.key]);
      await db.query(`INSERT INTO public.rag_attribute_header_templates (tenant_key, template) VALUES ($1, 'Code: {alpha_code}') ON CONFLICT DO NOTHING`, [a.key]);
      const rpcCount = () => prepared.edge.calls.filter((call) => call.path.startsWith('/rest/v1/rpc/')).length;
      const probe = async (
        name: string,
        load: (tenant: 'a' | 'b') => Promise<unknown>,
        hasOwn: (value: unknown) => boolean,
        invalidateA: () => void | Promise<void>,
        reset: () => void,
      ) => {
        reset();
        const valueA = await load('a');
        const valueB = await load('b');
        await invalidateA();
        const beforeB = rpcCount();
        await load('b');
        const bCached = rpcCount() === beforeB;
        const beforeA = rpcCount();
        const reloadA = await load('a');
        report.caches![name] = { aHas: hasOwn(valueA) && hasOwn(reloadA), bHasForeign: hasOwn(valueB), bAfterInvalidateCached: bCached, aAfterInvalidateReloaded: rpcCount() > beforeA };
        reset();
      };
      report.caches = {};
      await probe(
        'loadTenantRules',
        (tenant) => rules.loadTenantRules(tenant === 'a' ? scopeA : scopeB, { docType: null, source: null }),
        (value) => JSON.stringify(value).includes('^part\\\\b'),
        () => rules.invalidateTenantRules(a.key),
        () => rules.resetTenantRuleCacheForTests(),
      );
      await probe(
        'loadAttributeSchema',
        (tenant) => schema.loadAttributeSchema(tenant === 'a' ? scopeA : scopeB, { signal }),
        (value) => JSON.stringify(value).includes('epsilon_text'),
        async () => {
          // The schema cache has no exported invalidator; a's own writer invalidates a's entry only.
          const written = await schema.upsertAttributeDefinition({ actorUserId: FIXTURE_USER_ID, tenantKey: a.key, signal }, { key: 'eta_text', type: 'text' });
          assert.equal(written.ok, true, 'a writer refused');
        },
        () => schema.resetAttributeSchemaCacheForTests(),
      );
      await probe(
        'loadHeaderTemplate',
        (tenant) => header.loadHeaderTemplate(tenant === 'a' ? a.key : b.key, { signal }),
        (value) => JSON.stringify(value).includes('Code: {alpha_code}'),
        () => header.invalidateHeaderTemplate(a.key),
        () => header.resetHeaderTemplateCacheForTests(),
      );
      await probe(
        'attributeLexiconFor',
        (tenant) => attributes.attributeLexiconFor(tenant === 'a' ? scopeA : scopeB).then((lexicon) => lexicon.values.map((entry) => entry.value)),
        (value) => (value as string[]).includes(VALUE_A),
        () => attributes.invalidateAttributeLexicon(a.key),
        () => attributes.resetAttributeLexiconForTests(),
      );

      // Ingest services: the inline stage hook (file_hash_dedup) and the queued callback's writer share rag_apply_document_attributes.
      const client = serviceRoleRpc(db);
      const sharedKey = nextName('staged-shared');
      await stage(db, a.key, sharedKey, { alpha_code: VALUE_A2 });
      const inlineId = await beginVersion(db, b, sharedKey);
      const { currentIngestConfig } = await import('../../src/lib/rag/ingest/current-config.ts');
      const config = { ...currentIngestConfig(), docAttributes: true, attributeHeader: false };
      await applyModule.applyDocumentAttributes({
        document: { id: inlineId },
        identity: { tenantKey: b.key },
        config,
        input: {},
        deps: { db: () => client },
        signal,
      } as unknown as Parameters<typeof applyModule.applyDocumentAttributes>[0]);
      const inlineOrigin = String((await rows(db, 'SELECT attributes FROM public.documents WHERE id = $1', [inlineId]))[0]?.attributes === null ? 'none' : 'applied');
      const queuedId = await beginVersion(db, b, sharedKey);
      const queued = await applyModule.writeDocumentAttributes(client, b.key, queuedId, undefined, signal, { config });
      const bAttributes = Number(
        (await rows(db, 'SELECT count(*)::int AS n FROM public.documents WHERE tenant_key = $1 AND id = ANY ($2::uuid[]) AND attributes IS NOT NULL', [b.key, [inlineId, queuedId]]))[0]?.n,
      );
      const ownId = await beginVersion(db, a, sharedKey);
      const ownApplied = await applyModule.writeDocumentAttributes(client, a.key, ownId, undefined, signal, { config });
      report.services = { inlineOrigin, queuedOrigin: queued.origin, bAttributes, ownOrigin: ownApplied.origin };
    }

    // Stage through the eval route.
    const configure = async (env: Record<string, string>): Promise<void> => {
      Object.assign(process.env, env);
      resetRagConfigForTests();
      resetV2StartupForTests();
      attributes.resetAttributeLexiconForTests();
      await verifyV2Startup();
    };
    interface Candidate {
      chunk_id: string;
      document_id: string;
      legs?: Record<string, number>;
    }
    const post = async (query: string, tenant: 'a' | 'b'): Promise<{ candidates: Candidate[]; attribute_filter?: Row }> => {
      const userId = tenant === 'b' ? USER_B : mode === 'multi-tenant' ? FIXTURE_USER_ID : undefined;
      const req = new NextRequest('http://localhost/api/internal/rag/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
        body: JSON.stringify({ schema_version: 1, query, rag_mode: 'strict', options: userId ? { user_id: userId } : {} }),
      });
      const res = await prepared.POST(req);
      const json = (await res.json()) as { candidates: Candidate[]; attribute_filter?: Row; error?: string; query?: unknown };
      if (res.status !== 200) throw new Error(`eval route answered ${res.status}: ${json.error ?? 'unknown'}`);
      const { query: _echo, ...rest } = json;
      traces.push(JSON.stringify({ ...rest, candidates: rest.candidates.map((row) => ({ ...row, content: undefined, text: undefined })) }));
      return json;
    };
    const summarize = (trace: { candidates: Candidate[]; attribute_filter?: Row }, ownSet: Set<string>, foreignSet: Set<string>) => ({
      candidates: trace.candidates.length,
      own: trace.candidates.filter((row) => ownSet.has(row.document_id)).length,
      foreign: trace.candidates.filter((row) => foreignSet.has(row.document_id)).length,
      attribute: trace.attribute_filter ?? null,
      attrListOwn: trace.candidates.filter((row) => ownSet.has(row.document_id) && row.legs && 'attr:0' in row.legs).length,
      attrListForeign: trace.candidates.filter((row) => foreignSet.has(row.document_id) && row.legs && 'attr:0' in row.legs).length,
    });
    const hardQuery = `What is the service routine for unit ${VALUE_A}?`;
    const softQuery = `What is the service routine for unit ${SOFT_A}?`;
    await configure({ RAG_ATTRIBUTE_FILTER: 'hard', RAG_EXACT_SCAN_CUTOFF: '0' });
    report.stage.hardOwn = summarize(await post(hardQuery, 'a'), ownDocs, foreignDocs);
    if (b) report.stage.hardCross = summarize(await post(hardQuery, 'b'), foreignDocs, ownDocs);
    await configure({ RAG_ATTRIBUTE_FILTER: 'soft', RAG_EXACT_SCAN_CUTOFF: '0' });
    report.stage.softOwn = summarize(await post(softQuery, 'a'), ownDocs, foreignDocs);
    if (b) report.stage.softCross = summarize(await post(softQuery, 'b'), foreignDocs, ownDocs);
  } finally {
    await prepared.close();
  }
  const values = [VALUE_A, VALUE_A2, VALUE_B, SOFT_A];
  report.leaks = {
    trace: traces.filter((trace) => values.some((value) => trace.includes(value))).length,
    logs: captured.filter((line) => values.some((value) => line.includes(value))).length,
    logLines: captured.length,
  };
  return report;
}

if (process.env.PHASE33_MATRIX_CHILD) {
  const mode = process.env.PHASE33_MATRIX_CHILD as DeploymentMode;
  childMain(mode).then(
    (report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exit(0);
    },
    (error: unknown) => {
      process.stderr.write(`[phase33-two-tenant child] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
