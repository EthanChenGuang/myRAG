import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

/**
 * TPL-06 (D-02, D-28, D-29, D-30): the tenant value read and the attribute-to-document resolver of migration 1008. Resolver section
 * (plan 03.3-18); plan 03.3-19 appends the pipeline cases.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/1008_attribute_resolver.sql';

const ORG_A = '00000000-0000-4000-8000-000000100801';
const ORG_B = '00000000-0000-4000-8000-000000100802';
const ADMIN_A = '00000000-0000-4000-8000-000000100811';
const ADMIN_B = '00000000-0000-4000-8000-000000100812';
const KEY_A = `o:${ORG_A}`;
const KEY_B = `o:${ORG_B}`;
const SOURCE = 'config_upload';
const LEGACY_EMBED_PROFILE = 'openai-3-small-1536';

const FUNCTIONS = ['rag_attribute_filter_values(text, integer)', 'rag_attribute_documents(text, jsonb, integer)'];
const VALUES_SQL = 'SELECT * FROM rag_attribute_filter_values(p_tenant_key => $1, p_limit => $2)';
const DOCS_SQL = 'SELECT document_id FROM rag_attribute_documents(p_tenant_key => $1, p_filters => $2::jsonb, p_limit => $3)';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string | null;
  orgId: string | null;
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

async function malformed(db: PGlite, sql: string, params: unknown[]): Promise<void> {
  const failed = await failure(db, sql, params);
  assert.ok(failed !== null, `expected a refusal for ${JSON.stringify(params.slice(1))}`);
  assert.equal(failed.code, '22023');
}

let sequence = 0;
const nextName = (label: string): string => `${label}-${++sequence}`;

async function defineKeys(db: PGlite, tenantKey: string): Promise<void> {
  await rows(
    db,
    `INSERT INTO public.rag_attribute_definitions (tenant_key, key, type, filterable, soft) VALUES
       ($1, 'alpha_code', 'code', true, false), ($1, 'beta_list', 'text_list', true, false),
       ($1, 'gamma_text', 'text', false, false), ($1, 'delta_text', 'text', true, true)
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
  assert.ok(begun?.outcome === 'created' || begun?.outcome === 'new_version', `begin outcome ${String(begun?.outcome)}`);
  return String(begun?.document_id);
}

async function writeChunks(db: PGlite, tenant: Tenant, id: string): Promise<void> {
  const content = `${nextName('tok')} neutral probe sentence`;
  const chunks = [{ chunk_index: 0, content, lexical_text: content, metadata: {} }];
  const vector = Array.from({ length: 1536 }, (_, index) => (index === 1 ? 1 : 0));
  await rows(
    db,
    'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => 1)',
    [id, tenant.key, JSON.stringify(chunks), JSON.stringify({ [LEGACY_EMBED_PROFILE]: [vector] })],
  );
}

/** A version with values, applied before chunks; published unless `publish` is false (then it stays processing, not ready). */
async function document(db: PGlite, tenant: Tenant, attributes: Record<string, unknown>, options: { sourceKey?: string; publish?: boolean } = {}): Promise<string> {
  const id = await beginVersion(db, tenant, options.sourceKey ?? nextName('doc'));
  await rows(db, 'SELECT * FROM rag_apply_document_attributes(p_tenant_key => $1, p_document_id => $2, p_explicit => $3::jsonb)', [
    tenant.key,
    id,
    JSON.stringify(attributes),
  ]);
  await writeChunks(db, tenant, id);
  if (options.publish !== false) await rows(db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [id, tenant.key]);
  return id;
}

async function resolve(db: PGlite, tenantKey: string, filters: unknown, limit = 100): Promise<string[]> {
  return (await rows(db, DOCS_SQL, [tenantKey, JSON.stringify(filters), limit])).map((row) => String(row.document_id));
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

async function database(mode: 'multi-tenant' | 'single-tenant'): Promise<{ db: PGlite; a: Tenant; b: Tenant | null }> {
  const db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
  if (mode === 'single-tenant') {
    await defineKeys(db, 's:default');
    return { db, a: { key: 's:default', userId: null, orgId: null }, b: null };
  }
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [
    ADMIN_A,
    'resolver-a@example.invalid',
    ADMIN_B,
    'resolver-b@example.invalid',
  ]);
  await db.query(
    'INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false), ($5, $6, $7, $8, false) ON CONFLICT DO NOTHING',
    [ORG_A, 'Tenant A', 'tenant-a-1008', ADMIN_A, ORG_B, 'Tenant B', 'tenant-b-1008', ADMIN_B],
  );
  await db.query(
    "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner') ON CONFLICT DO NOTHING",
    [ORG_A, ADMIN_A, ORG_B, ADMIN_B],
  );
  await defineKeys(db, KEY_A);
  await defineKeys(db, KEY_B);
  return { db, a: { key: KEY_A, userId: ADMIN_A, orgId: ORG_A }, b: { key: KEY_B, userId: ADMIN_B, orgId: ORG_B } };
}

const sorted = (ids: string[]): string[] => [...ids].sort();

for (const mode of ['multi-tenant', 'single-tenant'] as const) {
  describe(`attribute resolver (${mode})`, () => {
    let db: PGlite;
    let a: Tenant;
    let b: Tenant | null;
    const ids: Record<string, string> = {};

    before(async () => {
      ({ db, a, b } = await database(mode));
      ids.x1 = await document(db, a, { alpha_code: 'x1', beta_list: ['y1', 'y2'], gamma_text: 'hidden-g', delta_text: 'zeta-17' });
      ids.x2 = await document(db, a, { alpha_code: 'x2', beta_list: ['y3'] });
      ids.x1y3 = await document(db, a, { alpha_code: 'x1', beta_list: ['y3'] });
      ids.pending = await document(db, a, { alpha_code: 'x1', beta_list: ['only-pending'] }, { publish: false });
      const lineage = nextName('lineage');
      ids.superseded = await document(db, a, { alpha_code: 'x9', beta_list: ['only-superseded'] }, { sourceKey: lineage });
      ids.successor = await document(db, a, { alpha_code: 'x9', beta_list: ['y9'] }, { sourceKey: lineage });
      if (b) ids.foreign = await document(db, b, { alpha_code: 'x1', beta_list: ['y1', 'only-foreign'], delta_text: 'foreign-delta' });
    });

    after(async () => {
      await db?.close();
    });

    test('the superseded fixture is not current and the pending one is not ready', async () => {
      const state = await rows(db, 'SELECT id, status, is_current FROM documents WHERE id = ANY ($1::uuid[])', [[ids.superseded, ids.pending]]);
      const byId = new Map(state.map((row) => [String(row.id), row]));
      assert.equal(byId.get(ids.superseded)?.is_current, false);
      assert.notEqual(byId.get(ids.pending)?.status, 'ready');
    });

    test('value read: one row per filterable key and value, lists unnested, ordered, own tenant, current and ready only', async () => {
      const found = await rows(db, VALUES_SQL, [a.key, 1000]);
      assert.deepEqual(
        found.map((row) => [row.key, row.value, row.type, row.soft]),
        [
          ['alpha_code', 'x1', 'code', false],
          ['alpha_code', 'x2', 'code', false],
          ['alpha_code', 'x9', 'code', false],
          ['beta_list', 'y1', 'text_list', false],
          ['beta_list', 'y2', 'text_list', false],
          ['beta_list', 'y3', 'text_list', false],
          ['beta_list', 'y9', 'text_list', false],
          ['delta_text', 'zeta-17', 'text', true],
        ],
      );
      const values = found.map((row) => String(row.value));
      for (const absent of ['hidden-g', 'only-pending', 'only-superseded', 'only-foreign', 'foreign-delta']) {
        assert.ok(!values.includes(absent), `value read returned a row it must not (${absent === 'only-foreign' || absent === 'foreign-delta' ? 'foreign tenant' : 'hidden'})`);
      }
    });

    test('value read honours the limit and refuses a limit below 1 or above the hard maximum', async () => {
      assert.equal((await rows(db, VALUES_SQL, [a.key, 3])).length, 3);
      for (const limit of [0, -1, 100001, null]) await malformed(db, VALUES_SQL, [a.key, limit]);
    });

    test('documents: any value of one key, every key, ascending ids, at most the limit', async () => {
      assert.deepEqual(await resolve(db, a.key, { alpha_code: ['x1', 'x2'] }), sorted([ids.x1, ids.x2, ids.x1y3]));
      assert.deepEqual(await resolve(db, a.key, { alpha_code: ['x1', 'x2'], beta_list: ['y1'] }), [ids.x1]);
      assert.deepEqual(await resolve(db, a.key, { alpha_code: ['x1'], beta_list: ['y3'] }), [ids.x1y3]);
      assert.deepEqual(await resolve(db, a.key, { delta_text: ['zeta-17'] }), [ids.x1]);
      assert.deepEqual(await resolve(db, a.key, { alpha_code: ['x1', 'x2'] }, 2), sorted([ids.x1, ids.x2, ids.x1y3]).slice(0, 2));
      assert.deepEqual(await resolve(db, a.key, { alpha_code: ['no-such-value'] }), []);
    });

    test('documents: stored values are compared exactly', async () => {
      assert.deepEqual(await resolve(db, a.key, { alpha_code: ['X1'] }), []);
      assert.deepEqual(await resolve(db, a.key, { alpha_code: [' x1'] }), []);
      assert.deepEqual(await resolve(db, a.key, { beta_list: ['y'] }), []);
    });

    test('documents: superseded, non-ready and foreign documents are never returned', async () => {
      assert.deepEqual(await resolve(db, a.key, { beta_list: ['only-pending'] }), []);
      assert.deepEqual(await resolve(db, a.key, { beta_list: ['only-superseded'] }), []);
      assert.deepEqual(await resolve(db, a.key, { alpha_code: ['x9'] }), [ids.successor]);
      const forA = await resolve(db, a.key, { alpha_code: ['x1'] });
      assert.ok(!forA.includes(ids.pending), 'a non-ready document was returned');
      if (b) {
        assert.ok(!forA.includes(ids.foreign), 'tenant B document returned for tenant A');
        assert.deepEqual(await resolve(db, a.key, { beta_list: ['only-foreign'] }), []);
        assert.deepEqual(await resolve(db, b.key, { alpha_code: ['x1'] }), [ids.foreign]);
        const bValues = (await rows(db, VALUES_SQL, [b.key, 1000])).map((row) => String(row.value));
        for (const value of ['x2', 'x9', 'y3', 'zeta-17']) assert.ok(!bValues.includes(value), 'tenant A value returned for tenant B');
      }
    });

    test('refusals: a non-filterable or unknown key raises unknown_attribute', async () => {
      for (const key of ['gamma_text', 'epsilon_unknown']) {
        const failed = await failure(db, DOCS_SQL, [a.key, JSON.stringify({ [key]: ['v'] }), 10]);
        assert.ok(failed !== null, 'expected unknown_attribute');
        assert.match(failed.message, /^unknown_attribute/);
        assert.equal(failed.code, '22023');
      }
      if (b) {
        await rows(db, "INSERT INTO public.rag_attribute_definitions (tenant_key, key, type, filterable) VALUES ($1, 'only_b_key', 'text', true) ON CONFLICT DO NOTHING", [
          b.key,
        ]);
        const failed = await failure(db, DOCS_SQL, [a.key, JSON.stringify({ only_b_key: ['v'] }), 10]);
        assert.match(failed?.message ?? '', /^unknown_attribute/);
      }
    });

    test('refusals: malformed filters and limits raise 22023', async () => {
      const bad: unknown[] = [
        [],
        'x',
        {},
        { alpha_code: 'x1' },
        { alpha_code: [] },
        { alpha_code: [1] },
        { alpha_code: [''] },
        { alpha_code: ['x'.repeat(201)] },
        { alpha_code: Array.from({ length: 51 }, (_, index) => `v${index}`) },
        Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`k${index}`, ['v']])),
      ];
      for (const filters of bad) await malformed(db, DOCS_SQL, [a.key, JSON.stringify(filters), 10]);
      await malformed(db, DOCS_SQL, [a.key, null, 10]);
      for (const limit of [0, 100001, null]) await malformed(db, DOCS_SQL, [a.key, JSON.stringify({ alpha_code: ['x1'] }), limit]);
      assert.equal((await resolve(db, a.key, { alpha_code: ['é'.repeat(200)] })).length, 0);
    });

    test('a tenant key of the other deployment mode is rejected', async () => {
      const otherMode = mode === 'multi-tenant' ? ['s:default'] : [`o:${ORG_A}`, `u:${ADMIN_A}`];
      for (const key of [...otherMode, 'not-a-key']) {
        assert.ok((await failure(db, VALUES_SQL, [key, 10])) !== null, 'value read accepted a foreign-mode key');
        assert.ok((await failure(db, DOCS_SQL, [key, JSON.stringify({ alpha_code: ['x1'] }), 10])) !== null, 'resolver accepted a foreign-mode key');
      }
    });

    test('anon and an authenticated JWT cannot execute either function', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        const values = await asRole(db, role, () => failure(db, VALUES_SQL, [a.key, 10]));
        const docs = await asRole(db, role, () => failure(db, DOCS_SQL, [a.key, JSON.stringify({ alpha_code: ['x1'] }), 10]));
        assert.equal(values?.code, '42501', `${role} executed the value read`);
        assert.equal(docs?.code, '42501', `${role} executed the resolver`);
      }
    });
  });
}

describe('migration 1008 catalog and idempotence', () => {
  for (const mode of ['multi-tenant', 'single-tenant'] as const) {
    test(`${mode}: INVOKER, STABLE, empty search_path, service_role only, the GIN index, and applying 1008 again leaves the schema unchanged`, async () => {
      const db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      try {
        for (const signature of FUNCTIONS) {
          const found = (
            await rows(
              db,
              `SELECT p.prosecdef AS definer, p.provolatile AS volatile, p.proconfig AS config,
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
          assert.equal(found.volatile, 's', `${signature} is STABLE`);
          assert.ok(Array.isArray(found.config) && (found.config as string[]).some((entry) => /^search_path=("")?$/.test(entry)), `${signature} search_path`);
          assert.deepEqual([found.anon, found.authenticated, found.public, found.service_role], [false, false, false, true], signature);
        }
        const index = await rows(db, "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_documents_attributes'");
        assert.equal(index.length, 1);
        assert.match(String(index[0]?.indexdef), /USING gin \(attributes jsonb_path_ops\)/);
        const dump = async () =>
          JSON.stringify(
            await rows(
              db,
              `SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p
               WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('rag_attribute_filter_values', 'rag_attribute_documents')
               UNION ALL SELECT indexname, indexdef, NULL FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'documents' ORDER BY 1`,
            ),
          );
        const first = await dump();
        await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
        assert.equal(await dump(), first);
        const hybrid = fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8');
        assert.doesNotMatch(hybrid, /^[^-]*FUNCTION public\.hybrid_search_chunks/m);
      } finally {
        await db.close();
      }
    });
  }
});

/**
 * Plan 03.3-19: the attribute filter through the eval route, two tenants, v2 pipeline. One child process per deployment mode, because the
 * app reads the deployment mode once at import (attribute-pipeline-run.mts seeds the family of 12 documents and prints a JSON report).
 */
interface PipelineSummary {
  ids: string[];
  docs: string[];
  legs: Record<string, string[]>;
  refused: boolean;
  search: Record<string, number>;
  attribute: Record<string, unknown> | null;
  familyDocs: number;
  foreign: string[];
  namedRank: number;
}

function runPipeline(mode: 'multi-tenant' | 'single-tenant'): Record<string, unknown> {
  const out = spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO_ROOT, 'tests/rag-db/attribute-pipeline-run.mts'), mode], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 300_000,
  });
  assert.equal(out.status, 0, `pipeline run (${mode}) failed: ${out.stderr.slice(-2000)}`);
  const line = out.stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

for (const mode of ['multi-tenant', 'single-tenant'] as const) {
  describe(`attribute filter through the v2 pipeline (${mode}, plan 03.3-19)`, () => {
    let report: Record<string, unknown>;
    const part = (name: string) => report[name] as PipelineSummary & Record<string, unknown>;

    before(() => {
      report = runPipeline(mode);
    });

    test('off: candidates hold chunks of several family documents and the trace has no attribute block', () => {
      const off = part('off');
      assert.ok(off.familyDocs > 1, `expected several family documents, got ${off.familyDocs}`);
      assert.equal(off.attribute, null);
    });

    test('hard: every candidate carries the named value, at exact-scan cutoff 0 and above 0 (dense counts printed)', () => {
      for (const name of ['hard', 'hardExact'] as const) {
        const run = part(name);
        assert.ok(run.ids.length > 0, `${name}: no candidate`);
        assert.equal(run.onlyNamed, true, `${name}: a candidate of another document`);
        assert.equal(run.search.attribute_filter_applied, 1);
        assert.equal(run.search.attribute_filter_fallback, 0);
        assert.ok((run.search.dense ?? 0) > 0 && (run.search.lexical ?? 0) > 0, `${name}: dense and lexical legs both narrowed and found the chunk`);
        assert.deepEqual(run.attribute, { mode: 'hard', explicit: false, matched_attributes: 1, resolved_documents: 1, applied: true, fallback: false, too_broad: false });
        console.log(`[03.3-19 dense counts] ${mode} ${name}: dense=${run.search.dense} lexical=${run.search.lexical}`);
      }
    });

    test('hard: a value no current document carries any more gives one fallback and the switch-off answer', () => {
      const fallback = report.fallback as { attribute: Record<string, unknown>; ids: string[]; refused: boolean; offIds: string[]; offRefused: boolean };
      assert.equal(fallback.attribute.fallback, true);
      assert.deepEqual(fallback.ids, fallback.offIds);
      assert.equal(fallback.refused, fallback.offRefused);
    });

    test('soft: the named document ranks at least as high as off, lists attr:0, and no similarity changes', () => {
      const soft = part('soft');
      const off = part('off');
      assert.ok(soft.namedRank >= 0, 'named document missing under soft');
      assert.ok(off.namedRank < 0 || soft.namedRank <= off.namedRank, `soft rank ${soft.namedRank} below off rank ${off.namedRank}`);
      const namedDoc = soft.docs[soft.namedRank]!;
      assert.ok(soft.legs[namedDoc]?.includes('attr:0'), 'the named candidate does not list attr:0');
      assert.equal(soft.sharedSimilarityDiffers, 0);
      assert.equal((soft.attribute as Record<string, unknown>).mode, 'soft');
    });

    test('explicit filter with the switch on: only documents carrying the value, also when the query names nothing; tiny cap is too broad', () => {
      const explicit = part('explicit');
      assert.ok(explicit.ids.length > 0);
      assert.equal(explicit.onlyNamed, true);
      assert.equal((explicit.attribute as Record<string, unknown>).explicit, true);
      const tooBroad = part('tooBroad');
      assert.equal((tooBroad.attribute as Record<string, unknown>).too_broad, true);
      assert.equal(tooBroad.allowedOnly, true);
      assert.ok(tooBroad.familyDocs <= 2, 'the explicit filter widened beyond the capped ids');
    });

    test('a query naming no value: candidate ids and order equal the off run', () => {
      const plain = report.plain as { offIds: string[]; hardIds: string[] };
      assert.deepEqual(plain.hardIds, plain.offIds);
    });

    test('a hard-filtered unrelated question never ends in a knowledge-base error', () => {
      const unrelated = report.unrelated as { errorStages: string[] };
      assert.deepEqual(unrelated.errorStages, []);
    });

    if (mode === 'multi-tenant') {
      test("tenant B naming tenant A's value resolves nothing and sees no chunk of tenant A", () => {
        const crossed = part('crossTenant') as PipelineSummary & { aChunks: string[] };
        assert.equal((crossed.attribute as Record<string, unknown>).matched_attributes, 0);
        assert.deepEqual(crossed.aChunks, [], `foreign chunk ids: ${crossed.aChunks.join(',')}`);
      });
    }
  });
}
