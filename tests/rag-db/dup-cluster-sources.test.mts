import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

/**
 * RET-13 complete source list (D-21, D-56): 0862 rag_dup_cluster_sources lists the current, ready member documents of the caller's
 * clusters, and the context stage puts them under the kept chunk and its used document (alsoIn). 30 generated documents share one
 * passage of invented words. Each deployment mode runs in its own child process; multi-tenant seeds two tenants with the same text.
 */
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODE_ENV = 'DUP_CLUSTER_SOURCES_MODE';
const MODE = process.env[MODE_ENV];
const COPIES = 30;
const FN = 'rag_dup_cluster_sources';

const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'su', 'ta', 'vo', 'ri', 'pe', 'du', 'zo', 'fa', 'gi', 'ho', 'ju', 'be', 'qa', 'wy'];

function inventedWord(seed: number): string {
  let n = (seed * 2654435761) >>> 0;
  let out = '';
  for (let i = 0; i < 3; i += 1) {
    out += SYLLABLES[n % SYLLABLES.length];
    n = Math.floor(n / SYLLABLES.length) + 11 * (i + 1);
  }
  return `${out}${seed % 89}`;
}

const SHARED = Array.from({ length: 40 }, (_, i) => inventedWord(150_000 + i));

function sharedPassage(copy: number): string {
  const words = SHARED.slice();
  if (copy > 0) words[17] = inventedWord(160_000 + copy);
  return words.join(' ');
}

const QUESTION = `${SHARED.slice(0, 16).join(' ')}?`;

interface Tenant {
  key: string;
  userId: string | null;
  chunks: string[];
  docs: string[];
  clusterId: string;
}

interface SourceRow {
  cluster_id: string;
  document_id: string;
  filename: string;
  chunk_id: string;
}

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

if (MODE === undefined) {
  describe('rag_dup_cluster_sources and the complete source list in both deployment modes', () => {
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
        const failures = output.split('\n').filter((line) => /not ok|AssertionError|expected|actual|found|Error/.test(line)).slice(0, 80).join('\n');
        assert.equal(result.status, 0, failures || output.slice(-2000));
        const passed = Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? '0');
        assert.ok(passed > 0, `the child ran no tests:\n${output.slice(-2000)}`);
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
  const tenants: Tenant[] = [];
  const wrongModeKey = multi ? 's:default' : `u:${TWO_TENANT_IDS.userA}`;

  async function insertDocument(tenant: Pick<Tenant, 'key' | 'userId'>, filename: string, text: string): Promise<{ doc: string; chunk: string }> {
    const doc = crypto.randomUUID();
    const chunk = crypto.randomUUID();
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const columns: [string, unknown][] = [
      ['id', doc],
      ['filename', filename],
      ['content', text],
      ['lineage_id', doc],
      ['is_current', true],
      ['status', 'ready'],
      ['content_hash', hash],
      ...(tenant.userId ? [['user_id', tenant.userId] as [string, unknown]] : []),
    ];
    await db.query(
      `INSERT INTO documents (${columns.map(([name]) => name).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      columns.map(([, value]) => value),
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, chunk_index, provisional, content_hash)
       VALUES ($1, $2, $3, $4::vector, $3, $5, true, 'ready', 0, false, $6)`,
      [chunk, doc, text, vec(text), tenant.key, hash],
    );
    return { doc, chunk };
  }

  const tenantScope = async (tenant: Tenant) => {
    const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
    return tenant.userId ? mintScope('personal', tenant.userId, null) : mintScope('single', null, null);
  };

  async function seedTenant(key: string, userId: string | null, label: string): Promise<Tenant> {
    const tenant: Tenant = { key, userId, chunks: [], docs: [], clusterId: '' };
    for (let copy = 0; copy < COPIES; copy += 1) {
      const row = await insertDocument(tenant, `generated-${label}-${String(copy).padStart(2, '0')}.md`, sharedPassage(copy));
      tenant.chunks.push(row.chunk);
      tenant.docs.push(row.doc);
    }
    return tenant;
  }

  async function sources(key: string, clusterIds: string[], limit = 30): Promise<SourceRow[]> {
    const result = await db.query<SourceRow>(
      `SELECT cluster_id::text, document_id::text, filename, chunk_id::text FROM ${FN}($1, $2::uuid[], $3)`,
      [key, clusterIds, limit],
    );
    return result.rows;
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

  before(async () => {
    if (multi) {
      twoTenant = await createTwoTenantDatabase();
      db = twoTenant.db;
    }
    prepared = await prepareInProcessEval({
      corpusDir: CORPUS_DIR,
      deploymentMode: mode,
      ...(twoTenant ? { ingestFixture: twoTenant, allowedScopes: [`user:${TWO_TENANT_IDS.userA}`, `user:${TWO_TENANT_IDS.userB}`] } : {}),
      envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RERANKER: 'none', RAG_DUP_CLUSTERS: 'true', RAG_RESULT_DIVERSITY: 'off' },
    });
    if (!multi) db = prepared.fixtureDb as PGlite;
    configModule = await import('../../src/lib/rag/config.ts');
    const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
    const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    await verifyV2Startup();

    tenants.push(await seedTenant(multi ? `u:${TWO_TENANT_IDS.userA}` : 's:default', multi ? TWO_TENANT_IDS.userA : null, 'a'));
    if (multi) tenants.push(await seedTenant(`u:${TWO_TENANT_IDS.userB}`, TWO_TENANT_IDS.userB, 'b'));

    const { clusterChunks } = await import('../../src/lib/rag/dedupe/cluster.ts');
    for (const tenant of tenants) {
      const report = await clusterChunks(await tenantScope(tenant), tenant.chunks);
      assert.equal(report.clusters, 1, `tenant ${tenant.key}: ${JSON.stringify(report)}`);
      const row = await db.query<{ id: string | null }>('SELECT dup_cluster_id::text AS id FROM document_chunks WHERE id = $1', [tenant.chunks[0]]);
      tenant.clusterId = row.rows[0]?.id ?? '';
      assert.ok(tenant.clusterId, `tenant ${tenant.key} has a cluster`);
    }
  });

  after(async () => {
    await prepared?.close();
    await twoTenant?.db.close().catch(() => undefined);
  });

  describe(`${FN} (${mode})`, () => {
    test('lists every current ready member document of the tenant cluster, in filename order', async () => {
      const own = tenants[0]!;
      const rows = await sources(own.key, [own.clusterId]);
      assert.equal(rows.length, COPIES);
      assert.ok(rows.every((row) => row.cluster_id === own.clusterId));
      const ownDocs = new Set(own.docs);
      for (const row of rows) assert.ok(ownDocs.has(row.document_id), `foreign document ${row.document_id}`);
      assert.equal(new Set(rows.map((row) => row.document_id)).size, COPIES);
      const names = rows.map((row) => row.filename);
      assert.deepEqual(names, [...names].sort());
      assert.deepEqual(await sources(own.key, [own.clusterId]), rows, 'deterministic');
      const limited = await sources(own.key, [own.clusterId], 5);
      assert.deepEqual(limited, rows.slice(0, 5));
    });

    test('a cluster id of another tenant returns nothing', { skip: !multi }, async () => {
      const [a, b] = tenants;
      assert.equal((await sources(a!.key, [b!.clusterId])).length, 0, 'tenant A asking for B cluster');
      const mixed = await sources(a!.key, [a!.clusterId, b!.clusterId]);
      const foreign = new Set(b!.docs);
      for (const row of mixed) assert.ok(!foreign.has(row.document_id), `foreign document ${row.document_id}`);
      assert.equal(mixed.length, COPIES);
    });

    test('a non-current member document is not listed', async () => {
      const own = tenants[0]!;
      const target = own.docs[3]!;
      await db.query('UPDATE documents SET is_current = false WHERE id = $1', [target]);
      try {
        const rows = await sources(own.key, [own.clusterId]);
        assert.ok(!rows.some((row) => row.document_id === target));
        assert.equal(rows.length, COPIES - 1);
      } finally {
        await db.query('UPDATE documents SET is_current = true WHERE id = $1', [target]);
      }
    });

    test('more than 50 cluster ids or a limit outside 1..30 raises 22023; empty input returns nothing', async () => {
      const own = tenants[0]!;
      const many = Array.from({ length: 51 }, () => crypto.randomUUID());
      const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
      await assert.rejects(() => sources(own.key, many), code('22023'));
      await assert.rejects(() => sources(own.key, [own.clusterId], 31), code('22023'));
      await assert.rejects(() => sources(own.key, [own.clusterId], 0), code('22023'));
      assert.equal((await sources(own.key, [])).length, 0);
    });

    test('a tenant key of the other deployment mode is rejected', async () => {
      await assert.rejects(() => sources(wrongModeKey, [tenants[0]!.clusterId]));
    });

    test('SECURITY INVOKER, empty search_path, service_role only; authenticated gets 42501', async () => {
      const rows = await db.query<{ definer: boolean; config: string[] | null; anon: boolean; auth: boolean; service: boolean }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
           FROM pg_proc p WHERE p.proname = '${FN}'`,
      );
      assert.equal(rows.rows.length, 1);
      assert.deepEqual(rows.rows[0], { definer: false, config: ['search_path=""'], anon: false, auth: false, service: true });
      for (const role of ['authenticated', 'anon']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          await assert.rejects(
            () => db.query(`SELECT 1 FROM ${FN}($1, $2::uuid[], 30)`, [tenants[0]!.key, [tenants[0]!.clusterId]]),
            (error: unknown) => (error as { code?: string }).code === '42501',
          );
        } finally {
          await db.exec('RESET ROLE');
        }
      }
    });

    test('re-applying 0862 keeps one function with the same definition and grants', async () => {
      const definition = async () =>
        (await db.query<{ def: string; acl: string }>(`SELECT pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p WHERE p.proname = '${FN}'`)).rows;
      const before = await definition();
      const files = migrationFiles(mode).filter((file) => path.basename(file).startsWith('0862_'));
      assert.equal(files.length, 1);
      await applyMigrationFiles(db, files);
      await applyMigrationFiles(db, files);
      assert.deepEqual(await definition(), before);
    });
  });

  describe(`complete source list through runRetrieval (${mode})`, () => {
    test("collapse: the kept chunk and its used document list the cluster's other documents, own tenant only", async () => {
      const { runRetrieval } = await import('../../src/lib/rag/index.ts');
      for (const tenant of tenants) {
        const result = await withEnv({ RAG_RESULT_DIVERSITY: 'collapse' }, async () =>
          runRetrieval({ scope: await tenantScope(tenant), query: QUESTION, profile: 'eval', signal: new AbortController().signal, options: { ragMode: 'balanced' } }),
        );
        const keeper = result.kept.find((chunk) => tenant.chunks.includes(chunk.chunk_id));
        assert.ok(keeper, 'a kept copy');
        const used = result.usedDocuments.find((doc) => doc.id === keeper.document_id);
        assert.ok(used, 'the used document of the kept chunk');
        const listed = used.alsoIn ?? [];
        assert.equal(listed.length, COPIES - 1, JSON.stringify(listed.map((entry) => entry.filename)));
        assert.deepEqual(keeper.alsoIn, listed);
        const own = new Set(tenant.docs);
        for (const entry of listed) {
          assert.ok(own.has(entry.documentId), `foreign or unknown document ${entry.documentId}`);
          assert.notEqual(entry.documentId, keeper.document_id);
          assert.ok(entry.filename.length > 0);
        }
        assert.equal(new Set(listed.map((entry) => entry.documentId)).size, listed.length);
      }
    });

    test('diversity off: no alsoIn on the used documents', async () => {
      const { runRetrieval } = await import('../../src/lib/rag/index.ts');
      const own = tenants[0]!;
      const result = await withEnv({ RAG_RESULT_DIVERSITY: 'off' }, async () =>
        runRetrieval({ scope: await tenantScope(own), query: QUESTION, profile: 'eval', signal: new AbortController().signal, options: { ragMode: 'balanced' } }),
      );
      assert.ok(result.usedDocuments.length > 0);
      assert.ok(result.usedDocuments.every((doc) => doc.alsoIn === undefined));
    });
  });
}
