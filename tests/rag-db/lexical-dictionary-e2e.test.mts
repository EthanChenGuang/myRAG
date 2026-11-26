import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { seedTerminology } from '../../eval/harness/pglite-supabase.mts';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';

/**
 * LANG-07 query side end to end (04.2-22, D-08, D-09, D-34): a tenant's multi-character Han term matches as one `_t_` token after
 * `rag:relex --stale-dictionary`, Italian singular and plural meet through `_s_` tokens with stemming on, another tenant's dictionary
 * is never applied, and with every switch off nothing changes. Each deployment mode runs in its own child process (the route binds one
 * mode per process). All words are invented.
 */
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';
const MODE_ENV = 'LEXICAL_DICTIONARY_E2E_MODE';
const MODE = process.env[MODE_ENV];

const TERM_A = '零星样拓';
const TERM_B = '孚瑟岚缇';
const TOKEN_A = `_t_${TERM_A}`;
const HAN_TEXT = `本节记录${TERM_A}的保存方式和检查周期。`;
const HAN_QUESTION = `请问${TERM_A}的说明在哪里？`;
const IT_CHUNK = 'Elenco: brendali, quorvate, sminelli.';
const IT_QUESTION = 'Dove si trova il brendalo?';
const ALL_OFF = { RAG_LEXICAL_DICTIONARY: 'false', RAG_LEXICAL_STEM_IT: 'false', RAG_IDENTIFIER_INDEX: 'false' };

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string | null;
  hanChunk: string;
  itChunk: string;
}

interface TraceBody {
  candidates: Array<{ chunk_id: string }>;
  retrieval_config_hash: string | null;
}

interface Captured {
  request: BackendSearchRequest;
  legs: BackendLegs;
}

function pgliteRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM ${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const run = db
        .query<Row>(sql, keys.map((key) => args[key]))
        .then((result): RpcResponse => ({ data: result.rows as unknown[], error: null }))
        .catch((error: unknown): RpcResponse => ({ data: null, error: { code: (error as { code?: string }).code ?? 'P0001', message: error instanceof Error ? error.message : String(error) } }));
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

if (MODE === undefined) {
  describe('query-side lexical dictionary end to end in both deployment modes', () => {
    for (const mode of ['single-tenant', 'multi-tenant'] as const) {
      test(mode, () => {
        const { NODE_TEST_CONTEXT: _context, ...parentEnv } = process.env;
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', SELF], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...parentEnv, [MODE_ENV]: mode },
          timeout: 600_000,
        });
        const output = `${result.stdout}\n${result.stderr}`;
        const failures = output.split('\n').filter((line) => /not ok|AssertionError|expected|actual|Error/.test(line)).slice(0, 80).join('\n');
        assert.equal(result.status, 0, failures || output.slice(-2000));
        assert.ok(Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? '0') > 0, `the child ran no tests:\n${output.slice(-2000)}`);
        assert.match(output, /^# fail 0$/m);
      });
    }
  });
} else {
  const mode = MODE as 'single-tenant' | 'multi-tenant';
  const multi = mode === 'multi-tenant';
  let prepared: InProcessEval;
  let twoTenant: TwoTenantDatabase | undefined;
  let db: PGlite;
  let configModule: typeof import('../../src/lib/rag/config.ts');
  let lexicalText: typeof import('../../src/lib/rag/lexical/tokenize.ts')['lexicalText'];
  let queryLexicalTokens: typeof import('../../src/lib/rag/lexical/tokenize.ts')['queryLexicalTokens'];
  const tenants: Tenant[] = [];
  const captured: Captured[] = [];

  const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

  async function insertChunk(tenant: Pick<Tenant, 'key' | 'userId'>, filename: string, text: string, language: string): Promise<string> {
    const doc = crypto.randomUUID();
    const chunk = crypto.randomUUID();
    const columns: [string, unknown][] = [
      ['id', doc],
      ['filename', filename],
      ['content', text],
      ['lineage_id', doc],
      ['is_current', true],
      ['status', 'ready'],
      ['content_hash', sha(`${tenant.key}:${text}`)],
      ...(tenant.userId ? [['user_id', tenant.userId] as [string, unknown]] : []),
    ];
    await db.query(
      `INSERT INTO documents (${columns.map(([name]) => name).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      columns.map(([, value]) => value),
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, chunk_index, provisional, content_hash, language)
       VALUES ($1, $2, $3, $4::vector, $5, $6, true, 'ready', 0, false, $7, $8)`,
      [chunk, doc, text, `[${embedText(text).join(',')}]`, lexicalText([], text), tenant.key, sha(`${tenant.key}:${text}`), language],
    );
    return chunk;
  }

  async function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    configModule.resetRagConfigForTests();
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      configModule.resetRagConfigForTests();
    }
  }

  async function tenantScope(tenant: Pick<Tenant, 'userId'>) {
    const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
    return tenant.userId ? mintScope('personal', tenant.userId, null) : mintScope('single', null, null);
  }

  async function retrieve(tenant: Tenant, query: string, env: Record<string, string>) {
    captured.length = 0;
    const { runRetrieval } = await import('../../src/lib/rag/index.ts');
    const result = await withEnv(env, async () =>
      runRetrieval({ scope: await tenantScope(tenant), query, profile: 'eval', signal: new AbortController().signal, options: { ragMode: 'balanced' } }),
    );
    const original = captured.find((entry) => entry.request.denseVector !== null && entry.request.lexicalTokens.length > 0) ?? captured[0];
    assert.ok(original, 'the backend was searched');
    return { result, tokens: original.request.lexicalTokens, lexical: original.legs.lexical.map((hit) => hit.chunkId), detail: result.stages.find((stage) => stage.name === 'search')?.detail ?? '' };
  }

  async function postEval(tenant: Tenant, query: string, env: Record<string, string>): Promise<TraceBody> {
    return withEnv(env, async () => {
      const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
        body: JSON.stringify({ schema_version: 1, query, rag_mode: 'balanced', options: tenant.userId ? { user_id: tenant.userId } : {} }),
      });
      const res = await prepared.POST(req);
      const json = (await res.json()) as TraceBody;
      assert.equal(res.status, 200, JSON.stringify(json).slice(0, 400));
      return json;
    });
  }

  async function relex(tenant: Tenant, env: Record<string, string>, staleDictionary: boolean) {
    const [{ runRelex }, ingestDeps, scopeModule, terminology] = await Promise.all([
      import('../../src/lib/rag/ingest/relex/run.ts'),
      import('../../src/lib/rag/ingest/deps.ts'),
      import('../../src/lib/rag/tenant/scope.ts'),
      import('../../src/lib/rag/terminology/load.ts'),
    ]);
    terminology.invalidateTerminologyCache('all');
    ingestDeps.setIngestDepsForTests({ db: () => pgliteRpc(db) });
    try {
      const scopeFor = (key: string) =>
        key === 's:default' ? scopeModule.mintScope('single', null, null) : scopeModule.mintScope('personal', key.slice(2), null);
      return await runRelex({
        db: pgliteRpc(db),
        config: configModule.loadRagConfig(env),
        resolveScope: async (key: string) => ({ ok: true as const, scope: scopeFor(key) }),
        tenantKey: tenant.key,
        ...(staleDictionary ? { staleDictionary: true } : {}),
      });
    } finally {
      ingestDeps.resetIngestDepsForTests();
    }
  }

  const rankIn = (ids: string[], id: string) => (ids.includes(id) ? ids.indexOf(id) : Number.POSITIVE_INFINITY);

  before(async () => {
    if (multi) {
      twoTenant = await createTwoTenantDatabase();
      db = twoTenant.db;
    }
    prepared = await prepareInProcessEval({
      corpusDir: CORPUS_DIR,
      deploymentMode: mode,
      ...(twoTenant ? { ingestFixture: twoTenant, allowedScopes: [`user:${TWO_TENANT_IDS.userA}`, `user:${TWO_TENANT_IDS.userB}`] } : {}),
      envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RERANKER: 'none' },
    });
    if (!multi) db = prepared.fixtureDb as PGlite;
    configModule = await import('../../src/lib/rag/config.ts');
    ({ lexicalText, queryLexicalTokens } = await import('../../src/lib/rag/lexical/tokenize.ts'));
    const registry = await import('../../src/lib/rag/backend/registry.ts');
    const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
    registry.resetRetrievalBackendForTests();
    resetV2StartupForTests();
    await verifyV2Startup();
    const real = registry.getRetrievalBackend();
    const spy: RetrievalBackend = {
      ...real,
      id: real.id,
      async search(request) {
        const legs = await real.search(request);
        captured.push({ request, legs });
        return legs;
      },
      health: () => real.health(),
      isReady: () => real.isReady(),
    };
    registry.setRetrievalBackendForTests(spy);

    const seeds: Array<Pick<Tenant, 'key' | 'userId'> & { label: string }> = multi
      ? [
          { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA, label: 'a' },
          { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB, label: 'b' },
        ]
      : [{ key: 's:default', userId: null, label: 'a' }];
    for (const seed of seeds) {
      tenants.push({
        key: seed.key,
        userId: seed.userId,
        hanChunk: await insertChunk(seed, `generated-${seed.label}-han.md`, HAN_TEXT, 'zh'),
        itChunk: await insertChunk(seed, `generated-${seed.label}-it.md`, IT_CHUNK, 'it'),
      });
    }
    await seedTerminology(db, [
      { layer: multi ? tenants[0]!.key : 'shared', canonical: TERM_A, variants: [TERM_A], language: 'zh', kind: 'synonym', mode: 'equivalent' },
      ...(multi ? [{ layer: tenants[1]!.key, canonical: TERM_B, variants: [TERM_B], language: 'zh', kind: 'synonym', mode: 'equivalent' as const }] : []),
    ]);
  });

  after(async () => {
    const registry = await import('../../src/lib/rag/backend/registry.ts');
    registry.resetRetrievalBackendForTests();
    await prepared?.close();
    await twoTenant?.db.close().catch(() => undefined);
  });

  describe(`query-side lexical dictionary through the eval route (${mode})`, () => {
    const dictOn = { RAG_LEXICAL_DICTIONARY: 'true', RAG_LEXICAL_STEM_IT: 'false', RAG_IDENTIFIER_INDEX: 'false' };
    let offBefore: TraceBody;
    let rankBefore = Number.POSITIVE_INFINITY;

    test('before relex: the dictionary token leads the question and the chunk is still found by its other tokens', async () => {
      const own = tenants[0]!;
      offBefore = await postEval(own, HAN_QUESTION, ALL_OFF);
      const searched = await retrieve(own, HAN_QUESTION, dictOn);
      assert.equal(searched.tokens[0], TOKEN_A);
      assert.ok(searched.lexical.includes(own.hanChunk), 'the not yet relexed chunk is never excluded');
      rankBefore = rankIn(searched.lexical, own.hanChunk);
      assert.match(searched.detail, /dict=s\d+(\.w\d+)? stale_chunks=\d+/);
      assert.ok(!searched.detail.includes(TERM_A), 'the detail never carries a term');
    });

    test('after rag:relex --stale-dictionary the chunk matches through the _t_ token, at least as well', async () => {
      const own = tenants[0]!;
      const report = await relex(own, { RAG_LEXICAL_DICTIONARY: 'true' }, true);
      assert.ok(report.updated >= 1, JSON.stringify(report));
      const stored = (await db.query<Row>('SELECT lexical_text FROM document_chunks WHERE id = $1', [own.hanChunk])).rows[0]!;
      assert.ok(String(stored.lexical_text).split(' ').includes(TOKEN_A));
      const only = await db.query<Row>('SELECT count(*)::int AS n FROM document_chunks WHERE id = $1 AND lexical_tsv @@ public.rag_lexical_tsquery($2::text[])', [
        own.hanChunk,
        [TOKEN_A],
      ]);
      assert.equal(only.rows[0]?.n, 1, 'the single _t_ token finds the chunk');
      const { resetLexicalStaleCountForTests } = await import('../../src/lib/rag/v2/stages/search.ts');
      resetLexicalStaleCountForTests();
      const searched = await retrieve(own, HAN_QUESTION, dictOn);
      assert.equal(searched.tokens[0], TOKEN_A);
      assert.ok(rankIn(searched.lexical, own.hanChunk) <= rankBefore, `rank ${rankIn(searched.lexical, own.hanChunk)} after, ${rankBefore} before`);
      assert.match(searched.detail, /stale_chunks=\d+/);
    });

    test('the dictionary version is in the config hash only while the switch is on', async () => {
      const own = tenants[0]!;
      const on = await postEval(own, HAN_QUESTION, dictOn);
      const off = await postEval(own, HAN_QUESTION, ALL_OFF);
      assert.ok(on.retrieval_config_hash && off.retrieval_config_hash);
      assert.notEqual(on.retrieval_config_hash, off.retrieval_config_hash);
    });

    test('with every switch off the tokens, candidates and hash equal the run before relex', async () => {
      const own = tenants[0]!;
      const off = await postEval(own, HAN_QUESTION, ALL_OFF);
      assert.deepEqual(off.candidates.map((row) => row.chunk_id), offBefore.candidates.map((row) => row.chunk_id));
      assert.equal(off.retrieval_config_hash, offBefore.retrieval_config_hash);
      const searched = await retrieve(own, HAN_QUESTION, ALL_OFF);
      assert.deepEqual(searched.tokens, queryLexicalTokens(HAN_QUESTION));
      assert.ok(!searched.detail.includes('dict='));
    });

    if (multi) {
      test("another tenant's question never gets tenant A's dictionary token or chunk", async () => {
        const [a, b] = [tenants[0]!, tenants[1]!];
        const searched = await retrieve(b, HAN_QUESTION, dictOn);
        assert.ok(!searched.tokens.some((token) => token.startsWith('_t_')), JSON.stringify(searched.tokens));
        assert.ok(!searched.lexical.includes(a.hanChunk));
        const json = await postEval(b, HAN_QUESTION, dictOn);
        const aChunks = new Set([a.hanChunk, a.itChunk, TWO_TENANT_IDS.chunkA]);
        assert.ok(!json.candidates.some((row) => aChunks.has(row.chunk_id)), 'no tenant A chunk');
        assert.ok(searched.lexical.includes(b.hanChunk), "tenant B's own chunk is found");
      });
    }

    test('with stemming on after relex an Italian singular matches the plural through the lexical leg; off it does not', async () => {
      const own = tenants[0]!;
      const stemOn = { RAG_LEXICAL_DICTIONARY: 'true', RAG_LEXICAL_STEM_IT: 'true', RAG_IDENTIFIER_INDEX: 'false' };
      const report = await relex(own, stemOn, false);
      assert.ok(report.updated >= 1, JSON.stringify(report));
      const on = await retrieve(own, IT_QUESTION, stemOn);
      assert.ok(on.tokens.includes('_s_brendal'), JSON.stringify(on.tokens));
      assert.ok(on.lexical.includes(own.itChunk), 'stemmed match on the lexical leg');
      const off = await retrieve(own, IT_QUESTION, ALL_OFF);
      assert.ok(!off.lexical.includes(own.itChunk), 'no lexical match without stemming');
    });
  });
}
