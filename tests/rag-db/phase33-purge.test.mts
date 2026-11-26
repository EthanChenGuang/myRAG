import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * TPL-03 / TPL-08 (D-02, D-35, F-24): migration 1009. rag_purge_hook_doc_attributes clears the Phase 3.3 columns of a purged lineage's
 * versions and chunks and the staged rows of their source keys; rag_tenant_rule_data_delete removes one tenant's rows from the five Phase 3.3
 * tables. Both stay inside the named tenant in both deployment modes. Test data is invented and neutral.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/1009_phase33_purge.sql';
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];

const ORG_A = '00000000-0000-4000-8000-000000100901';
const ORG_B = '00000000-0000-4000-8000-000000100902';
const ADMIN_A = '00000000-0000-4000-8000-000000100911';
const ADMIN_B = '00000000-0000-4000-8000-000000100912';
const SOURCE = 'config_upload';
const LEGACY_EMBED_PROFILE = 'openai-3-small-1536';

const HOOK = 'rag_purge_hook_doc_attributes(text, uuid, uuid[])';
const DELETE = 'rag_tenant_rule_data_delete(text)';
const HOOK_SQL = 'SELECT rag_purge_hook_doc_attributes(p_tenant_key => $1, p_lineage_id => $2::uuid, p_document_ids => $3::uuid[]) AS n';
const DELETE_SQL = 'SELECT relation, deleted::int AS deleted FROM rag_tenant_rule_data_delete(p_tenant_key => $1)';
const TABLE_ORDER = [
  'rag_section_rule_sets',
  'rag_boilerplate_rules',
  'rag_attribute_definitions',
  'rag_attribute_header_templates',
  'rag_staged_attributes',
];

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

let sequence = 0;
const nextName = (label: string): string => `${label}-${++sequence}`;

async function defineKeys(db: PGlite, tenantKey: string): Promise<void> {
  await rows(
    db,
    `INSERT INTO public.rag_attribute_definitions (tenant_key, key, type) VALUES ($1, 'alpha_code', 'code'), ($1, 'beta_list', 'text_list')
     ON CONFLICT (tenant_key, key) DO NOTHING`,
    [tenantKey],
  );
}

async function seedRuleData(db: PGlite, tenantKey: string): Promise<void> {
  await defineKeys(db, tenantKey);
  await rows(
    db,
    `INSERT INTO public.rag_section_rule_sets (tenant_key, name, rules) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING`,
    [tenantKey, nextName('rules'), JSON.stringify({ headings: [{ pattern: '^part one\\b', flags: 'u' }] })],
  );
  await rows(
    db,
    `INSERT INTO public.rag_boilerplate_rules (tenant_key, name, kind, pattern, flags) VALUES ($1, $2, 'line', '^neutral footer line$', 'u') ON CONFLICT DO NOTHING`,
    [tenantKey, nextName('boiler')],
  );
  await rows(
    db,
    `INSERT INTO public.rag_attribute_header_templates (tenant_key, template) VALUES ($1, 'Code: {alpha_code}')
     ON CONFLICT (tenant_key) DO UPDATE SET template = EXCLUDED.template`,
    [tenantKey],
  );
  await stage(db, tenantKey, nextName('staged-only'), { alpha_code: 'S-1' });
}

async function stage(db: PGlite, tenantKey: string, sourceKey: string, attributes: Record<string, unknown>): Promise<void> {
  await rows(db, 'SELECT * FROM rag_stage_document_attributes(p_tenant_key => $1, p_rows => $2::jsonb)', [
    tenantKey,
    JSON.stringify([{ source: SOURCE, source_key: sourceKey, attributes }]),
  ]);
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

async function writeChunks(db: PGlite, tenant: Tenant, id: string): Promise<void> {
  const contents = [`${nextName('tok')} neutral probe sentence one`, `${nextName('tok')} neutral probe sentence two`];
  const chunks = contents.map((content, index) => ({ chunk_index: index, content, lexical_text: content, metadata: {} }));
  const vector = (seed: number) => Array.from({ length: 1536 }, (_, index) => (index === seed % 1536 ? 1 : 0));
  await rows(
    db,
    'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => 2)',
    [id, tenant.key, JSON.stringify(chunks), JSON.stringify({ [LEGACY_EMBED_PROFILE]: [vector(1), vector(2)] })],
  );
}

/** One published version carrying explicit values, a header and a stamp on the document and its chunks. */
async function attributedVersion(db: PGlite, tenant: Tenant, sourceKey: string): Promise<string> {
  const id = await beginVersion(db, tenant, sourceKey);
  await rows(db, 'SELECT * FROM rag_apply_document_attributes(p_tenant_key => $1, p_document_id => $2, p_explicit => $3::jsonb)', [
    tenant.key,
    id,
    JSON.stringify({ alpha_code: 'K-1', beta_list: ['b1'] }),
  ]);
  await writeChunks(db, tenant, id);
  await rows(db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [id, tenant.key]);
  await rows(db, "UPDATE public.documents SET attribute_header = 'Code: K-1', attribute_header_stamp = 't1.0123456789ab' WHERE id = $1", [id]);
  await rows(db, "UPDATE public.document_chunks SET attribute_header_stamp = 't1.0123456789ab' WHERE document_id = $1", [id]);
  return id;
}

async function lineageOf(db: PGlite, id: string): Promise<string> {
  return String((await rows(db, 'SELECT lineage_id FROM public.documents WHERE id = $1', [id]))[0]?.lineage_id);
}

interface Snapshot {
  document: Row;
  chunks: Row[];
}

async function snapshot(db: PGlite, id: string): Promise<Snapshot> {
  const document = (await rows(db, 'SELECT attributes, attribute_header, attribute_header_stamp FROM public.documents WHERE id = $1', [id]))[0] ?? {};
  const chunks = await rows(db, 'SELECT attributes, attribute_header_stamp FROM public.document_chunks WHERE document_id = $1 ORDER BY chunk_index', [id]);
  return { document, chunks };
}

function assertCleared(found: Snapshot): void {
  assert.deepEqual(found.document, { attributes: null, attribute_header: null, attribute_header_stamp: null });
  assert.ok(found.chunks.length > 0);
  for (const chunk of found.chunks) assert.deepEqual(chunk, { attributes: null, attribute_header_stamp: null });
}

function assertCarried(found: Snapshot): void {
  assert.deepEqual(found.document, { attributes: { alpha_code: 'K-1', beta_list: ['b1'] }, attribute_header: 'Code: K-1', attribute_header_stamp: 't1.0123456789ab' });
  assert.ok(found.chunks.length > 0);
  for (const chunk of found.chunks) assert.deepEqual(chunk, { attributes: { alpha_code: 'K-1', beta_list: ['b1'] }, attribute_header_stamp: 't1.0123456789ab' });
}

async function stagedKeys(db: PGlite, tenantKey: string): Promise<string[]> {
  return (await rows(db, 'SELECT source_key FROM public.rag_staged_attributes WHERE tenant_key = $1 ORDER BY source_key', [tenantKey])).map((row) =>
    String(row.source_key),
  );
}

async function tableCounts(db: PGlite, tenantKey: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLE_ORDER) {
    out[table] = Number((await rows(db, `SELECT count(*)::int AS n FROM public.${table} WHERE tenant_key = $1`, [tenantKey]))[0]?.n);
  }
  return out;
}

async function database(mode: DeploymentMode): Promise<{ db: PGlite; a: Tenant; b: Tenant | null }> {
  const db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
  if (mode === 'single-tenant') {
    await defineKeys(db, 's:default');
    return { db, a: { key: 's:default', userId: null, orgId: null }, b: null };
  }
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [
    ADMIN_A,
    'purge-a@example.invalid',
    ADMIN_B,
    'purge-b@example.invalid',
  ]);
  await db.query(
    'INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false), ($5, $6, $7, $8, false) ON CONFLICT DO NOTHING',
    [ORG_A, 'Tenant A', 'tenant-a-1009', ADMIN_A, ORG_B, 'Tenant B', 'tenant-b-1009', ADMIN_B],
  );
  await db.query(
    "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner') ON CONFLICT DO NOTHING",
    [ORG_A, ADMIN_A, ORG_B, ADMIN_B],
  );
  await defineKeys(db, `o:${ORG_A}`);
  await defineKeys(db, `o:${ORG_B}`);
  return { db, a: { key: `o:${ORG_A}`, userId: ADMIN_A, orgId: ORG_A }, b: { key: `o:${ORG_B}`, userId: ADMIN_B, orgId: ORG_B } };
}

const foreignKeysFor = (mode: DeploymentMode): string[] =>
  mode === 'multi-tenant' ? ['s:default'] : [`u:${ADMIN_A}`, `o:${ORG_A}`];

for (const mode of MODES) {
  describe(`migration 1009 purge hook and tenant rule-data delete (${mode})`, () => {
    let db: PGlite;
    let a: Tenant;
    let b: Tenant | null;

    before(async () => {
      ({ db, a, b } = await database(mode));
    });

    after(async () => {
      await db?.close();
    });

    test('the hook clears both versions of a lineage and the staged row of its key, returns the changed-row count, and leaves the rest', async () => {
      const key = nextName('lineage');
      const v1 = await attributedVersion(db, a, key);
      const v2 = await attributedVersion(db, a, key);
      const lineage = await lineageOf(db, v1);
      assert.equal(await lineageOf(db, v2), lineage);
      const otherOwn = await attributedVersion(db, a, nextName('other'));
      await stage(db, a.key, key, { alpha_code: 'K-2' });
      const keepStaged = nextName('keep-staged');
      await stage(db, a.key, keepStaged, { alpha_code: 'K-3' });
      let foreign: string | null = null;
      if (b) {
        foreign = await attributedVersion(db, b, key);
        await stage(db, b.key, key, { alpha_code: 'K-4' });
      }

      const before1 = await snapshot(db, v1);
      const before2 = await snapshot(db, v2);
      const expected = 2 + before1.chunks.length + before2.chunks.length + 1;
      const changed = (await rows(db, HOOK_SQL, [a.key, lineage, null]))[0]?.n;
      assert.equal(Number(changed), expected);
      assertCleared(await snapshot(db, v1));
      assertCleared(await snapshot(db, v2));
      assertCarried(await snapshot(db, otherOwn));
      assert.ok(!(await stagedKeys(db, a.key)).includes(key));
      assert.ok((await stagedKeys(db, a.key)).includes(keepStaged));
      if (b && foreign) {
        assertCarried(await snapshot(db, foreign));
        assert.ok((await stagedKeys(db, b.key)).includes(key));
      }
      assert.equal(Number((await rows(db, HOOK_SQL, [a.key, lineage, null]))[0]?.n), 0, 'a second call changes nothing');
    });

    test('the hook selects by document ids too, and a call naming another tenant’s lineage or ids changes nothing', async () => {
      const id = await attributedVersion(db, a, nextName('by-id'));
      const lineage = await lineageOf(db, id);
      if (b) {
        assert.equal(Number((await rows(db, HOOK_SQL, [b.key, lineage, [id]]))[0]?.n), 0);
        assertCarried(await snapshot(db, id));
      }
      const count = (await snapshot(db, id)).chunks.length + 1;
      assert.equal(Number((await rows(db, HOOK_SQL, [a.key, null, [id]]))[0]?.n), count);
      assertCleared(await snapshot(db, id));
    });

    test('the tenant delete removes only the named tenant’s rule data in a fixed order; a second call returns zeros; documents stay', async () => {
      await seedRuleData(db, a.key);
      if (b) await seedRuleData(db, b.key);
      const kept = await attributedVersion(db, a, nextName('kept'));
      const beforeA = await tableCounts(db, a.key);
      const beforeB = b ? await tableCounts(db, b.key) : null;
      for (const table of TABLE_ORDER) assert.ok(beforeA[table]! > 0, `${table} seeded`);

      const first = await rows(db, DELETE_SQL, [a.key]);
      assert.deepEqual(first.map((row) => row.relation), TABLE_ORDER);
      assert.deepEqual(Object.fromEntries(first.map((row) => [row.relation, row.deleted])), beforeA);
      assert.deepEqual(Object.values(await tableCounts(db, a.key)), TABLE_ORDER.map(() => 0));
      if (b && beforeB) assert.deepEqual(await tableCounts(db, b.key), beforeB);
      assertCarried(await snapshot(db, kept));

      const second = await rows(db, DELETE_SQL, [a.key]);
      assert.deepEqual(second.map((row) => [row.relation, row.deleted]), TABLE_ORDER.map((table) => [table, 0]));
    });

    test('both functions reject a tenant key of the other deployment mode', async () => {
      for (const key of foreignKeysFor(mode)) {
        for (const [sql, params] of [
          [HOOK_SQL, [key, crypto.randomUUID(), null]],
          [DELETE_SQL, [key]],
        ] as const) {
          const failed = await failure(db, sql, [...params]);
          assert.ok(failed !== null, `${sql.slice(0, 40)} accepted ${key.slice(0, 2)}`);
          assert.equal(failed.code, '22023');
        }
      }
    });

    test('anon and authenticated cannot execute either function (42501)', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        for (const [sql, params] of [
          [HOOK_SQL, [a.key, crypto.randomUUID(), null]],
          [DELETE_SQL, [a.key]],
        ] as const) {
          const failed = await asRole(db, role, () => failure(db, sql, [...params]));
          assert.equal(failed?.code, '42501', `${role} ${sql.slice(0, 40)}`);
        }
      }
    });

    test('catalog: SECURITY INVOKER, empty search_path, one function per name, service_role only', async () => {
      for (const signature of [HOOK, DELETE]) {
        const name = signature.slice(0, signature.indexOf('('));
        const found = await rows(
          db,
          `SELECT p.prosecdef, p.proconfig, p.oid::regprocedure::text AS sig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
             EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee = 0) AS public_exec
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
          [name],
        );
        assert.equal(found.length, 1, `${name} defined once`);
        const fn = found[0]!;
        assert.equal(fn.prosecdef, false, `${name} SECURITY INVOKER`);
        assert.deepEqual(fn.proconfig, ['search_path=""'], `${name} search_path`);
        assert.deepEqual({ anon: fn.anon, authed: fn.authed, public_exec: fn.public_exec, service: fn.service }, {
          anon: false,
          authed: false,
          public_exec: false,
          service: true,
        });
      }
    });

    test('the migration applied a second time is a no-op', async () => {
      const sql = fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8');
      await db.exec(sql);
      const count = await rows(
        db,
        "SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('rag_purge_hook_doc_attributes', 'rag_tenant_rule_data_delete')",
      );
      assert.equal(count[0]?.n, 2);
    });
  });
}
