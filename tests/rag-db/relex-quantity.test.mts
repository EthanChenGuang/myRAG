import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { seedTerminology } from '../../eval/harness/pglite-supabase.mts';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';

/**
 * TPL-07 end to end (plan 03.3-21, D-31..D-33): with RAG_LEXICAL_QUANTITY on, `rag:relex` selects every current, ready chunk whose
 * stamped version lacks the quantity bit, writes `_q_` tokens and stamps the effective version; a second run rewrites nothing; `--tenant`
 * keeps other tenants untouched; turning the switch off again and relexing restores the text byte for byte. Through the v2 pipeline a
 * question writing `2,5 kg` meets, on the lexical leg, the chunk writing `2.5kg`. Each deployment mode runs in its own child process.
 * Numbers, general symbols and invented words only.
 */
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODE_ENV = 'RELEX_QUANTITY_E2E_MODE';
const MODE = process.env[MODE_ENV];

const CHUNK_TEXT = 'Il zorbel misura 2.5kg in tutto.';
const QUESTION = 'Quanto vale 2,5 kg nel quorvo?';
const Q_TOKEN = '_q_2.5kg';
const ALIAS_QUESTION = 'Totale 3 dumbaro nel quorvo';
const ALIAS_TOKEN = '_q_3ml';
const ALL_OFF = { RAG_LEXICAL_DICTIONARY: 'false', RAG_LEXICAL_STEM_IT: 'false', RAG_IDENTIFIER_INDEX: 'false', RAG_LEXICAL_QUANTITY: 'false' };
const QUANTITY_ON = { ...ALL_OFF, RAG_LEXICAL_QUANTITY: 'true' };
const RECALIBRATE = 'python -m rag_eval.calibrate refusal';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string | null;
  chunk: string;
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
  describe('quantity relex and query end to end in both deployment modes', () => {
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
  let tokenize: typeof import('../../src/lib/rag/lexical/tokenize.ts');
  const tenants: Tenant[] = [];
  const captured: Captured[] = [];
  let baseline = new Map<string, Row>();

  const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query<Row>(sql, params)).rows;
  const snapshot = async (): Promise<Map<string, Row>> =>
    new Map(
      (await rows("SELECT id, lexical_text, lexical_version, metadata FROM document_chunks WHERE is_current AND status = 'ready' ORDER BY id")).map((row) => [
        String(row.id),
        row,
      ]),
    );
  const currentCount = async (tenant: string | null) =>
    Number(
      (await rows("SELECT count(*)::int AS n FROM document_chunks WHERE is_current AND status = 'ready' AND ($1::text IS NULL OR tenant_key = $1)", [tenant]))[0]?.n,
    );

  async function insertChunk(tenant: Pick<Tenant, 'key' | 'userId'>, filename: string, text: string): Promise<string> {
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
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, lexical_version, tenant_key, is_current, status, chunk_index, provisional, content_hash, language)
       VALUES ($1, $2, $3, $4::vector, $5, 1, $6, true, 'ready', 0, false, $7, 'it')`,
      [chunk, doc, text, `[${embedText(text).join(',')}]`, tokenize.lexicalText([], text), tenant.key, sha(`${tenant.key}:${text}`)],
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
    const terminology = await import('../../src/lib/rag/terminology/load.ts');
    terminology.invalidateTerminologyCache('all');
    const result = await withEnv(env, async () =>
      runRetrieval({ scope: await tenantScope(tenant), query, profile: 'eval', signal: new AbortController().signal, options: { ragMode: 'balanced' } }),
    );
    const original = captured.find((entry) => entry.request.denseVector !== null && entry.request.lexicalTokens.length > 0) ?? captured[0];
    assert.ok(original, 'the backend was searched');
    return { result, tokens: original.request.lexicalTokens, lexical: original.legs.lexical.map((hit) => hit.chunkId) };
  }

  async function relexInput(env: Record<string, string>, tenantKey: string | null, lines: string[]) {
    const scopeModule = await import('../../src/lib/rag/tenant/scope.ts');
    const scopeFor = (key: string) =>
      key === 's:default' ? scopeModule.mintScope('single', null, null) : scopeModule.mintScope('personal', key.slice(2), null);
    return {
      db: pgliteRpc(db),
      config: configModule.loadRagConfig(env),
      resolveScope: async (key: string) => ({ ok: true as const, scope: scopeFor(key) }),
      tenantKey,
      onProgress: (line: string) => lines.push(line),
    };
  }

  async function relex(env: Record<string, string>, tenantKey: string | null, lines: string[] = []) {
    const [{ runRelex }, ingestDeps, terminology] = await Promise.all([
      import('../../src/lib/rag/ingest/relex/run.ts'),
      import('../../src/lib/rag/ingest/deps.ts'),
      import('../../src/lib/rag/terminology/load.ts'),
    ]);
    terminology.invalidateTerminologyCache('all');
    ingestDeps.setIngestDepsForTests({ db: () => pgliteRpc(db) });
    try {
      return await runRelex(await relexInput(env, tenantKey, lines));
    } finally {
      ingestDeps.resetIngestDepsForTests();
    }
  }

  async function dryRelex(env: Record<string, string>, tenantKey: string | null, lines: string[] = []) {
    const [{ dryRunRelex }, ingestDeps] = await Promise.all([import('../../src/lib/rag/ingest/relex/run.ts'), import('../../src/lib/rag/ingest/deps.ts')]);
    ingestDeps.setIngestDepsForTests({ db: () => pgliteRpc(db) });
    try {
      return await dryRunRelex(await relexInput(env, tenantKey, lines));
    } finally {
      ingestDeps.resetIngestDepsForTests();
    }
  }

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
    tokenize = await import('../../src/lib/rag/lexical/tokenize.ts');
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
      isReady: (scope) => real.isReady(scope),
    };
    registry.setRetrievalBackendForTests(spy);

    const seeds: Array<Pick<Tenant, 'key' | 'userId'> & { label: string }> = multi
      ? [
          { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA, label: 'a' },
          { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB, label: 'b' },
        ]
      : [{ key: 's:default', userId: null, label: 'a' }];
    for (const seed of seeds) {
      tenants.push({ key: seed.key, userId: seed.userId, chunk: await insertChunk(seed, `generated-${seed.label}-quantity.md`, CHUNK_TEXT) });
    }
    if (multi) {
      await seedTerminology(db, [{ layer: tenants[1]!.key, canonical: 'ml', variants: ['dumbaro'], language: 'it', kind: 'synonym' as const, mode: 'one_way' as const }]);
    }
  });

  after(async () => {
    const registry = await import('../../src/lib/rag/backend/registry.ts');
    registry.resetRetrievalBackendForTests();
    await prepared?.close();
    await twoTenant?.db.close().catch(() => undefined);
  });

  describe(`rag:relex with RAG_LEXICAL_QUANTITY (${mode})`, () => {
    test('switch off: the version-only relex brings every chunk to version 2 and prints no recalibration line', async () => {
      const lines: string[] = [];
      await relex(ALL_OFF, null, lines);
      assert.ok(!lines.some((line) => line.includes(RECALIBRATE)), lines.join('\n'));
      const stale = await rows("SELECT count(*)::int AS n FROM document_chunks WHERE is_current AND status = 'ready' AND lexical_version IS DISTINCT FROM 2");
      assert.equal(stale[0]?.n, 0);
      baseline = await snapshot();
      for (const tenant of tenants) assert.ok(!String(baseline.get(tenant.chunk)?.lexical_text).includes('_q_'));
    });

    test('switch off: the question has no lexical hit on the chunk written with another spelling', async () => {
      const own = tenants[0]!;
      const off = await retrieve(own, QUESTION, ALL_OFF);
      assert.deepEqual(off.tokens, tokenize.queryLexicalTokens(QUESTION));
      assert.ok(!off.lexical.includes(own.chunk), 'no lexical hit without quantity tokens');
    });

    test('switch on before relex: the question leads with the quantity token; the old chunk is not excluded but not yet matched by it', async () => {
      const own = tenants[0]!;
      const on = await retrieve(own, QUESTION, QUANTITY_ON);
      assert.equal(on.tokens[0], Q_TOKEN);
      assert.ok(!on.lexical.includes(own.chunk));
    });

    test('dry run and --tenant A: exactly tenant A is selected and rewritten with _q_ tokens and version 6; other tenants untouched', async () => {
      const own = tenants[0]!;
      const expected = await currentCount(own.key);
      const dryLines: string[] = [];
      const dry = await dryRelex(QUANTITY_ON, own.key, dryLines);
      assert.equal(dry.total, expected, `expected ${expected} candidates, got ${dry.total}`);
      assert.equal(dryLines.filter((line) => line.includes(RECALIBRATE)).length, 1, dryLines.join('\n'));
      const lines: string[] = [];
      const report = await relex(QUANTITY_ON, own.key, lines);
      assert.equal(report.updated, expected, `expected ${expected} rewritten, got ${report.updated}`);
      assert.deepEqual(Object.keys(report.tenants), [own.key]);
      assert.equal(lines.filter((line) => line.includes(RECALIBRATE)).length, 1, lines.join('\n'));
      assert.ok(!lines.some((line) => /dumbaro|zorbel/u.test(line)), 'no unit word or text in a log line');
      const after = await snapshot();
      const stored = after.get(own.chunk)!;
      assert.ok(String(stored.lexical_text).split(' ').includes(Q_TOKEN), String(stored.lexical_text));
      assert.equal(stored.lexical_version, 6);
      for (const [id, row] of baseline) {
        const tenantOfRow = (await rows('SELECT tenant_key FROM document_chunks WHERE id = $1', [id]))[0]?.tenant_key;
        if (tenantOfRow !== own.key) assert.deepEqual(after.get(id), row, `chunk ${id} of ${String(tenantOfRow)} changed`);
      }
    });

    test('spellings meet: the tsquery of the token built from 2,5 kg matches the lexical_tsv of the chunk writing 2.5kg', async () => {
      const own = tenants[0]!;
      const token = tokenize.queryLexicalTokens(QUESTION, { quantity: true })[0];
      assert.equal(token, Q_TOKEN);
      const hit = await rows('SELECT count(*)::int AS n FROM document_chunks WHERE id = $1 AND lexical_tsv @@ public.rag_lexical_tsquery($2::text[])', [own.chunk, [token]]);
      assert.equal(hit[0]?.n, 1);
    });

    test('after relex the question finds the chunk through the lexical leg; off it still does not', async () => {
      const own = tenants[0]!;
      const on = await retrieve(own, QUESTION, QUANTITY_ON);
      assert.equal(on.tokens[0], Q_TOKEN);
      assert.ok(on.lexical.includes(own.chunk), 'quantity match on the lexical leg');
      const off = await retrieve(own, QUESTION, ALL_OFF);
      assert.ok(!off.lexical.includes(own.chunk));
    });

    test('plain relex rewrites every remaining chunk whose version differs; a second run rewrites zero and prints no reminder', async () => {
      const stale = Number(
        (await rows("SELECT count(*)::int AS n FROM document_chunks WHERE is_current AND status = 'ready' AND lexical_version IS DISTINCT FROM 6"))[0]?.n,
      );
      const report = await relex(QUANTITY_ON, null);
      assert.equal(report.updated, stale, `expected ${stale}, got ${report.updated}`);
      const lines: string[] = [];
      assert.equal((await relex(QUANTITY_ON, null, lines)).updated, 0);
      assert.ok(!lines.some((line) => line.includes(RECALIBRATE)), lines.join('\n'));
      for (const tenant of tenants) {
        const stored = (await rows('SELECT lexical_text, lexical_version FROM document_chunks WHERE id = $1', [tenant.chunk]))[0]!;
        assert.ok(String(stored.lexical_text).split(' ').includes(Q_TOKEN));
        assert.equal(stored.lexical_version, 6);
      }
    });

    if (multi) {
      test("tenant B's unit alias is applied to B's question only, never to tenant A's (T-03.3-2101)", async () => {
        const [a, b] = [tenants[0]!, tenants[1]!];
        const both = { ...QUANTITY_ON, RAG_LEXICAL_DICTIONARY: 'true' };
        const forA = await retrieve(a, ALIAS_QUESTION, both);
        assert.ok(!forA.tokens.includes(ALIAS_TOKEN), JSON.stringify(forA.tokens));
        const forB = await retrieve(b, ALIAS_QUESTION, both);
        assert.ok(forB.tokens.includes(ALIAS_TOKEN), JSON.stringify(forB.tokens));
      });
    }

    test('switch off again: relex restores every chunk byte for byte and the earlier version', async () => {
      const lines: string[] = [];
      const expected = Number((await rows("SELECT count(*)::int AS n FROM document_chunks WHERE is_current AND status = 'ready' AND lexical_version = 6"))[0]?.n);
      const report = await relex(ALL_OFF, null, lines);
      assert.equal(report.updated, expected);
      assert.ok(!lines.some((line) => line.includes(RECALIBRATE)));
      const restored = await snapshot();
      assert.equal(restored.size, baseline.size);
      for (const [id, row] of baseline) assert.deepEqual(restored.get(id), row, `chunk ${id} differs after the switch went off`);
    });
  });
}
