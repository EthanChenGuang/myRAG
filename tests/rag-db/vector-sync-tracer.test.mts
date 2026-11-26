import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { createExternalBackend } from '@/lib/rag/backend/external';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { BackendSearchRequest } from '@/lib/rag/backend/types';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
import { queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { drainSlice } from '@/lib/rag/sync/drain';
import { createFakeVectorStore, type FakeVectorStore } from '@/lib/rag/sync/stores/fake';
import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const PROFILE = 'openai-3-small-1536';
const KEY_A = `u:${TWO_TENANT_IDS.userA}`;
const KEY_B = `u:${TWO_TENANT_IDS.userB}`;
const D03_FIELDS = [
  'chunking_profile_id',
  'content_hash',
  'doc_date',
  'doc_type',
  'document_id',
  'language',
  'lexical_text',
  'lexical_version',
  'parent_id',
  'source',
  'tenant_key',
].sort();
const QUERY = 'tracer quartz lantern signal';
const CHUNKS = ['tracer quartz lantern signal one', 'tracer quartz lantern signal two'];
const FILENAME = 'tracer-unique-filename.md';

async function rpc(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await client.rpc(fn, args).abortSignal(new AbortController().signal);
  if (response.error) assert.fail(`${fn} failed: ${response.error.message}`);
  return response.data;
}

async function drainUntilEmpty(store: FakeVectorStore, client: RpcClient): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const report = await drainSlice({ store, rpc: client, budgetMs: 30_000, batch: 100 });
    if (report.claimed === 0) return;
  }
  assert.fail('the outbox did not drain');
}

async function pendingDocumentRows(db: PGlite, docId: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.vector_sync_outbox WHERE target = 'qdrant' AND entity = 'document' AND entity_id = $1 AND status = 'pending'",
    [docId],
  );
  return Number(r.rows[0]?.n);
}

function request(scope: TenantScope): BackendSearchRequest {
  return {
    scope,
    embeddingProfileId: PROFILE,
    denseVector: embedText(QUERY),
    lexicalTokens: queryLexicalTokens(QUERY),
    lexicalLanguages: null,
    filters: { currentOnly: true },
    denseLimit: 50,
    lexicalLimit: 50,
    signal: new AbortController().signal,
  };
}

describe('vector sync tracer: one document out to an external store and back, re-validated (multi-tenant)', () => {
  let db: PGlite;
  let edge: FakeEdge;
  let client: RpcClient;
  let store: FakeVectorStore;
  let docId: string;
  const security: string[] = [];
  const scopeA = mintScope('personal', TWO_TENANT_IDS.userA, null);
  const scopeB = mintScope('personal', TWO_TENANT_IDS.userB, null);

  before(async () => {
    const fixture = await createTwoTenantDatabase();
    db = fixture.db;
    edge = await startFakeEdge({ db });
    const env = fixtureProcessEnv(edge.url);
    client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as RpcClient;
    store = createFakeVectorStore('qdrant');
    await rpc(client, 'rag_vector_sync_set_target', { p_target: 'qdrant', p_enabled: true, p_actor: 'tracer-test' });
    await drainUntilEmpty(store, client);
  });

  after(async () => {
    await edge?.close();
    await db?.close();
  });

  const backend = () =>
    createExternalBackend({ reader: store, adminClient: () => client, securityLog: (line) => security.push(line) });

  test('a chunk written through the Phase 3 writer lands in the outbox and one drain slice upserts it with the D-03 payload only', async () => {
    const begin = (await rpc(client, 'rag_begin_document_version', {
      p_tenant_key: KEY_A,
      p_user_id: TWO_TENANT_IDS.userA,
      p_org_id: null,
      p_source: 'config_upload',
      p_source_key: `tracer-${crypto.randomUUID()}.md`,
      p_filename: FILENAME,
      p_file_sha256: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
      p_doc_type: 'general',
      p_doc_type_origin: 'fallback',
      p_profile_id: 'general-1',
      p_profile_version: 1,
    })) as Array<{ document_id: string }>;
    docId = begin[0]!.document_id;
    await rpc(client, 'rag_write_chunks', {
      p_document_id: docId,
      p_tenant_key: KEY_A,
      p_chunks: CHUNKS.map((content, index) => ({
        chunk_index: index,
        content,
        metadata: { chunk_index: index },
        lexical_text: chunkLexicalText({ sectionPath: [], content, documentFilename: FILENAME }),
      })),
      p_embeddings: { [PROFILE]: CHUNKS.map((content) => embedText(content)) },
      p_final: true,
      p_total: CHUNKS.length,
    });
    await rpc(client, 'rag_publish_document_version', { p_document_id: docId, p_tenant_key: KEY_A });

    assert.ok((await pendingDocumentRows(db, docId)) >= 1, 'the write enqueued the document for qdrant');
    const ids = (await db.query<{ id: string }>('SELECT id FROM public.document_chunks WHERE document_id = $1 ORDER BY id', [docId])).rows.map(
      (row) => row.id,
    );
    assert.equal(ids.length, CHUNKS.length);

    const report = await drainSlice({ store, rpc: client, budgetMs: 30_000, batch: 100 });
    assert.ok(report.claimed >= 1);
    assert.equal(report.failed, 0);
    assert.equal(await pendingDocumentRows(db, docId), 0);

    const points = store.points(PROFILE, KEY_A).filter((point) => point.payload.document_id === docId);
    assert.deepEqual(points.map((point) => point.id).sort(), ids);
    for (const point of points) {
      assert.deepEqual(Object.keys(point.payload).sort(), D03_FIELDS);
      assert.equal(point.payload.tenant_key, KEY_A);
      assert.equal(point.vector.length, 1536);
      // lexical_text is the shared-tokenizer output (D-03, A-11); no other field may carry chunk text.
      const { lexical_text: _lexical, ...rest } = point.payload;
      const serialized = JSON.stringify({ id: point.id, payload: rest });
      for (const content of CHUNKS) assert.ok(!serialized.includes(content), 'no chunk text outside lexical_text');
      assert.ok(!serialized.includes(FILENAME), 'no document name in the point');
    }
    assert.equal(store.points(PROFILE, KEY_B).filter((point) => point.payload.document_id === docId).length, 0);
  });

  test('the external backend returns it to its own tenant, hydrated from Supabase; the other tenant gets nothing', async () => {
    const legsA = await backend().search(request(scopeA));
    const mine = [...legsA.dense, ...legsA.lexical].filter((hit) => hit.documentId === docId);
    assert.ok(legsA.dense.some((hit) => hit.documentId === docId), 'dense leg finds the chunk');
    assert.ok(legsA.lexical.some((hit) => hit.documentId === docId), 'lexical leg finds the chunk');
    for (const hit of mine) {
      assert.ok(CHUNKS.includes(hit.content), 'content comes from Supabase');
      assert.equal(hit.document.filename, FILENAME);
    }
    assert.equal(legsA.meta?.tenantValidationDropped, 0);

    const legsB = await backend().search(request(scopeB));
    assert.equal([...legsB.dense, ...legsB.lexical].filter((hit) => hit.documentId === docId).length, 0);
    assert.equal(security.length, 0);
  });

  test('after the document is deleted the next drain removes its points and the search is empty', async () => {
    await db.query('DELETE FROM public.documents WHERE id = $1', [docId]);
    assert.ok((await pendingDocumentRows(db, docId)) >= 1, 'the delete enqueued the document');
    const report = await drainSlice({ store, rpc: client, budgetMs: 30_000, batch: 100 });
    assert.ok(report.deleted >= CHUNKS.length);
    assert.equal(store.points(PROFILE, KEY_A).filter((point) => point.payload.document_id === docId).length, 0);

    const legsA = await backend().search(request(scopeA));
    assert.equal([...legsA.dense, ...legsA.lexical].filter((hit) => hit.documentId === docId).length, 0);
  });
});
