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
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar'];
const ENABLED = { RAG_DOMAIN_EXPERT_REVIEW: 'true', RAG_RETRIEVAL_LOG: 'masked_query', RAG_SOURCE_OPEN_SIGNAL: 'true' };

interface Tenant {
  key: string;
  organizationId: string;
  userId: string;
}

async function createTenant(db: PGlite): Promise<Tenant> {
  const userId = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [userId, `user-${userId.slice(0, 8)}@example.invalid`]);
  const organizationId = crypto.randomUUID();
  await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [organizationId, 'Fixture org', `fixture-${organizationId.slice(0, 8)}`, userId]);
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
 * A client whose RPCs go through the fake edge with the service-role key, and whose one table write (the purge of expired
 * open review items: delete().eq().lt()) runs on the database directly, because the fake edge serves reads and RPCs only.
 */
function hybridClient(edgeClient: SupabaseClient, db: PGlite): SupabaseClient {
  return {
    // The fake edge answers a scalar function as [{ fn: value }]; PostgREST answers the bare value.
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
      const builder: Record<string, unknown> = {
        delete: () => builder,
        eq(column: string, value: unknown) {
          assert.match(column, /^[a-z_]+$/);
          values.push(value);
          where.push(`${column} = $${values.length}`);
          return builder;
        },
        lt(column: string, value: unknown) {
          assert.match(column, /^[a-z_]+$/);
          values.push(value);
          where.push(`${column} < $${values.length}`);
          return builder;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          return db
            .query(`DELETE FROM rag_review_items WHERE ${where.join(' AND ')}`, values)
            .then((result) => ({ error: null, count: result.affectedRows ?? 0 }))
            .then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('weekly mining end to end (two tenants, fake edge)', () => {
  let db: PGlite;
  let edge: FakeEdge;
  let client: SupabaseClient;
  let mining: typeof import('@/lib/rag/feedback-loop/mining');
  let buildRetrievalLogRow: typeof import('@/lib/rag/feedback-loop/retrieval-log').buildRetrievalLogRow;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let word = 0;
  const sourceRow = new Map<string, Row>();
  const now = Date.now();
  const since = new Date(now - 7 * DAY);
  const until = new Date(now);

  async function insertLog(tenant: Tenant, overrides: Row): Promise<string> {
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
    assert.ok(built.query_masked && built.query_fingerprint, 'the builder stores the masked query in masked_query mode');
    const values: Row = {
      ...built,
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
      const inserted = await db.query<Row>(
        `INSERT INTO rag_retrieval_log (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        bound,
      );
      const row = inserted.rows[0] as Row;
      assert.equal(row.tenant_key, tenant.key);
      sourceRow.set(String(row.trace_id), row);
      return String(row.trace_id);
    } finally {
      await db.exec('RESET ROLE');
    }
  }

  async function answerRecord(tenant: Tenant, traceId: string, groundedness: unknown): Promise<void> {
    await db.query(
      `INSERT INTO rag_answer_records (id, user_id, organization_id, trace_id, rag_mode, groundedness) VALUES ($1, $2, $3, $4, 'strict', $5)`,
      [crypto.randomUUID(), tenant.userId, tenant.organizationId, traceId, JSON.stringify(groundedness)],
    );
  }

  /** One row per D-13 reason (low_score carries no_source_opened), and a healthy row that matches none. */
  async function seed(tenant: Tenant, extraLowScore: boolean): Promise<void> {
    await insertLog(tenant, { feedback_vote: -1, feedback_kind: 'answer' });
    await insertLog(tenant, { outcome: 'refused_no_context', top_score: 0.1, feedback_vote: -1, feedback_kind: 'refusal' });
    await answerRecord(tenant, await insertLog(tenant, {}), { label: 'possibly_unreliable' });
    await insertLog(tenant, { outcome: 'refused_no_context', top_score: 0.9 });
    await insertLog(tenant, { candidate_count: 0, top_score: null });
    await insertLog(tenant, { top_score: 0.1, source_opened_count: 0 });
    if (extraLowScore) await insertLog(tenant, { top_score: 0.05, source_opened_count: 0 });
    await insertLog(tenant, {});
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
    await seed(tenantA, false);
    await seed(tenantB, true);
  });

  after(async () => {
    await edge?.close();
    await db?.close();
  });

  test('the first run inserts each tenant its own items with the expected counts, the second inserts none', async () => {
    const lines: string[] = [];
    const first = await mining.runMining({ since, until }, { client, env: ENABLED, log: (line) => lines.push(line) });
    assert.equal(first.status, 'completed');
    assert.deepEqual(edge.errors, []);

    const byHash = new Map((first.tenants ?? []).map((tenant) => [tenant.tenant_hash, tenant]));
    assert.equal(byHash.size, 2);
    const one = { feedback_negative: 1, refusal_disputed: 1, groundedness_flagged: 1, refused_high_score: 1, zero_results: 1 };
    assert.deepEqual(byHash.get(mining.tenantHash(tenantA.key)), {
      tenant_hash: mining.tenantHash(tenantA.key),
      inserted: 6,
      by_reason: { ...one, low_score: 1, no_source_opened: 1 },
    });
    assert.deepEqual(byHash.get(mining.tenantHash(tenantB.key)), {
      tenant_hash: mining.tenantHash(tenantB.key),
      inserted: 7,
      by_reason: { ...one, low_score: 2, no_source_opened: 2 },
    });
    assert.equal(first.total_inserted, 13);

    const items = (await db.query<Row>('SELECT * FROM rag_review_items ORDER BY tenant_key, trace_id')).rows;
    assert.equal(items.length, 13);
    for (const item of items) {
      const source = sourceRow.get(String(item.trace_id));
      assert.ok(source, 'every item comes from a seeded log row');
      assert.equal(item.tenant_key, source.tenant_key);
      assert.equal(item.retrieval_log_id, source.id);
      assert.equal(item.query_masked, source.query_masked);
      assert.equal(item.status, 'open');
    }
    assert.equal(items.filter((item) => item.tenant_key === tenantA.key).length, 6);
    assert.equal(items.filter((item) => item.tenant_key === tenantB.key).length, 7);

    const text = JSON.stringify(first) + lines.join('\n');
    for (const tenant of [tenantA, tenantB]) assert.ok(!text.includes(tenant.organizationId));
    assert.ok(!text.includes('Synthetic question'));

    const second = await mining.runMining({ since, until }, { client, env: ENABLED, log: () => undefined });
    assert.equal(second.status, 'completed');
    assert.equal(second.total_inserted, 0);
    for (const tenant of second.tenants ?? []) assert.equal(tenant.inserted, 0);
    assert.equal((await db.query('SELECT 1 FROM rag_review_items')).rows.length, 13);
    assert.deepEqual(edge.errors, []);
  });

  test('the report function is SECURITY INVOKER with an empty search_path, and only the service role may execute it', async () => {
    const proc = (
      await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
        "SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.rag_mine_failed_queries_report(timestamptz, timestamptz, jsonb)'::regprocedure",
      )
    ).rows[0];
    assert.equal(proc?.prosecdef, false);
    assert.ok(proc?.proconfig?.some((entry) => entry === 'search_path=""' || entry === 'search_path='));
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const allowed = (
        await db.query<{ ok: boolean }>(
          "SELECT has_function_privilege($1, 'public.rag_mine_failed_queries_report(timestamptz, timestamptz, jsonb)', 'EXECUTE') AS ok",
          [role],
        )
      ).rows[0]?.ok;
      assert.equal(allowed, role === 'service_role', role);
    }
  });

  test('anon cannot run the mining function through the edge', async () => {
    const env = fixtureProcessEnv(edge.url);
    const anon = createClient(edge.url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await anon.rpc(mining.MINING_RPC, {
      p_since: since.toISOString(),
      p_until: until.toISOString(),
      p_config: { per_tenant_limit: 1, open_item_ttl_days: 1, low_score_ceiling: { similarity: 1, rerank: 1 }, refused_high_score_floor: { similarity: 0, rerank: 0 } },
    });
    assert.ok(error, 'anon is refused');
    assert.equal(data, null);
    edge.errors.length = 0;
  });
});
