import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { hit } from '../rag/fusion/helpers.ts';

const KEY_A = `u:${TWO_TENANT_IDS.userA}`;
const KEY_B = `u:${TWO_TENANT_IDS.userB}`;
const PARENT_A = '00000000-0000-4000-8000-00000000a2a1';
const PARENT_B = '00000000-0000-4000-8000-00000000b2b1';
const TEXT_A = 'PARENT-OF-TENANT-A: the whole alpha section, with the sentence around the matched child.';
const TEXT_B = 'PARENT-OF-TENANT-B: the whole bravo section, with the sentence around the matched child.';

function survivors(items: Array<{ chunkId: string; documentId: string; filename: string; parentId: string | null }>): FusedHit[] {
  return items.map((item, index) => ({
    hit: hit(item.chunkId, {
      rank: index + 1,
      documentId: item.documentId,
      parentId: item.parentId,
      chunkIndex: index,
      content: `child body of ${item.chunkId}`,
      similarity: 0.9 - index * 0.01,
      document: { filename: item.filename, createdAt: null, metadata: {}, contentPreview: '' },
    }),
    score: 1 / (60 + index + 1),
    ranks: { 'dense:0': index + 1 },
  }));
}

describe('expand_parents on the two-tenant fixture', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let client: SupabaseClient;
  let scopeA: TenantScope;
  let scopeB: TenantScope;
  let configModule: typeof import('@/lib/rag/config');
  let depsModule: typeof import('@/lib/rag/deps');
  let collectorModule: typeof import('@/lib/rag/trace/collector');
  let paramsModule: typeof import('@/lib/rag/v2/retrieval-params');
  let contextModule: typeof import('@/lib/rag/v2/stages/context');

  before(async () => {
    fixture = await createTwoTenantDatabase();
    const { db } = fixture;
    await db.query(
      `INSERT INTO document_parents (id, document_id, tenant_key, version, is_current, chunking_profile_id, section_path, content, token_count, parent_index)
       VALUES ($1, $2, $3, 1, true, 'legacy', '{}', $4, 20, 0),
              ($5, $6, $7, 1, true, 'legacy', '{}', $8, 20, 0)`,
      [PARENT_A, TWO_TENANT_IDS.docA, KEY_A, TEXT_A, PARENT_B, TWO_TENANT_IDS.docB, KEY_B, TEXT_B],
    );
    await db.query('UPDATE document_chunks SET parent_id = $1 WHERE id = $2', [PARENT_A, TWO_TENANT_IDS.chunkA]);
    await db.query('UPDATE document_chunks SET parent_id = $1 WHERE id = $2', [PARENT_B, TWO_TENANT_IDS.chunkB]);

    edge = await startFakeEdge({ db });
    const env = fixtureProcessEnv(edge.url);
    client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    Object.assign(process.env, env);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    configModule = await import('@/lib/rag/config');
    depsModule = await import('@/lib/rag/deps');
    collectorModule = await import('@/lib/rag/trace/collector');
    paramsModule = await import('@/lib/rag/v2/retrieval-params');
    contextModule = await import('@/lib/rag/v2/stages/context');
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    scopeA = mintScope('personal', TWO_TENANT_IDS.userA, null);
    scopeB = mintScope('personal', TWO_TENANT_IDS.userB, null);
    depsModule.setRagDepsForTests({ adminClient: () => client });
  });

  afterEach(() => {
    configModule.resetRagConfigForTests();
  });

  after(async () => {
    depsModule?.resetRagDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  function fetchCalls(): number {
    return edge.calls.filter((call) => call.path.includes('rag_fetch_parents')).length;
  }

  async function runStages(scope: TenantScope, hits: FusedHit[], over: Record<string, string> = { RAG_PARENT_CHILD: 'true' }) {
    configModule.resetRagConfigForTests();
    const config = configModule.loadRagConfig({ RAG_PIPELINE: 'v2', ...over });
    const collector = collectorModule.createTraceCollector({ profile: 'chat', tenantKey: `u:${scope.userId}` });
    const params = { ...paramsModule.effectiveRetrievalParams('chat', config, null), final_top_k: 20 };
    const out = await contextModule.runContextStages({
      input: { scope, query: 'canary phrase', profile: 'chat', signal: new AbortController().signal },
      config,
      profile: 'chat',
      params,
      fusedHits: hits,
      referenced: null,
      signal: new AbortController().signal,
      collector,
    });
    return { out, collector };
  }

  const own = (parentId: string | null, who: 'a' | 'b') =>
    who === 'a'
      ? { chunkId: TWO_TENANT_IDS.chunkA, documentId: TWO_TENANT_IDS.docA, filename: 'tenant-a-personal.md', parentId }
      : { chunkId: TWO_TENANT_IDS.chunkB, documentId: TWO_TENANT_IDS.docB, filename: 'tenant-b-personal.md', parentId };

  test("tenant A gets its own parent and never tenant B's, even when a survivor carries B's parent id", async () => {
    const before = fetchCalls();
    const forged = [
      own(PARENT_A, 'a'),
      { chunkId: 'forged-child-1', documentId: TWO_TENANT_IDS.docA, filename: 'tenant-a-personal.md', parentId: PARENT_B },
      { chunkId: 'forged-child-2', documentId: TWO_TENANT_IDS.docB, filename: 'tenant-b-personal.md', parentId: PARENT_B },
    ];
    const { out, collector } = await runStages(scopeA, survivors(forged));
    const context = out.assembly?.context ?? '';

    assert.equal(fetchCalls() - before, 1, 'one fetch for the whole survivor list');
    assert.equal(context.split(TEXT_A).length - 1, 1, 'own parent appears once');
    assert.ok(!context.includes('PARENT-OF-TENANT-B'), 'foreign parent content must not appear');
    assert.ok(!context.includes('bravo section'), 'foreign parent content must not appear');
    assert.ok(context.includes('child body of forged-child-1'), 'a child with a foreign parent id stays a child');
    const record = collector.stages().find((row) => row.name === 'expand_parents');
    assert.equal(record?.status, 'ok');
    assert.equal(record?.counts?.parents_fetched, 1);
    assert.equal(record?.counts?.parents_used, 1);
  });

  test('tenant B gets its own parent and nothing of tenant A', async () => {
    const { out } = await runStages(scopeB, survivors([own(PARENT_B, 'b'), own(PARENT_A, 'a')]));
    const context = out.assembly?.context ?? '';
    assert.equal(context.split(TEXT_B).length - 1, 1);
    assert.ok(!context.includes('PARENT-OF-TENANT-A'));
    assert.ok(!context.includes('alpha section'));
  });

  test('the parent request carries the scope key and the service key reaches the function', async () => {
    const rpc = await client.rpc('rag_fetch_parents', { p_tenant_key: KEY_A, p_parent_ids: [PARENT_A, PARENT_B] });
    assert.equal(rpc.error, null);
    const rows = (rpc.data ?? []) as Array<{ id: string; tenant_key: string }>;
    assert.deepEqual(rows.map((row) => row.id), [PARENT_A]);
    assert.ok(rows.every((row) => row.tenant_key === KEY_A));
  });

  test('an anon client cannot call rag_fetch_parents', async () => {
    const env = fixtureProcessEnv(edge.url);
    const anon = createClient(edge.url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const rpc = await anon.rpc('rag_fetch_parents', { p_tenant_key: KEY_A, p_parent_ids: [PARENT_A] });
    assert.ok(rpc.error, 'anon must be refused');
    assert.ok(!rpc.data || (rpc.data as unknown[]).length === 0);
  });

  test('a refused request makes no parent call and records the stage with zero candidates', async () => {
    const before = fetchCalls();
    const { out, collector } = await runStages(scopeA, []);
    assert.equal(fetchCalls(), before);
    const record = collector.stages().find((row) => row.name === 'expand_parents');
    assert.equal(record?.candidates_in, 0);
    assert.equal(record?.status, 'ok');
    assert.equal(out.candidates.length, 0);
  });

  test('with the switch off no parent call is made and the stage is recorded disabled', async () => {
    const before = fetchCalls();
    const { out, collector } = await runStages(scopeA, survivors([own(PARENT_A, 'a')]), {});
    assert.equal(fetchCalls(), before);
    assert.equal(collector.stages().find((row) => row.name === 'expand_parents')?.status, 'disabled');
    assert.ok((out.assembly?.context ?? '').includes('child body of'));
    assert.ok(!(out.assembly?.context ?? '').includes(TEXT_A));
  });
});
