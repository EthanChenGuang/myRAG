import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
import { createFakeVectorStore, type FakeVectorStore } from '@/lib/rag/sync/stores/fake';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import type { RetrievalResult } from '@/lib/rag/types';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createEmptyFixtureDatabase, FIXTURE_USER_ID, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// RET-05 tracer (07-37): with RAG_RETRIEVAL_BACKEND=qdrant and RAG_SOURCE_RECHECK off, a document deleted in Supabase while the outbox
// has not drained is still a point in the store; the request drops it, counts stale_index_drop, schedules one repair for the caller's
// tenant after the response, and one drain removes the point. Neutral synthetic sentences only.

const PROFILE = 'openai-3-small-1536';
const USER_B = '00000000-0000-4000-8000-0000000007b2';
const QUERY = 'cobalt heron ledger whisper';
const STALE_TEXT = 'cobalt heron ledger whisper stale sample';
const KEEP_TEXT = 'cobalt heron ledger whisper kept sample';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true, ragMode: 'balanced' as const };
const ENV: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'true',
  RAG_RERANKER: 'none',
  RAG_REFUSAL_THRESHOLD: 'false',
  RAG_QUERY_LAYER: 'false',
  RAG_SEMANTIC_CACHE: 'off',
  RAG_DOC_ACCESS_GROUPS: 'off',
  RAG_RETRIEVAL_BACKEND: 'qdrant',
  RAG_SOURCE_RECHECK: 'false',
};

let sharedEdge: FakeEdge | null = null;
const savedEnv: Record<string, string | undefined> = {};

after(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await sharedEdge?.close();
});

async function rpc(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await client.rpc(fn, args).abortSignal(new AbortController().signal);
  if (response.error) assert.fail(`${fn} failed: ${response.error.message}`);
  return response.data;
}

for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  describe(`RET-05: a stale external point is dropped, counted and repaired (${mode})`, () => {
    const multi = mode === 'multi-tenant';
    const keyA = multi ? `u:${FIXTURE_USER_ID}` : 's:default';
    const keyB = `u:${USER_B}`;
    let db: PGlite;
    let client: RpcClient;
    let store: FakeVectorStore;
    let staleDoc: string;
    let staleChunk: string;
    let keepDoc: string;
    let docB: string | null = null;
    const recorded: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const tasks: Array<() => Promise<void>> = [];
    let kicks = 0;
    let scopeA: TenantScope;
    let scopeB: TenantScope | null = null;
    let rag: typeof import('@/lib/rag');
    let drain: typeof import('@/lib/rag/sync/drain');
    let repair: typeof import('@/lib/rag/backend/stale-repair');

    async function writeDocument(tenantKey: string, userId: string, text: string): Promise<{ docId: string; chunkId: string }> {
      const filename = `recheck-${crypto.randomUUID()}.md`;
      const begin = (await rpc(client, 'rag_begin_document_version', {
        p_tenant_key: tenantKey,
        p_user_id: userId,
        p_org_id: null,
        p_source: 'config_upload',
        p_source_key: filename,
        p_filename: filename,
        p_file_sha256: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
        p_doc_type: 'general',
        p_doc_type_origin: 'fallback',
        p_profile_id: 'general-1',
        p_profile_version: 1,
      })) as Array<{ document_id: string }>;
      const docId = begin[0]!.document_id;
      await rpc(client, 'rag_write_chunks', {
        p_document_id: docId,
        p_tenant_key: tenantKey,
        p_chunks: [{ chunk_index: 0, content: text, metadata: { chunk_index: 0 }, lexical_text: chunkLexicalText({ sectionPath: [], content: text, documentFilename: filename }) }],
        p_embeddings: { [PROFILE]: [embedText(text)] },
        p_final: true,
        p_total: 1,
      });
      await rpc(client, 'rag_publish_document_version', { p_document_id: docId, p_tenant_key: tenantKey });
      const chunk = await db.query<{ id: string }>('SELECT id::text FROM public.document_chunks WHERE document_id = $1', [docId]);
      return { docId, chunkId: chunk.rows[0]!.id };
    }

    async function drainUntilEmpty(): Promise<void> {
      for (let i = 0; i < 50; i += 1) {
        const report = await drain.drainSlice({ store, rpc: client, budgetMs: 30_000, batch: 100, sink: () => undefined, trace: false });
        if (report.claimed === 0) return;
      }
      assert.fail('the outbox did not drain');
    }

    const docPoints = (tenantKey: string, docId: string) => store.points(PROFILE, tenantKey).filter((point) => point.payload.document_id === docId);

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      if (multi) await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [USER_B, 'tenant-b@example.invalid']);
      if (sharedEdge === null) {
        sharedEdge = await startFakeEdge({ db });
        const names = ['NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'MYRAG_DEPLOYMENT_MODE', ...Object.keys(ENV), ...Object.keys(fixtureProcessEnv(sharedEdge.url))];
        for (const name of names) savedEnv[name] = process.env[name];
      } else {
        sharedEdge.useDatabase(db);
      }
      const processEnv = fixtureProcessEnv(sharedEdge.url);
      Object.assign(process.env, processEnv, ENV);
      process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
      process.env.MYRAG_DEPLOYMENT_MODE = mode;

      const real = createClient(sharedEdge.url, processEnv.SUPABASE_SERVICE_ROLE_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      client = real as unknown as RpcClient;
      const recording = new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'rpc') {
            return (fn: string, args?: Record<string, unknown>, opts?: Parameters<SupabaseClient['rpc']>[2]) => {
              recorded.push({ fn, args: { ...(args ?? {}) } });
              return target.rpc(fn, args, opts);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      rag = await import('@/lib/rag');
      drain = await import('@/lib/rag/sync/drain');
      repair = await import('@/lib/rag/backend/stale-repair');
      const scopeModule = await import('@/lib/rag/tenant/scope');
      const depsModule = await import('@/lib/rag/deps');
      const factory = await import('@/lib/rag/backend/factory');
      const external = await import('@/lib/rag/backend/external');
      (await import('@/lib/rag/embeddings/registry')).resetEmbeddingProvidersForTests();
      (await import('@/lib/rag/embeddings/active-profile')).resetActiveProfileForTests();
      (await import('@/lib/rag/backend/readiness')).resetReadinessCacheForTests();
      depsModule.resetRagDepsForTests();
      depsModule.setRagDepsForTests({ adminClient: () => recording });
      (await import('@/lib/rag/config')).resetRagConfigForTests();
      (await import('@/lib/rag/backend/registry')).resetRetrievalBackendForTests();
      factory.resetBackendFactoryForTests();
      repair.resetStaleRepairForTests();
      repair.setStaleRepairDepsForTests({ schedule: (task) => tasks.push(task), kick: () => (kicks += 1) });

      store = createFakeVectorStore('qdrant');
      factory.setExternalBackendForTests('qdrant', external.createExternalBackend({ reader: store, adminClient: () => recording as unknown as RpcClient, securityLog: () => undefined }));

      scopeA = multi ? scopeModule.mintScope('personal', FIXTURE_USER_ID, null) : scopeModule.mintScope('single', null, null);
      if (multi) scopeB = scopeModule.mintScope('personal', USER_B, null);

      await rpc(client, 'rag_vector_sync_set_target', { p_target: 'qdrant', p_enabled: true, p_actor: 'recheck-test' });
      await drainUntilEmpty();
      ({ docId: staleDoc, chunkId: staleChunk } = await writeDocument(keyA, FIXTURE_USER_ID, STALE_TEXT));
      ({ docId: keepDoc } = await writeDocument(keyA, FIXTURE_USER_ID, KEEP_TEXT));
      if (multi) docB = (await writeDocument(keyB, USER_B, STALE_TEXT)).docId;
      await drainUntilEmpty();
      for (const key of multi ? [keyA, keyB] : [keyA]) {
        await db.query("INSERT INTO public.rag_backend_index_state (target, profile_id, tenant_key, state) VALUES ('qdrant', $1, $2, 'ready')", [PROFILE, key]);
      }
      assert.equal(docPoints(keyA, staleDoc).length, 1, 'the stale document was drained into the store');

      // Deleted in Supabase; the outbox row the delete enqueued is not drained yet.
      await db.query('DELETE FROM public.document_chunks WHERE document_id = $1', [staleDoc]);
      await db.query('DELETE FROM public.documents WHERE id = $1', [staleDoc]);
      assert.equal(docPoints(keyA, staleDoc).length, 1, 'the point is still in the store');
    });

    after(async () => {
      (await import('@/lib/rag/backend/factory')).resetBackendFactoryForTests();
      repair?.resetStaleRepairForTests();
      (await import('@/lib/rag/config')).resetRagConfigForTests();
      (await import('@/lib/rag/deps')).resetRagDepsForTests();
      await db?.close();
    });

    const retrieve = async (scope: TenantScope): Promise<{ result: RetrievalResult; calls: typeof recorded }> => {
      const start = recorded.length;
      const result = await rag.runRetrieval({ scope, query: QUERY, profile: 'chat', options: OPTIONS, signal: new AbortController().signal });
      return { result, calls: recorded.slice(start) };
    };
    const docIds = (result: RetrievalResult) => result.candidates.map((row) => String(row.document_id));
    const searchAttributes = (result: RetrievalResult) => result.stages.find((stage) => stage.name === 'search')?.attributes ?? {};

    test('RAG_SOURCE_RECHECK off: the deleted document is dropped and counted in one query, and one repair is scheduled after the response', async () => {
      const { result, calls } = await retrieve(scopeA);
      assert.equal(searchAttributes(result).backend, 'qdrant', 'qdrant served the request');
      assert.ok(!docIds(result).includes(staleDoc), 'the deleted document never reaches the result');
      assert.ok(docIds(result).includes(keepDoc), 'the current document is still found');
      assert.equal(result.sourceRecheck?.dropped, 1);
      assert.equal(searchAttributes(result).stale_index_drop, 1);
      assert.equal(searchAttributes(result).tenant_validation_dropped, 1);
      assert.equal(calls.filter((call) => call.fn === 'rag_validate_chunks').length, 1, 'one re-validation query');
      assert.equal(calls.filter((call) => call.fn === 'rag_source_recheck').length, 0, 'no second recheck query');
      assert.ok(!result.stages.some((stage) => stage.name === 'source_recheck'));
      assert.equal(calls.filter((call) => call.fn === 'rag_vector_sync_enqueue_stale').length, 0, 'nothing is enqueued before the response');
      assert.ok(!JSON.stringify(result.stages).includes(staleChunk), 'the dropped id is not in the trace');

      assert.equal(tasks.length, 1);
      const before = recorded.length;
      for (const task of tasks.splice(0)) await task();
      const enqueued = recorded.slice(before).filter((call) => call.fn === 'rag_vector_sync_enqueue_stale');
      assert.equal(enqueued.length, 1);
      assert.deepEqual(enqueued[0]!.args, { p_target: 'qdrant', p_tenant_key: keyA, p_chunk_ids: [staleChunk] });
      assert.equal(kicks, 1);
      const outbox = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.vector_sync_outbox WHERE target = 'qdrant' AND entity = 'chunk' AND entity_id = $1 AND tenant_key = $2 AND status = 'pending'",
        [staleChunk, keyA],
      );
      assert.equal(Number(outbox.rows[0]?.n), 1);

      await drain.drainSlice({ store, rpc: client, budgetMs: 30_000, batch: 100, sink: () => undefined, trace: false });
      assert.equal(docPoints(keyA, staleDoc).length, 0, 'one drain removes the stale point');
    });

    test('a second request within the window schedules no further repair', async () => {
      await db.query('DELETE FROM public.document_chunks WHERE document_id = $1', [keepDoc]);
      const { result } = await retrieve(scopeA);
      assert.ok(!docIds(result).includes(keepDoc));
      assert.equal(searchAttributes(result).stale_index_drop, 1);
      assert.equal(tasks.length, 0, 'rate limited per target and tenant');
    });

    test('the other tenant is unaffected: its own document, no drop, no repair', { skip: multi ? false : 'single-tenant has one tenant' }, async () => {
      const { result, calls } = await retrieve(scopeB!);
      assert.equal(searchAttributes(result).backend, 'qdrant');
      assert.deepEqual([...new Set(docIds(result))], [docB]);
      assert.equal(searchAttributes(result).stale_index_drop, 0);
      assert.equal(result.sourceRecheck?.dropped, 0);
      assert.equal(calls.filter((call) => call.fn === 'rag_source_recheck').length, 0);
      assert.equal(tasks.length, 0);
    });
  });
}
