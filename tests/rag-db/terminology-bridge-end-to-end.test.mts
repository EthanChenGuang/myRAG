import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import type { RetrievalResult } from '@/lib/rag/types';

type Row = Record<string, unknown>;

const DAY = 86_400_000;
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
const ENABLED = { RAG_DOMAIN_EXPERT_REVIEW: 'true', RAG_RETRIEVAL_LOG: 'masked_query', RAG_TERMINOLOGY_MINING: 'true' };
const ITEM_SELECT =
  'tenant_key, query_masked, query_language, channel, outcome, retrieval_config_hash, reasons, mined_at, rag_retrieval_log(tenant_key, status, top_score)';

interface Tenant {
  key: string;
  organizationId: string;
  userId: string;
}

async function createTenant(db: PGlite): Promise<Tenant> {
  const userId = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [userId, `user-${userId.slice(0, 8)}@example.invalid`]);
  const organizationId = crypto.randomUUID();
  await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [
    organizationId,
    'Fixture org',
    `fixture-${organizationId.slice(0, 8)}`,
    userId,
  ]);
  return { key: `o:${organizationId}`, organizationId, userId };
}

function emptyResult(): RetrievalResult {
  return {
    status: 'ok',
    reason: 'ok',
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    traceId: crypto.randomBytes(16).toString('hex'),
  } as unknown as RetrievalResult;
}

/**
 * RPCs go through the fake edge with the service-role key. The fake edge serves no embedded selects, so the bridge's one read
 * (rag_review_items with its rag_retrieval_log row) and the purge delete run on the database directly, shaped as PostgREST answers.
 */
function hybridClient(edgeClient: SupabaseClient, db: PGlite): SupabaseClient {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      const response = await edgeClient.rpc(name, args);
      const rows = response.data as unknown;
      if (Array.isArray(rows) && rows.length === 1 && rows[0] && typeof rows[0] === 'object' && Object.keys(rows[0]).join() === name) {
        return { ...response, data: (rows[0] as Record<string, unknown>)[name] };
      }
      return response;
    },
    from(table: string) {
      assert.equal(table, 'rag_review_items');
      const where: string[] = [];
      const values: unknown[] = [];
      let select: string | null = null;
      let limit: number | null = null;
      let order: string | null = null;
      const builder: Record<string, unknown> = {
        delete: () => builder,
        select(columns: string) {
          select = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          assert.match(column, /^[a-z_]+$/);
          values.push(value);
          where.push(`i.${column} = $${values.length}`);
          return builder;
        },
        lt(column: string, value: unknown) {
          assert.match(column, /^[a-z_]+$/);
          values.push(value);
          where.push(`i.${column} < $${values.length}`);
          return builder;
        },
        order(column: string, options: { ascending: boolean }) {
          assert.equal(column, 'mined_at');
          order = `i.mined_at ${options.ascending ? 'ASC' : 'DESC'}`;
          return builder;
        },
        limit(n: number) {
          limit = n;
          return builder;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          if (select === null) {
            return db
              .query(`DELETE FROM rag_review_items i WHERE ${where.join(' AND ')}`, values)
              .then((result) => ({ error: null, count: result.affectedRows ?? 0 }))
              .then(onFulfilled, onRejected);
          }
          assert.equal(select, ITEM_SELECT);
          const sql = `SELECT i.tenant_key, i.query_masked, i.query_language, i.channel, i.outcome, i.retrieval_config_hash, i.reasons,
              to_char(i.mined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS mined_at,
              CASE WHEN l.id IS NULL THEN NULL
                   ELSE json_build_object('tenant_key', l.tenant_key, 'status', l.status, 'top_score', l.top_score) END AS rag_retrieval_log
            FROM rag_review_items i LEFT JOIN rag_retrieval_log l ON l.id = i.retrieval_log_id
            WHERE ${where.join(' AND ')} ${order ? `ORDER BY ${order}` : ''} ${limit !== null ? `LIMIT ${Number(limit)}` : ''}`;
          return db
            .query<Row>(sql, values)
            .then((result) => ({ data: result.rows, error: null }))
            .then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('mining bridges thumbs-down failures into the terminology miss log (two tenants, fake edge)', () => {
  let db: PGlite;
  let edge: FakeEdge;
  let client: SupabaseClient;
  let mining: typeof import('@/lib/rag/feedback-loop/mining');
  let buildRetrievalLogRow: typeof import('@/lib/rag/feedback-loop/retrieval-log').buildRetrievalLogRow;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let word = 0;
  const questionsByTenant = new Map<string, string[]>();
  const now = Date.now();
  const since = new Date(now - 7 * DAY);
  const until = new Date(now);

  async function insertLog(tenant: Tenant, overrides: Row, bridged: boolean): Promise<void> {
    const question = `Synthetic question ${WORDS[word++]} about the sample topic`;
    const built = buildRetrievalLogRow({
      result: emptyResult(),
      tenantKey: tenant.key,
      stageLatency: { retrieve: 12 },
      latencyMs: 20,
      logContext: { channel: 'chat', userId: tenant.userId, organizationId: tenant.organizationId, chatId: crypto.randomUUID() },
      mode: 'masked_query',
      query: question,
    });
    const values: Row = {
      ...built,
      retrieval_config_hash: 'cfg-hash-fixture',
      outcome: 'answered',
      candidate_count: 3,
      top_score: 0.7,
      source_opened_count: 1,
      created_at: new Date(now - 2 * DAY).toISOString(),
      ...overrides,
    };
    const names = Object.keys(values);
    const bound = names.map((name) => {
      const value = values[name];
      return name === 'candidates' || name === 'stage_latency' ? JSON.stringify(value) : value;
    });
    await db.exec('SET ROLE service_role');
    try {
      await db.query(`INSERT INTO rag_retrieval_log (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, bound);
    } finally {
      await db.exec('RESET ROLE');
    }
    if (bridged) questionsByTenant.set(tenant.key, [...(questionsByTenant.get(tenant.key) ?? []), built.query_masked as string]);
  }

  async function seed(tenant: Tenant): Promise<void> {
    await insertLog(tenant, { feedback_vote: -1, feedback_kind: 'answer' }, true);
    await insertLog(tenant, { outcome: 'refused_no_context', status: 'empty', top_score: 0.1, feedback_vote: -1, feedback_kind: 'refusal' }, true);
    await insertLog(tenant, { status: 'empty', candidate_count: 0, top_score: null }, true);
    await insertLog(tenant, { top_score: 0.1, source_opened_count: 0 }, false);
    await insertLog(tenant, {}, false);
  }

  async function misses(): Promise<Row[]> {
    return (await db.query<Row>('SELECT * FROM rag_term_misses ORDER BY tenant_key, query_masked')).rows;
  }

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
    edge = await startFakeEdge({ db });
    const env = fixtureProcessEnv(edge.url);
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
    mining = await import('@/lib/rag/feedback-loop/mining');
    ({ buildRetrievalLogRow } = await import('@/lib/rag/feedback-loop/retrieval-log'));
    client = hybridClient(createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } }), db);
    tenantA = await createTenant(db);
    tenantB = await createTenant(db);
    await seed(tenantA);
    await seed(tenantB);
  });

  after(async () => {
    await edge?.close();
    await db?.close();
  });

  test('with terminology mining off, a run writes no miss', async () => {
    const result = await mining.runMining({ since, until }, { client, env: { ...ENABLED, RAG_TERMINOLOGY_MINING: 'false' }, log: () => undefined });
    assert.equal(result.status, 'completed');
    assert.ok((result.total_inserted ?? 0) > 0);
    assert.deepEqual(await misses(), []);
    await db.query('DELETE FROM rag_review_items');
  });

  test('with it on, each tenant gets its own feedback misses, with the fixed field list, and a second run adds none', async () => {
    const lines: string[] = [];
    const first = await mining.runMining({ since, until }, { client, env: ENABLED, log: (line) => lines.push(line) });
    assert.equal(first.status, 'completed');
    assert.deepEqual(edge.errors, []);

    const rows = await misses();
    for (const tenant of [tenantA, tenantB]) {
      const own = rows.filter((row) => row.tenant_key === tenant.key);
      assert.deepEqual(own.map((row) => row.query_masked).sort(), [...(questionsByTenant.get(tenant.key) ?? [])].sort());
      for (const row of own) {
        assert.equal(row.source, 'feedback');
        assert.equal(row.profile, 'chat');
        assert.equal(row.retrieval_config_hash, 'cfg-hash-fixture');
        assert.equal(row.reason, null);
        assert.equal(row.dictionary_version, null);
      }
    }
    assert.equal(rows.length, 6);
    const refused = rows.find((row) => row.tenant_key === tenantA.key && row.status === 'empty' && row.top_score !== null);
    assert.ok(refused, 'status and top score come from the item\'s retrieval-log row');
    assert.ok(!lines.join('\n').includes('Synthetic question'));
    assert.ok(lines.some((line) => line.startsWith('[Feedback Loop] terminology bridge {"recorded":6')), lines.join('\n'));

    const second = await mining.runMining({ since, until }, { client, env: ENABLED, log: () => undefined });
    assert.equal(second.total_inserted, 0);
    assert.equal((await misses()).length, 6);
    assert.equal((await db.query('SELECT 1 FROM rag_term_candidates')).rows.length, 0);
  });
});
