import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

/**
 * RET-13 end to end through the eval route (D-21, D-22, D-48): one passage of invented words pasted into 30 generated documents
 * plus one document answering a second intent. Collapse keeps one copy and lets the second intent into the final top-k; the
 * dropped copies are listed per kept chunk, never another tenant's. Each deployment mode runs in its own child process,
 * because the route binds one deployment mode and one fixture edge per process. All text is synthetic and neutral.
 */
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';
const MODE_ENV = 'DIVERSIFY_E2E_MODE';
const MODE = process.env[MODE_ENV];
const COPIES = 30;

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

const SHARED = Array.from({ length: 40 }, (_, i) => inventedWord(50_000 + i));
const SECOND = Array.from({ length: 12 }, (_, i) => inventedWord(70_000 + i));

/** Copy `copy` of the template passage: one slot carries a per-copy word, so copies are near (not exact) duplicates. */
function sharedPassage(copy: number): string {
  const words = SHARED.slice();
  if (copy > 0) words[17] = inventedWord(60_000 + copy);
  return words.join(' ');
}

const SECOND_TEXT = `${SECOND.join(' ')} ${SHARED.slice(0, 3).join(' ')}`;
const QUESTION = `${SHARED.slice(0, 14).join(' ')} and ${SECOND.slice(0, 8).join(' ')}?`;

interface KeptRow {
  chunk_id: string;
  document_id: string;
  dup_cluster_id?: string;
}

interface TraceBody {
  candidates: Array<{ chunk_id: string; document_id: string }>;
  kept: KeptRow[];
  refused?: boolean;
  stage_status: Record<string, string>;
  stage_counts?: Record<string, Record<string, number>>;
  topk_redundancy?: number;
}

interface Tenant {
  key: string;
  userId: string | null;
  sharedChunks: string[];
  sharedDocs: string[];
  secondChunk: string;
}

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

if (MODE === undefined) {
  describe('result diversity end to end in both deployment modes', () => {
    for (const mode of ['single-tenant', 'multi-tenant'] as const) {
      test(mode, () => {
        // NODE_TEST_CONTEXT makes a nested node --test skip its files, so the child must not inherit it.
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

  async function insertDocument(tenant: Pick<Tenant, 'key' | 'userId'>, filename: string, text: string): Promise<{ doc: string; chunk: string }> {
    const doc = crypto.randomUUID();
    const chunk = crypto.randomUUID();
    const columns: [string, unknown][] = [
      ['id', doc],
      ['filename', filename],
      ['content', text],
      ['lineage_id', doc],
      ['is_current', true],
      ['status', 'ready'],
      ['content_hash', crypto.createHash('sha256').update(text).digest('hex')],
      ...(tenant.userId ? [['user_id', tenant.userId] as [string, unknown]] : []),
    ];
    await db.query(
      `INSERT INTO documents (${columns.map(([name]) => name).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      columns.map(([, value]) => value),
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, chunk_index, provisional, content_hash)
       VALUES ($1, $2, $3, $4::vector, $3, $5, true, 'ready', 0, false, $6)`,
      [chunk, doc, text, vec(text), tenant.key, crypto.createHash('sha256').update(text).digest('hex')],
    );
    return { doc, chunk };
  }

  async function seedTenant(key: string, userId: string | null, label: string): Promise<Tenant> {
    const tenant: Tenant = { key, userId, sharedChunks: [], sharedDocs: [], secondChunk: '' };
    for (let copy = 0; copy < COPIES; copy += 1) {
      const row = await insertDocument(tenant, `generated-${label}-${copy}.md`, sharedPassage(copy));
      tenant.sharedChunks.push(row.chunk);
      tenant.sharedDocs.push(row.doc);
    }
    tenant.secondChunk = (await insertDocument(tenant, `generated-${label}-second.md`, SECOND_TEXT)).chunk;
    return tenant;
  }

  async function postEval(userId: string | null): Promise<TraceBody> {
    const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
      body: JSON.stringify({ schema_version: 1, query: QUESTION, rag_mode: 'balanced', options: userId ? { user_id: userId } : {} }),
    });
    const res = await prepared.POST(req);
    const json = (await res.json()) as TraceBody;
    assert.equal(res.status, 200, JSON.stringify(json).slice(0, 400));
    return json;
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

  const tenantScope = async (tenant: Tenant) => {
    const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
    return tenant.userId ? mintScope('personal', tenant.userId, null) : mintScope('single', null, null);
  };

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
      const report = await clusterChunks(await tenantScope(tenant), [...tenant.sharedChunks, tenant.secondChunk]);
      assert.equal(report.clusters, 1, `tenant ${tenant.key}: ${JSON.stringify(report)}`);
    }
  });

  after(async () => {
    await prepared?.close();
    await twoTenant?.db.close().catch(() => undefined);
  });

  describe(`result diversity through the eval route (${mode})`, () => {
    test('off: the duplicates fill the top-k; kept chunks carry their cluster id and the trace carries the redundancy', async () => {
      const own = tenants[0]!;
      const json = await withEnv({ RAG_RESULT_DIVERSITY: 'off' }, () => postEval(own.userId));
      assert.equal(json.refused ?? false, false);
      assert.equal(json.stage_status.diversify, 'disabled');
      const shared = json.kept.filter((row) => own.sharedChunks.includes(row.chunk_id));
      assert.ok(shared.length > 1, `kept ${shared.length} copies`);
      assert.ok(shared.every((row) => typeof row.dup_cluster_id === 'string'));
      assert.ok((json.topk_redundancy ?? 0) > 0.5, `redundancy ${json.topk_redundancy}`);
      assert.equal(json.stage_counts?.assemble?.topk_redundancy_permille, Math.round((json.topk_redundancy ?? 0) * 1000));
    });

    for (const diversity of ['collapse', 'mmr'] as const) {
      test(`${diversity}: one chunk of the cluster and the second intent within the final top-k`, async () => {
        const own = tenants[0]!;
        const json = await withEnv({ RAG_RESULT_DIVERSITY: diversity }, () => postEval(own.userId));
        assert.equal(json.stage_status.diversify, 'ok');
        const shared = json.kept.filter((row) => own.sharedChunks.includes(row.chunk_id));
        assert.equal(shared.length, 1, JSON.stringify(json.kept.map((row) => row.chunk_id)));
        assert.ok(json.kept.some((row) => row.chunk_id === own.secondChunk), 'second intent chunk kept');
        assert.ok(json.stage_counts?.diversify?.collapsed !== undefined && json.stage_counts.diversify.collapsed > 0);
        assert.ok((json.topk_redundancy ?? 1) < 0.6, `redundancy ${json.topk_redundancy}`);
      });
    }

    test('the refusal record is the same with diversity off and collapse', async () => {
      const own = tenants[0]!;
      const off = await withEnv({ RAG_RESULT_DIVERSITY: 'off' }, () => postEval(own.userId));
      const on = await withEnv({ RAG_RESULT_DIVERSITY: 'collapse' }, () => postEval(own.userId));
      const refusal = (json: TraceBody) => (json as unknown as { refusal: unknown }).refusal;
      assert.deepEqual(refusal(on), refusal(off));
      assert.equal(on.refused ?? false, off.refused ?? false);
    });

    test("alsoIn lists the tenant's own dropped copies only", async () => {
      const { runRetrieval } = await import('../../src/lib/rag/index.ts');
      for (const tenant of tenants) {
        const result = await withEnv({ RAG_RESULT_DIVERSITY: 'collapse' }, async () =>
          runRetrieval({ scope: await tenantScope(tenant), query: QUESTION, profile: 'eval', signal: new AbortController().signal, options: { ragMode: 'balanced' } }),
        );
        const keeper = result.kept.find((chunk) => tenant.sharedChunks.includes(chunk.chunk_id));
        assert.ok(keeper, 'a kept copy');
        const listed = keeper.alsoIn ?? [];
        assert.ok(listed.length > 0, 'the dropped copies are listed');
        const own = new Set(tenant.sharedDocs);
        for (const entry of listed) {
          assert.ok(own.has(entry.documentId), `foreign or unknown document ${entry.documentId}`);
          assert.notEqual(entry.documentId, keeper.document_id);
        }
        assert.equal(new Set(listed.map((entry) => entry.documentId)).size, listed.length);
      }
    });
  });
}
