import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const QUERY = 'What was revenue last year?';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const MID_YEAR = Date.parse('2026-06-15T12:00:00.000Z');
/** 20:00 UTC on 31 December is already 1 January 2026 in Asia/Shanghai. */
const YEAR_BOUNDARY = Date.parse('2025-12-31T20:00:00.000Z');
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true, ragMode: 'balanced' as const };

const ENV = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'true',
  RAG_RERANKER: 'none',
  RAG_REFUSAL_THRESHOLD: 'false',
  RAG_QUERY_LAYER: 'true',
  RAG_SEMANTIC_CACHE: 'off',
};

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

async function seedChunk(db: TwoTenantDatabase['db'], userId: string, tenantKey: string, docDate: string | null, label: string): Promise<string> {
  const docId = crypto.randomUUID();
  const chunkId = crypto.randomUUID();
  const text = `What was revenue last year? Synthetic ${label} record.`;
  await db.query(
    'INSERT INTO documents (id, filename, content, user_id, doc_date, is_current, status) VALUES ($1, $2, $3, $4, $5::date, true, $6)',
    [docId, `${label}.md`, text, userId, docDate, 'ready'],
  );
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, source, doc_date)
     VALUES ($1, $2, $3, $4::vector, $3, $5, true, 'ready', 'manual', $6::date)`,
    [chunkId, docId, text, vec(text), tenantKey, docDate],
  );
  return chunkId;
}

describe('relative-date retrieval keeps undated chunks of the tenant (06-24, D-11)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let depsModule: typeof import('@/lib/rag/deps');
  let fakeModule: typeof import('../../eval/harness/fake-query-llm.mts');
  const saved: Record<string, string | undefined> = {};
  const ids = { dated2025: '', dated2024: '', undatedA: '', undatedB: '' };

  before(async () => {
    fixture = await createTwoTenantDatabase();
    ids.dated2025 = await seedChunk(fixture.db, TWO_TENANT_IDS.userA, TENANT_A, '2025-06-01', 'mid-2025');
    ids.dated2024 = await seedChunk(fixture.db, TWO_TENANT_IDS.userA, TENANT_A, '2024-06-01', 'mid-2024');
    ids.undatedA = await seedChunk(fixture.db, TWO_TENANT_IDS.userA, TENANT_A, null, 'undated-a');
    ids.undatedB = await seedChunk(fixture.db, TWO_TENANT_IDS.userB, TENANT_B, null, 'undated-b');
    edge = await startFakeEdge({ db: fixture.db });
    const names = ['NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'MYRAG_DEPLOYMENT_MODE', ...Object.keys(ENV), ...Object.keys(fixtureProcessEnv(edge.url))];
    for (const name of names) saved[name] = process.env[name];
    Object.assign(process.env, fixtureProcessEnv(edge.url), ENV);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    depsModule = await import('@/lib/rag/deps');
    fakeModule = await import('../../eval/harness/fake-query-llm.mts');
    const { resetRagConfigForTests } = await import('@/lib/rag/config');
    const { resetRetrievalBackendForTests } = await import('@/lib/rag/backend/registry');
    resetRagConfigForTests();
    resetRetrievalBackendForTests();
  });

  beforeEach(() => {
    depsModule.resetRagDepsForTests();
  });

  after(async () => {
    depsModule?.resetRagDepsForTests();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await edge?.close();
    await fixture?.db.close();
  });

  const retrieve = async (userId: string, now: number, timeZone?: string) => {
    const fake = fakeModule.createFakeQueryLlm();
    depsModule.setRagDepsForTests({ queryLlm: () => fake, now: () => now });
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    const result = await rag.runRetrieval({
      scope: resolved.scope,
      query: QUERY,
      profile: 'chat',
      options: OPTIONS,
      ...(timeZone ? { timeZone } : {}),
      signal: new AbortController().signal,
    });
    return { result, chunkIds: result.candidates.map((candidate) => candidate.chunk_id) };
  };

  test('last year with now in mid-2026 keeps the 2025 and the undated chunk, drops the 2024 chunk, and traces the UTC range', async () => {
    const { result, chunkIds } = await retrieve(TWO_TENANT_IDS.userA, MID_YEAR);
    assert.ok(result.stages.some((entry) => entry.name === 'fuse'), 'the v2 graph ran');
    assert.equal(result.stages.find((entry) => entry.name === 'normalize_dates')?.status, 'ok');
    assert.deepEqual(result.queryPlan?.date_range, { from_date: '2025-01-01', to_date: '2025-12-31', include_undated: true, time_zone: 'UTC' });
    assert.ok(chunkIds.includes(ids.dated2025), 'the in-range dated chunk');
    assert.ok(chunkIds.includes(ids.undatedA), "the tenant's undated chunk");
    assert.ok(!chunkIds.includes(ids.dated2024), 'never the out-of-range dated chunk');
    assert.ok(!chunkIds.includes(ids.undatedB), "never another tenant's undated chunk");
    const original = result.queryPlan?.variants?.find((variant) => variant.kind === 'original');
    assert.equal(original?.text, QUERY, 'the plan keeps the original text; only the dense text carries the dates');
  });

  test('near a year boundary the request time zone picks the local year', async () => {
    const utc = await retrieve(TWO_TENANT_IDS.userA, YEAR_BOUNDARY);
    assert.equal(utc.result.queryPlan?.date_range?.from_date, '2024-01-01');
    assert.equal(utc.result.queryPlan?.date_range?.time_zone, 'UTC');
    assert.ok(utc.chunkIds.includes(ids.dated2024));
    assert.ok(!utc.chunkIds.includes(ids.dated2025));
    assert.ok(utc.chunkIds.includes(ids.undatedA));

    const shanghai = await retrieve(TWO_TENANT_IDS.userA, YEAR_BOUNDARY, 'Asia/Shanghai');
    assert.deepEqual(shanghai.result.queryPlan?.date_range, {
      from_date: '2025-01-01',
      to_date: '2025-12-31',
      include_undated: true,
      time_zone: 'Asia/Shanghai',
    });
    assert.ok(shanghai.chunkIds.includes(ids.dated2025));
    assert.ok(!shanghai.chunkIds.includes(ids.dated2024));
    assert.ok(shanghai.chunkIds.includes(ids.undatedA));
  });

  test("tenant B's undated chunk never appears for tenant A, and B sees only its own", async () => {
    const a = await retrieve(TWO_TENANT_IDS.userA, MID_YEAR);
    assert.ok(!a.chunkIds.includes(ids.undatedB));
    const b = await retrieve(TWO_TENANT_IDS.userB, MID_YEAR);
    assert.ok(b.chunkIds.includes(ids.undatedB), "B's own undated chunk");
    for (const id of [ids.dated2025, ids.dated2024, ids.undatedA]) assert.ok(!b.chunkIds.includes(id), `B saw A's chunk ${id}`);
    assert.deepEqual(edge.errors, []);
  });
});
