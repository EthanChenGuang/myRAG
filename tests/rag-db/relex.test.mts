import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');

const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const TENANT_O = `o:${TWO_TENANT_IDS.orgO}`;
const CANARY_CHUNK_IDS = [TWO_TENANT_IDS.chunkA, TWO_TENANT_IDS.chunkB, TWO_TENANT_IDS.chunkO];

type Row = Record<string, unknown>;

function pgliteRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM ${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const run = db
        .query<Row>(sql, keys.map((key) => args[key]))
        .then((result): RpcResponse => ({ data: result.rows as unknown[], error: null }))
        .catch((error: unknown): RpcResponse => ({ data: null, error: { code: 'P0001', message: error instanceof Error ? error.message : String(error) } }));
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

async function lexicalChecksum(db: PGlite): Promise<string> {
  const rows = await db.query<Row>(
    'SELECT id, lexical_text, lexical_version, language, lexical_tsv::text AS lexical_tsv FROM document_chunks ORDER BY id',
  );
  return crypto.createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex');
}

describe('rag:relex job (src/lib/rag/ingest/relex)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let relex: typeof import('@/lib/rag/ingest/relex/run');
  let cli: typeof import('@/lib/rag/ingest/relex/cli');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');

  before(async () => {
    fixture = await createTwoTenantDatabase({ relex: false });
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    relex = await import('@/lib/rag/ingest/relex/run');
    cli = await import('@/lib/rag/ingest/relex/cli');
    depsModule = await import('@/lib/rag/ingest/deps');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    const staleBeforeCanary = Number(
      (await fixture.db.query<Row>('SELECT count(*)::int AS n FROM document_chunks WHERE lexical_version IS DISTINCT FROM 1 AND lexical_version IS DISTINCT FROM 2'))
        .rows[0]?.n,
    );
    assert.equal(staleBeforeCanary, 74, 'corpus and canary chunks start without tokenizer v2');
    await fixture.db.query(
      `UPDATE document_chunks SET lexical_version = 1, lexical_text = 'phase3 placeholder',
         metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{lexical_version}', '1'::jsonb)
       WHERE id = ANY($1::uuid[])`,
      [CANARY_CHUNK_IDS],
    );
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(async () => {
    const { createFakeObjectStore } = await import('../helpers/fake-object-store');
    objectStoreModule.setObjectStoreForTests(createFakeObjectStore());
    depsModule.setIngestDepsForTests({ db: () => pgliteRpc(fixture.db) });
    edge.calls.length = 0;
  });

  afterEach(() => {
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
  });

  const db = () => pgliteRpc(fixture.db);

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  test('a run updates 74 stale rows, sets lexical_version 2 and fills lexical_tsv', async () => {
    const report = await relex.runRelex({ db: db(), batchSize: 500 });
    assert.equal(report.updated, 74);
    assert.equal(report.batches, 1);
    const stale = await rows('SELECT count(*)::int AS n FROM document_chunks WHERE lexical_version IS DISTINCT FROM $1', [LEXICAL_VERSION]);
    assert.equal(stale[0]?.n, 0);
    const missingTsv = await rows(
      'SELECT count(*)::int AS n FROM document_chunks WHERE lexical_text IS NOT NULL AND lexical_text <> \'\' AND lexical_tsv IS NULL',
    );
    assert.equal(missingTsv[0]?.n, 0);
    const nullLangFilled = await rows(
      'SELECT count(*)::int AS n FROM document_chunks WHERE language IS NOT NULL AND id = ANY($1::uuid[])',
      [CANARY_CHUNK_IDS],
    );
    assert.ok(Number(nullLangFilled[0]?.n) >= 3, 'NULL language rows get detectLanguage');
  });

  test('a second run updates nothing', async () => {
    const report = await relex.runRelex({ db: db() });
    assert.deepEqual(report, { updated: 0, batches: 0, tenants: {} });
  });

  test('resume after an interrupted first batch does not re-process early rows', async () => {
    await fixture.db.query(
      `UPDATE document_chunks SET lexical_version = NULL, lexical_text = NULL, lexical_tsv = NULL,
         metadata = metadata - 'lexical_version'`,
    );
    await fixture.db.query(
      `UPDATE document_chunks SET lexical_version = 1, lexical_text = 'phase3 placeholder',
         metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{lexical_version}', '1'::jsonb)
       WHERE id = ANY($1::uuid[])`,
      [CANARY_CHUNK_IDS],
    );
    const batchSizes: number[] = [];
    let resumeAfter: string | null = null;
    await assert.rejects(
      relex.runRelex({
        db: db(),
        batchSize: 20,
        onBatch: async (info) => {
          batchSizes.push(info.updated);
          resumeAfter = info.cursor;
          if (info.batch === 1) throw new Error('simulated kill');
        },
      }),
      /simulated kill/,
    );
    assert.equal(batchSizes.length, 1);
    assert.equal(batchSizes[0], 20);

    const report = await relex.runRelex({ db: db(), batchSize: 20, resumeAfter });
    assert.equal(report.updated, 54);
    assert.ok(report.batches >= 3);
    assert.equal((await rows('SELECT count(*)::int AS n FROM document_chunks WHERE lexical_version IS DISTINCT FROM $1', [LEXICAL_VERSION]))[0]?.n, 0);
  });

  test('--tenant touches only one tenant rows', async () => {
    await fixture.db.query(
      `UPDATE document_chunks SET lexical_version = NULL, lexical_text = NULL, lexical_tsv = NULL,
         metadata = metadata - 'lexical_version'`,
    );
    const report = await relex.runRelex({ db: db(), tenantKey: TENANT_A, batchSize: 500 });
    assert.ok(report.updated >= 1);
    const tenantBStale = await rows('SELECT count(*)::int AS n FROM document_chunks WHERE tenant_key = $1 AND lexical_version IS NULL', [TENANT_B]);
    assert.ok(Number(tenantBStale[0]?.n) > 0, 'tenant B stays stale');
    await relex.runRelex({ db: db(), batchSize: 500 });
  });

  test('--dry-run reports per-tenant counts and writes nothing', async () => {
    await fixture.db.query(
      `UPDATE document_chunks SET lexical_version = NULL, lexical_text = NULL, lexical_tsv = NULL,
         metadata = metadata - 'lexical_version'`,
    );
    const before = await lexicalChecksum(fixture.db);
    const report = await relex.dryRunRelex({ db: db() });
    assert.equal(report.total, 74);
    assert.ok(report.tenants[TENANT_A] > 0);
    const after = await lexicalChecksum(fixture.db);
    assert.equal(before, after);
    await relex.runRelex({ db: db(), batchSize: 500 });
  });

  test('the job makes no parser, sidecar, object-store or embedding call', async () => {
    const { startFakeSidecar } = await import('../helpers/fake-sidecar');
    const { startFakeLlamaParse } = await import('../helpers/fake-llamaparse');
    const sidecar = await startFakeSidecar();
    const llama = await startFakeLlamaParse();
    const previous = { url: process.env.RAG_SIDECAR_URL, secret: process.env.RAG_SIDECAR_SECRET, llama: process.env.LLAMA_CLOUD_API_KEY };
    process.env.RAG_SIDECAR_URL = sidecar.url;
    process.env.RAG_SIDECAR_SECRET = sidecar.secret;
    process.env.LLAMA_CLOUD_API_KEY = llama.apiKey;
    await fixture.db.query(
      `UPDATE document_chunks SET lexical_version = NULL, lexical_text = NULL, lexical_tsv = NULL
       WHERE id = $1`,
      [TWO_TENANT_IDS.chunkA],
    );
  const refuse = (name: string) => async () => {
      throw new Error(`${name} must not be called by the relex job`);
    };
    try {
      objectStoreModule.setObjectStoreForTests({ put: refuse('object store'), get: refuse('object store'), remove: refuse('object store'), exists: refuse('object store') });
      depsModule.setIngestDepsForTests({ embedDocuments: refuse('legacy embedder') });
      await relex.runRelex({ db: db(), tenantKey: TENANT_A, batchSize: 500 });
      assert.equal(sidecar.calls.length, 0);
      assert.equal(llama.calls.length, 0);
      assert.equal(edge.calls.length, 0);
    } finally {
      process.env.RAG_SIDECAR_URL = previous.url;
      process.env.RAG_SIDECAR_SECRET = previous.secret;
      process.env.LLAMA_CLOUD_API_KEY = previous.llama;
      await sidecar.close();
      await llama.close();
    }
  });

  test('CLI parse accepts documented flags', () => {
    const parsed = cli.parseRelexArgs(['--dry-run', '--batch-size', '20', '--tenant', TENANT_A, '--resume-after', TWO_TENANT_IDS.chunkA]);
    assert.deepEqual(parsed, {
      ok: true,
      dryRun: true,
      tenantKey: TENANT_A,
      batchSize: 20,
      resumeAfter: TWO_TENANT_IDS.chunkA,
    });
  });
});

describe('fixture databases ship with lexical v2', () => {
  for (const mode of ['single-tenant', 'multi-tenant'] as DeploymentMode[]) {
    test(`${mode} createFixtureDatabase has lexical_version ${LEXICAL_VERSION} on every chunk`, async () => {
      let fixture: FixtureDatabase | undefined;
      try {
        fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
        const stale = await fixture.db.query<Row>('SELECT count(*)::int AS n FROM document_chunks WHERE lexical_version IS DISTINCT FROM $1', [
          LEXICAL_VERSION,
        ]);
        assert.equal(stale.rows[0]?.n, 0);
        assert.ok(fixture.sqlSha256[`lexical_version:${LEXICAL_VERSION}`], 'fixture hash records tokenizer version');
      } finally {
        await fixture?.db.close();
      }
    });
  }
});