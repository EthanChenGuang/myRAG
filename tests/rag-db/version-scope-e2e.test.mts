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
 * RET-11 end to end through the eval route (D-12, D-13, D-40): a version scope reaches superseded text of the caller's own
 * tenant through the lexical and exact-id legs only, labels it in the context, and changes nothing by default. Each deployment
 * mode runs in its own child process, because the route binds one deployment mode and one fixture edge per process.
 * All text is synthetic and neutral.
 */
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';
const MODE_ENV = 'VERSION_SCOPE_E2E_MODE';
const MODE = process.env[MODE_ENV];

const TERM = 'zorvexalith';
const QUESTION = `${TERM} threshold value per cycle`;
const OLD_TEXT = `The ${TERM} threshold value is seven units per cycle.`;
const NEW_TEXT = `The ${TERM} threshold value is nine units per cycle.`;
const FOREIGN_TEXT = `The ${TERM} threshold value is eleven units per cycle, ${TERM} ${TERM}.`;

interface Candidate {
  chunk_id: string;
  document_id: string;
  content: string;
  legs?: Record<string, number>;
}

interface TraceBody {
  candidates: Candidate[];
  kept: Array<{ chunk_id: string; document_id: string; content: string }>;
  context: string;
  retrieval_strategy: string;
  stage_status: Record<string, string>;
  stage_counts?: Record<string, Record<string, number>>;
  retrieval_config_hash?: string;
}

interface Lineage {
  oldDoc: string;
  newDoc: string;
  oldChunk: string;
  newChunk: string;
}

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

if (MODE === undefined) {
  describe('version scope end to end in both deployment modes', () => {
    for (const mode of ['single-tenant', 'multi-tenant'] as const) {
      test(mode, () => {
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=spec', SELF], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, [MODE_ENV]: mode },
          timeout: 600_000,
        });
        const output = `${result.stdout}\n${result.stderr}`;
        assert.equal(result.status, 0, output.split('\n').filter((line) => /✖|not ok|Error|assert|expected|actual/i.test(line)).slice(0, 80).join('\n'));
        assert.ok(!/# tests 0\b/.test(output), 'the child ran no tests');
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
  let own: Lineage;
  let foreign: Lineage | null = null;
  const userA = multi ? TWO_TENANT_IDS.userA : null;

  async function seedLineage(tenant: { key: string; userId: string | null }, oldText: string, newText: string): Promise<Lineage> {
    const lineage = crypto.randomUUID();
    const ids: Lineage = {
      oldDoc: crypto.randomUUID(),
      newDoc: crypto.randomUUID(),
      oldChunk: crypto.randomUUID(),
      newChunk: crypto.randomUUID(),
    };
    const versions = [
      { doc: ids.newDoc, chunk: ids.newChunk, text: newText, version: 2, current: true, supersededBy: null, from: '2026-04-01', to: null, created: '2026-04-01T08:00:00Z' },
      { doc: ids.oldDoc, chunk: ids.oldChunk, text: oldText, version: 1, current: false, supersededBy: ids.newDoc, from: '2026-01-01', to: '2026-03-31', created: '2026-01-02T08:00:00Z' },
    ];
    for (const v of versions) {
      const columns: [string, unknown, string?][] = [
        ['id', v.doc],
        ['filename', `synthetic-lineage-${lineage.slice(0, 8)}.md`],
        ['content', v.text],
        ['lineage_id', lineage],
        ['version', v.version],
        ['is_current', v.current],
        ['status', 'ready'],
        ['superseded_by', v.supersededBy],
        ['provisional', false],
        ['content_hash', crypto.createHash('sha256').update(v.text).digest('hex')],
        ['created_at', v.created, 'timestamptz'],
        ['effective_from', v.from, 'date'],
        ['effective_to', v.to, 'date'],
        ...(tenant.userId ? [['user_id', tenant.userId] as [string, unknown]] : []),
      ];
      await db.query(
        `INSERT INTO documents (${columns.map(([name]) => name).join(', ')})
         VALUES (${columns.map(([, , cast], index) => (cast ? `$${index + 1}::${cast}` : `$${index + 1}`)).join(', ')})`,
        columns.map(([, value]) => value),
      );
      // Superseded chunks keep no vector: publish deletes it (D-40, D-58).
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, chunk_index, provisional)
         VALUES ($1, $2, $3, $4::vector, $3, $5, $6, 'ready', 0, false)`,
        [v.chunk, v.doc, v.text, v.current ? vec(v.text) : null, tenant.key, v.current],
      );
    }
    return ids;
  }

  async function postEval(retrievalFilters?: Record<string, unknown>): Promise<TraceBody> {
    const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
      body: JSON.stringify({
        schema_version: 1,
        query: QUESTION,
        rag_mode: 'balanced',
        options: {
          ...(userA ? { user_id: userA } : {}),
          ...(retrievalFilters ? { retrieval_filters: retrievalFilters } : {}),
        },
      }),
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

  const ON = { RAG_VERSION_SCOPE: 'true', RAG_LEXICAL_SEARCH: 'true' };
  const OFF = { RAG_VERSION_SCOPE: 'false', RAG_LEXICAL_SEARCH: 'true' };

  function candidateIds(json: TraceBody): Set<string> {
    return new Set(json.candidates.map((row) => row.chunk_id));
  }

  /** The trace without the fields that differ between two runs of the same request. */
  function comparable(json: TraceBody): Record<string, unknown> {
    const { candidates, kept, context, stage_status, stage_counts, retrieval_config_hash } = json;
    return { candidates, kept, context, stage_status, stage_counts, retrieval_config_hash };
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
      envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RERANKER: 'none', RAG_EXACT_ID_LOOKUP: 'false' },
    });
    if (!multi) db = prepared.fixtureDb as PGlite;
    configModule = await import('../../src/lib/rag/config.ts');
    const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
    const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    await verifyV2Startup();

    own = await seedLineage({ key: multi ? `u:${TWO_TENANT_IDS.userA}` : 's:default', userId: userA }, OLD_TEXT, NEW_TEXT);
    if (multi) {
      foreign = await seedLineage({ key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB }, FOREIGN_TEXT, `${NEW_TEXT} Other tenant.`);
    }
  });

  after(async () => {
    await prepared?.close();
    await twoTenant?.db.close().catch(() => undefined);
  });

  describe(`version scope through the eval route (${mode})`, () => {
    test('switch off: versions all equals the request without the field, and the search detail says versions_ignored', async () => {
      const plain = await withEnv(OFF, () => postEval());
      const asked = await withEnv(OFF, () => postEval({ versions: 'all' }));
      assert.deepEqual(comparable(asked), comparable(plain));
      assert.ok(asked.retrieval_strategy.split(';').includes('versions_ignored'), asked.retrieval_strategy);
      assert.ok(!candidateIds(asked).has(own.oldChunk));
    });

    test('switch on without the lexical leg: the scope stays current', async () => {
      const asked = await withEnv({ RAG_VERSION_SCOPE: 'true', RAG_LEXICAL_SEARCH: 'false' }, () => postEval({ versions: 'all' }));
      assert.ok(asked.retrieval_strategy.split(';').includes('versions_ignored'), asked.retrieval_strategy);
      assert.ok(!candidateIds(asked).has(own.oldChunk));
    });

    test('switch on, versions current or absent: identical to today', async () => {
      const plain = await withEnv(OFF, () => postEval());
      const absent = await withEnv(ON, () => postEval());
      const current = await withEnv(ON, () => postEval({ versions: 'current' }));
      // The retrieval config hash already carries the switch (plan 04.2-02), so it is compared within one switch state only.
      const { retrieval_config_hash: _plainHash, ...plainRest } = comparable(plain);
      const { retrieval_config_hash: absentHash, ...absentRest } = comparable(absent);
      assert.deepEqual(absentRest, plainRest);
      assert.deepEqual(comparable(current), { ...absentRest, retrieval_config_hash: absentHash });
      assert.equal(current.retrieval_strategy.includes('versions_'), false, current.retrieval_strategy);
    });

    test('switch on, versions all: both versions of the own tenant, the superseded one through the lexical leg only', async () => {
      const json = await withEnv(ON, () => postEval({ versions: 'all' }));
      const versions = json.candidates.filter((row) => row.document_id === own.oldDoc || row.document_id === own.newDoc);
      assert.ok(candidateIds(json).has(own.oldChunk), `found ${JSON.stringify(versions.map((row) => row.document_id))}`);
      assert.ok(candidateIds(json).has(own.newChunk), `found ${JSON.stringify(versions.map((row) => row.document_id))}`);
      const superseded = json.candidates.find((row) => row.chunk_id === own.oldChunk)!;
      const legs = Object.keys(superseded.legs ?? {});
      assert.ok(legs.length > 0 && legs.every((leg) => leg.startsWith('lexical') || leg === 'exact_id'), JSON.stringify(legs));
      assert.ok(json.retrieval_strategy.split(';').includes('superseded_dense_unavailable'), json.retrieval_strategy);
      if (foreign) {
        for (const id of [foreign.oldChunk, foreign.newChunk]) assert.ok(!candidateIds(json).has(id), `foreign chunk ${id}`);
        assert.ok(!json.context.includes('eleven units'));
      }
    });

    test('a range that ends before version 2 starts returns version 1 only; one that starts after returns version 2 only', async () => {
      const early = await withEnv(ON, () => postEval({ versions: { to: '2026-02-15' } }));
      assert.ok(candidateIds(early).has(own.oldChunk));
      assert.ok(!candidateIds(early).has(own.newChunk));
      const late = await withEnv(ON, () => postEval({ versions: { from: '2026-05-01' } }));
      assert.ok(!candidateIds(late).has(own.oldChunk));
      assert.ok(candidateIds(late).has(own.newChunk));
    });

    test('a malformed versions value answers 400 on the versions path', async () => {
      const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
        body: JSON.stringify({
          schema_version: 1,
          query: QUESTION,
          rag_mode: 'balanced',
          options: { ...(userA ? { user_id: userA } : {}), retrieval_filters: { versions: { from: '2026-05-01', to: '2026-01-01' } } },
        }),
      });
      const res = await prepared.POST(req);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { details: Array<{ path: string }> };
      assert.equal(body.details[0]?.path, 'versions');
    });
  });
}
