import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { createFixtureDatabase, seedTerminology, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

// Synthetic, neutral vocabulary only: one invented two-word Latin term per tenant, one invented identifier shape.
const TERM_A = 'zento prisma';
const TERM_B = 'falto rimbo';
const TOKEN_A = '_t_zento_prisma';
const TOKEN_B = '_t_falto_rimbo';
const PATTERN = 'QV [0-9]{3}';
const IDENT_TEXT = 'QV 123';
const IDENT_TOKEN = 'qv123';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const TENANT_O = `o:${TWO_TENANT_IDS.orgO}`;
const CANARIES = [TWO_TENANT_IDS.chunkA, TWO_TENANT_IDS.chunkB, TWO_TENANT_IDS.chunkO];
const SENTENCE = `Shared canary sentence with ${TERM_A}, ${TERM_B} and ${IDENT_TEXT} in it.`;

type Row = Record<string, unknown>;

function pgliteRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM ${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const run = db
        .query<Row>(sql, keys.map((key) => args[key]))
        .then((result): RpcResponse => ({ data: result.rows as unknown[], error: null }))
        .catch((error: unknown): RpcResponse => ({ data: null, error: { code: (error as { code?: string }).code ?? 'P0001', message: error instanceof Error ? error.message : String(error) } }));
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated', run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

interface Harness {
  relex: typeof import('@/lib/rag/ingest/relex/run');
  cli: typeof import('@/lib/rag/ingest/relex/cli');
  ragDeps: typeof import('@/lib/rag/deps');
  ingestDeps: typeof import('@/lib/rag/ingest/deps');
  terminology: typeof import('@/lib/rag/terminology/load');
  patterns: typeof import('@/lib/rag/identifiers/patterns');
  scope: typeof import('@/lib/rag/tenant/scope');
  config: typeof import('@/lib/rag/config');
}

async function harness(): Promise<Harness> {
  return {
    relex: await import('@/lib/rag/ingest/relex/run'),
    cli: await import('@/lib/rag/ingest/relex/cli'),
    ragDeps: await import('@/lib/rag/deps'),
    ingestDeps: await import('@/lib/rag/ingest/deps'),
    terminology: await import('@/lib/rag/terminology/load'),
    patterns: await import('@/lib/rag/identifiers/patterns'),
    scope: await import('@/lib/rag/tenant/scope'),
    config: await import('@/lib/rag/config'),
  };
}

function scopeFor(h: Harness, key: string) {
  if (key === 's:default') return h.scope.mintScope('single', null, null);
  if (key.startsWith('o:')) return h.scope.mintScope('org', null, key.slice(2));
  return h.scope.mintScope('personal', key.slice(2), null);
}

describe('rag:relex with the lexical dictionary and identifier patterns (multi-tenant, two tenants)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let h: Harness;
  let env: Record<string, string> = {};
  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const db = () => pgliteRpc(fixture.db);
  const config = () => h.config.loadRagConfig(env);
  const run = (input: Partial<Parameters<Harness['relex']['runRelex']>[0]> = {}) =>
    h.relex.runRelex({ db: db(), config: config(), resolveScope: async (key: string) => ({ ok: true as const, scope: scopeFor(h, key) }), ...input });
  const chunk = async (id: string) => (await rows('SELECT lexical_text, lexical_version, lexical_dict_version, metadata FROM document_chunks WHERE id = $1', [id]))[0]!;
  const currentCount = async (tenant: string) =>
    Number((await rows("SELECT count(*)::int AS n FROM document_chunks WHERE tenant_key = $1 AND is_current AND status = 'ready'", [tenant]))[0]?.n);

  before(async () => {
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    h = await harness();
    await fixture.db.query('UPDATE document_chunks SET content = content || $2 WHERE id = ANY($1::uuid[])', [CANARIES, ` ${SENTENCE}`]);
    await seedTerminology(fixture.db, [
      { layer: TENANT_A, canonical: TERM_A, variants: [TERM_A], language: 'en', kind: 'synonym', mode: 'equivalent' },
      { layer: TENANT_B, canonical: TERM_B, variants: [TERM_B], language: 'en', kind: 'synonym', mode: 'equivalent' },
    ]);
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(() => {
    h.ragDeps.setRagDepsForTests({ adminClient: () => pgliteRpc(fixture.db) as never });
    h.ingestDeps.setIngestDepsForTests({ db: () => pgliteRpc(fixture.db) });
    h.terminology.invalidateTerminologyCache('all');
    h.patterns.resetIdentifierPatternCacheForTests();
  });

  afterEach(() => {
    h.ragDeps.resetRagDepsForTests();
    h.ingestDeps.resetIngestDepsForTests();
  });

  test('chunks written before the switch carry no dictionary stamp', async () => {
    const stamped = await rows('SELECT count(*)::int AS n FROM document_chunks WHERE lexical_dict_version IS NOT NULL');
    assert.equal(stamped[0]?.n, 0);
  });

  test('--stale-dictionary --tenant A rewrites exactly tenant A, with A terms only; tenant B is untouched', async () => {
    env = { RAG_LEXICAL_DICTIONARY: 'true' };
    const before = { b: await chunk(TWO_TENANT_IDS.chunkB), o: await chunk(TWO_TENANT_IDS.chunkO) };
    const expected = await currentCount(TENANT_A);
    assert.ok(expected >= 1);
    const report = await run({ tenantKey: TENANT_A, staleDictionary: true });
    assert.equal(report.updated, expected, `expected ${expected} rewritten, got ${report.updated}`);
    assert.deepEqual(Object.keys(report.tenants), [TENANT_A]);
    const a = await chunk(TWO_TENANT_IDS.chunkA);
    const tokens = String(a.lexical_text).split(' ');
    assert.ok(tokens.includes(TOKEN_A), 'A term token present');
    assert.ok(!tokens.includes(TOKEN_B), 'B term never used for A');
    assert.equal(a.lexical_dict_version, 's0.w1');
    assert.equal((a.metadata as Row).lexical_dict_version, 's0.w1');
    assert.equal(a.lexical_version, 3);
    assert.deepEqual(await chunk(TWO_TENANT_IDS.chunkB), before.b);
    assert.deepEqual(await chunk(TWO_TENANT_IDS.chunkO), before.o);
  });

  test('the lexical leg finds the rewritten chunk by its dictionary token', async () => {
    const hit = await rows('SELECT count(*)::int AS n FROM document_chunks WHERE id = $1 AND lexical_tsv @@ public.rag_lexical_tsquery($2::text[])', [
      TWO_TENANT_IDS.chunkA,
      [TOKEN_A],
    ]);
    assert.equal(hit[0]?.n, 1);
  });

  test('a second run rewrites zero; a new tenant dictionary version rewrites again', async () => {
    env = { RAG_LEXICAL_DICTIONARY: 'true' };
    assert.equal((await run({ tenantKey: TENANT_A, staleDictionary: true })).updated, 0);
    await fixture.db.query('UPDATE public.rag_term_layers SET version = 2 WHERE layer_key = $1', [TENANT_A]);
    h.terminology.invalidateTerminologyCache('all');
    const expected = await currentCount(TENANT_A);
    assert.equal((await run({ tenantKey: TENANT_A, staleDictionary: true })).updated, expected);
    assert.equal((await chunk(TWO_TENANT_IDS.chunkA)).lexical_dict_version, 's0.w2');
  });

  test('rag_lexical_stale_count counts the tenant chunks whose stamp differs and rejects a key of the other mode', async () => {
    const count = async (tenant: string, version: string | null) =>
      Number((await rows('SELECT public.rag_lexical_stale_count($1, $2) AS n', [tenant, version]))[0]?.n);
    assert.equal(await count(TENANT_A, 's0.w2'), 0);
    assert.equal(await count(TENANT_A, 's0.w9'), await currentCount(TENANT_A));
    assert.equal(await count(TENANT_B, 's0.w1'), await currentCount(TENANT_B));
    await assert.rejects(() => rows('SELECT public.rag_lexical_stale_count($1, $2)', ['s:default', 's0.w1']));
  });

  test('--stale-dictionary without --tenant is a usage error (exit 2)', async () => {
    const parsed = h.cli.parseRelexArgs(['--stale-dictionary']);
    assert.equal(parsed.ok, false);
    const err: string[] = [];
    const code = await h.cli.main(['--stale-dictionary'], { out: () => undefined, err: (line) => err.push(line) });
    assert.equal(code, 2);
    assert.ok(err.some((line) => line.includes('--stale-dictionary')));
    const ok = h.cli.parseRelexArgs(['--tenant', TENANT_A, '--stale-dictionary']);
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && ok.staleDictionary, true);
    assert.ok(h.cli.USAGE.includes('--stale-dictionary'));
  });

  test('identifier index: a new tenant pattern makes plain relex --tenant A rewrite A chunks once', async () => {
    env = { RAG_LEXICAL_DICTIONARY: 'true', RAG_IDENTIFIER_INDEX: 'true' };
    const first = await run({ tenantKey: TENANT_A });
    assert.equal(first.updated, await currentCount(TENANT_A), 'the empty-list fingerprint is stamped first');
    assert.ok(!String((await chunk(TWO_TENANT_IDS.chunkA)).lexical_text).split(' ').includes(IDENT_TOKEN));
    await fixture.db.query('SELECT * FROM public.rag_identifier_pattern_create($1, $2, $3, $4, $5, NULL)', [TENANT_A, 'qv', PATTERN, 'iu', true]);
    h.patterns.resetIdentifierPatternCacheForTests();
    const second = await run({ tenantKey: TENANT_A });
    assert.equal(second.updated, await currentCount(TENANT_A));
    const a = await chunk(TWO_TENANT_IDS.chunkA);
    assert.ok(String(a.lexical_text).split(' ').includes(IDENT_TOKEN), 'the tenant-pattern identifier is one lexical token');
    assert.match(String((a.metadata as Row).lexical_patterns), /^p[0-9a-f]{12}$/u);
    assert.equal(a.lexical_dict_version, 's0.w2', 'the dictionary stamp is kept');
    assert.equal((await run({ tenantKey: TENANT_A })).updated, 0);
    assert.ok(!String((await chunk(TWO_TENANT_IDS.chunkB)).lexical_text).split(' ').includes(IDENT_TOKEN));
  });

  test('stemming on: plain relex rewrites every current ready chunk whose lexical_version differs from 4', async () => {
    env = { RAG_LEXICAL_STEM_IT: 'true' };
    const stale = Number((await rows("SELECT count(*)::int AS n FROM document_chunks WHERE is_current AND status = 'ready' AND lexical_version IS DISTINCT FROM 4"))[0]?.n);
    assert.ok(stale > 3);
    const report = await run();
    assert.equal(report.updated, stale);
    const left = await rows("SELECT count(*)::int AS n FROM document_chunks WHERE is_current AND status = 'ready' AND lexical_version IS DISTINCT FROM 4");
    assert.equal(left[0]?.n, 0);
    assert.equal((await run()).updated, 0);
  });

  test('the new functions are service_role only, SECURITY INVOKER with an empty search_path', async () => {
    const signatures = [
      'public.rag_relex_candidates_stamped(uuid, integer, integer, text, text, text, boolean)',
      'public.rag_relex_batch_stamped(jsonb, integer, text)',
      'public.rag_lexical_stale_count(text, text)',
    ];
    for (const signature of signatures) {
      const meta = await rows('SELECT prosecdef AS secdef, proconfig AS config FROM pg_proc WHERE oid = $1::regprocedure', [signature]);
      assert.equal(meta[0]?.secdef, false, `${signature} is SECURITY INVOKER`);
      assert.ok(((meta[0]?.config as string[] | null) ?? []).includes('search_path=""'), `${signature} has an empty search_path`);
    }
    for (const role of ['anon', 'authenticated'] as const) {
      await assert.rejects(
        () => asRole(fixture.db, role, () => fixture.db.query('SELECT public.rag_lexical_stale_count($1, $2)', [TENANT_A, 's0.w1'])),
        (error: unknown) => (error as { code?: string }).code === '42501',
      );
      await assert.rejects(
        () => asRole(fixture.db, role, () => fixture.db.query('SELECT * FROM public.rag_relex_candidates_stamped(NULL, 2, 10, $1, NULL, NULL, false)', [TENANT_A])),
        (error: unknown) => (error as { code?: string }).code === '42501',
      );
      await assert.rejects(
        () => asRole(fixture.db, role, () => fixture.db.query("SELECT public.rag_relex_batch_stamped('[]'::jsonb, 2, $1)", [TENANT_A])),
        (error: unknown) => (error as { code?: string }).code === '42501',
      );
    }
  });

  test('the stamped writer never touches another tenant chunk', async () => {
    const beforeB = await chunk(TWO_TENANT_IDS.chunkB);
    const written = await rows('SELECT public.rag_relex_batch_stamped($1::jsonb, 3, $2) AS n', [
      JSON.stringify([{ id: TWO_TENANT_IDS.chunkB, lexical_text: 'overwritten', lexical_dict_version: 's0.w1' }]),
      TENANT_A,
    ]);
    assert.equal(written[0]?.n, 0);
    assert.deepEqual(await chunk(TWO_TENANT_IDS.chunkB), beforeB);
  });

  test('applying 0859 again leaves the functions unchanged', async () => {
    const dump = async () =>
      rows("SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p WHERE p.proname IN ('rag_relex_candidates_stamped','rag_relex_batch_stamped','rag_lexical_stale_count') ORDER BY 1");
    const first = await dump();
    const fs = await import('node:fs');
    await fixture.db.exec(fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0859_relex_dictionary.sql'), 'utf8'));
    assert.deepEqual(await dump(), first);
    assert.equal(first.length, 3);
  });

  test(`tenants beyond A and B (${TENANT_O}) keep their text through the tenant runs`, async () => {
    assert.ok(!String((await chunk(TWO_TENANT_IDS.chunkO)).lexical_text).split(' ').includes(TOKEN_A));
  });
});

describe('rag:relex --stale-dictionary (single-tenant)', () => {
  let fixture: FixtureDatabase;
  let edge: FakeEdge;
  let h: Harness;
  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  before(async () => {
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS });
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    h = await harness();
    const id = (await rows("SELECT id FROM document_chunks WHERE is_current AND status = 'ready' ORDER BY id LIMIT 1"))[0]!.id;
    await fixture.db.query('UPDATE document_chunks SET content = content || $2 WHERE id = $1', [id, ` ${SENTENCE}`]);
    await seedTerminology(fixture.db, [{ layer: 'shared', canonical: TERM_A, variants: [TERM_A], language: 'en', kind: 'synonym', mode: 'equivalent' }]);
    h.ragDeps.setRagDepsForTests({ adminClient: () => pgliteRpc(fixture.db) as never });
    h.ingestDeps.setIngestDepsForTests({ db: () => pgliteRpc(fixture.db) });
    h.terminology.invalidateTerminologyCache('all');
  });

  after(async () => {
    h?.ragDeps.resetRagDepsForTests();
    h?.ingestDeps.resetIngestDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  test('rewrites every current ready chunk once with the shared dictionary version, then zero', async () => {
    const total = Number((await rows("SELECT count(*)::int AS n FROM document_chunks WHERE is_current AND status = 'ready'"))[0]?.n);
    const input = {
      db: pgliteRpc(fixture.db),
      config: h.config.loadRagConfig({ RAG_LEXICAL_DICTIONARY: 'true' }),
      tenantKey: 's:default',
      staleDictionary: true,
      resolveScope: async (key: string) => ({ ok: true as const, scope: scopeFor(h, key) }),
    };
    assert.equal((await h.relex.runRelex(input)).updated, total);
    const stamped = await rows("SELECT count(*)::int AS n FROM document_chunks WHERE lexical_dict_version = 's1'");
    assert.equal(stamped[0]?.n, total);
    const withToken = await rows('SELECT count(*)::int AS n FROM document_chunks WHERE $1 = ANY(string_to_array(lexical_text, $2))', [TOKEN_A, ' ']);
    assert.ok(Number(withToken[0]?.n) >= 1);
    assert.equal((await h.relex.runRelex(input)).updated, 0);
    assert.equal(Number((await rows("SELECT public.rag_lexical_stale_count('s:default', 's1') AS n"))[0]?.n), 0);
    await assert.rejects(() => rows('SELECT public.rag_lexical_stale_count($1, $2)', [`u:${TWO_TENANT_IDS.userA}`, 's1']));
  });
});
