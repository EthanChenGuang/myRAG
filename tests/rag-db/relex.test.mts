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
/** 107 fixture corpus chunks (71 before the 05.1-09 injection documents) plus the three canary chunks. */
const STALE_ROWS = 110;

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
    assert.equal(staleBeforeCanary, STALE_ROWS, 'corpus and canary chunks start without tokenizer v2');
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

  test(`a run updates ${STALE_ROWS} stale rows, sets lexical_version 2 and fills lexical_tsv`, async () => {
    const report = await relex.runRelex({ db: db(), batchSize: 500 });
    assert.equal(report.updated, STALE_ROWS);
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
    assert.equal(report.updated, STALE_ROWS - 20);
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
    assert.equal(report.total, STALE_ROWS);
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

  test('table row serialization (D-21): the switch on writes row lines into table chunks under the unchanged LEXICAL_VERSION, off restores the plain text', async () => {
    const { chunkLexicalText } = await import('@/lib/rag/lexical/chunk-text');
    const { tableRowLanguage, tableRowSeparator } = await import('@/lib/rag/ingest/text/table-rows');
    await relex.runRelex({ db: db(), batchSize: 500 });
    const chunkId = TWO_TENANT_IDS.chunkA;
    const [original] = await rows('SELECT content, chunk_kind FROM document_chunks WHERE id = $1', [chunkId]);
    const table = '| Item | Count |\n| --- | --- |\n| first sample | 1 |\n| second sample | 2 |';
    const tableChunks = Number((await rows("SELECT count(*)::int AS n FROM document_chunks WHERE chunk_kind = 'table'"))[0]?.n);
    try {
      await fixture.db.query("UPDATE document_chunks SET chunk_kind = 'table', content = $2 WHERE id = $1", [chunkId, table]);
      const stored = async () =>
        (await rows(
          `SELECT c.lexical_text, c.lexical_version, c.section_path, c.metadata, c.language, d.filename, d.language AS document_language
           FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = $1`,
          [chunkId],
        ))[0] as Row;
      const before = await stored();
      const input = {
        sectionPath: before.section_path as string[],
        content: table,
        chunkKind: 'table',
        metadata: before.metadata as Record<string, unknown>,
        documentFilename: String(before.filename),
      };
      const separator = tableRowSeparator(
        true,
        'table',
        tableRowLanguage({ chunkLanguage: before.language as string | null, documentLanguage: before.document_language as string | null }),
      );
      const plain = chunkLexicalText(input);
      const serialized = chunkLexicalText({ ...input, tableRowSeparator: separator });
      assert.notEqual(serialized, plain);

      const restore = await relex.runRelex({ db: db(), tableRowSerialization: false, tenantKey: TENANT_A });
      assert.equal(restore.tables, 1, 'the edited chunk gets the plain text of its new content');
      assert.equal((await stored()).lexical_text, plain);

      const on = await relex.runRelex({ db: db(), tableRowSerialization: true, tenantKey: TENANT_A });
      assert.equal(on.tables, 1);
      const afterOn = await stored();
      assert.equal(afterOn.lexical_text, serialized);
      assert.equal(afterOn.lexical_version, LEXICAL_VERSION);
      assert.deepEqual(await relex.dryRunRelex({ db: db(), tableRowSerialization: true }), { tenants: {}, total: 0, tables: 0 });
      assert.equal((await relex.runRelex({ db: db(), tableRowSerialization: true })).updated, 0, 'a second run with the switch on rewrites nothing');

      const off = await relex.runRelex({ db: db(), tableRowSerialization: false });
      assert.equal(off.tables, 1);
      const afterOff = await stored();
      assert.equal(afterOff.lexical_text, plain);
      assert.equal(afterOff.lexical_version, LEXICAL_VERSION);
      assert.equal((await relex.runRelex({ db: db(), tableRowSerialization: false })).updated, 0);
      assert.equal(Number((await rows("SELECT count(*)::int AS n FROM document_chunks WHERE chunk_kind = 'table'"))[0]?.n), tableChunks + 1);
    } finally {
      await fixture.db.query('UPDATE document_chunks SET chunk_kind = $2, content = $3 WHERE id = $1', [chunkId, original?.chunk_kind, original?.content]);
      await relex.runRelex({ db: db(), tableRowSerialization: false });
    }
  });

  test('rag_relex_table_candidates is service-role only', async () => {
    const fns = await rows(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
              p.prosecdef AS definer, p.proconfig AS config
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'rag_relex_table_candidates'`,
    );
    assert.equal(fns.length, 1);
    assert.deepEqual(
      { anon: fns[0]?.anon, auth: fns[0]?.auth, service: fns[0]?.service, definer: fns[0]?.definer },
      { anon: false, auth: false, service: true, definer: false },
    );
    assert.deepEqual(fns[0]?.config, ['search_path=""']);
  });

  test('the CLI passes RAG_TABLE_ROW_SERIALIZATION to the run and reports the table chunks', async () => {
    for (const value of ['true', 'false']) {
      depsModule.setIngestDepsForTests({ db: () => pgliteRpc(fixture.db), ingestEnv: () => ({ RAG_TABLE_ROW_SERIALIZATION: value }) });
      const lines: string[] = [];
      const code = await cli.main(['--dry-run'], { out: (line) => lines.push(line), err: (line) => lines.push(line) });
      assert.equal(code, 0);
      assert.ok(lines.includes(`[RAG Relex] table chunks (RAG_TABLE_ROW_SERIALIZATION=${value}): would update 0`), lines.join('\n'));
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