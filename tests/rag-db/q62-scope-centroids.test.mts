import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { EmbeddingProfile } from '@/lib/rag/embeddings/active-profile';
import type { TenantScope } from '@/lib/rag/tenant/scope';

const PLACEHOLDER_ENV: Record<string, string> = {
  OPENAI_API_KEY: 'placeholder-openai-key',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:1',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder-anon-key',
};
for (const [name, value] of Object.entries(PLACEHOLDER_ENV)) process.env[name] ??= value;

const { resetRagDepsForTests, setRagDepsForTests } = await import('@/lib/rag/deps');
const { LEGACY_PROFILE } = await import('@/lib/rag/embeddings/active-profile');
const { mintScope } = await import('@/lib/rag/tenant/scope');
const { rebuildScopeCentroids } = await import('@/lib/rag/scope/build');
const { centroidRefreshesSettledForTests, getCentroidSnapshot, resetCentroidCacheForTests } = await import('@/lib/rag/scope/centroids');
const { addScopeExample, deleteScopeExample, scopeGateStatus } = await import('@/lib/rag/scope/admin');

const USER_A = '00000000-0000-4000-8000-0000000018a1';
const USER_B = '00000000-0000-4000-8000-0000000018b1';
const KEY_A = `u:${USER_A}`;
const KEY_B = `u:${USER_B}`;
const SCOPE_A: TenantScope = mintScope('personal', USER_A, null);
const SCOPE_B: TenantScope = mintScope('personal', USER_B, null);
const LEGACY = LEGACY_PROFILE.id;
const HALF: EmbeddingProfile = {
  ...LEGACY_PROFILE,
  id: 'bge-m3-1024',
  provider: 'deepinfra',
  model: 'BAAI/bge-m3',
  dims: 1024,
  storage: 'halfvec',
  status: 'available',
};

const CASTS: Record<string, string> = { p_embedding: 'public.halfvec', p_actor: 'uuid', p_id: 'uuid' };
const SCALAR = new Set(['rag_scope_example_delete']);

function serviceRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const names = Object.keys(args);
      const params = names.map((name, index) => `${name} => $${index + 1}${CASTS[name] ? `::${CASTS[name]}` : ''}`).join(', ');
      const sql = SCALAR.has(fn) ? `SELECT public.${fn}(${params}) AS value` : `SELECT * FROM public.${fn}(${params})`;
      const pending: Promise<RpcResponse> = db
        .transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          return (await tx.query<Record<string, unknown>>(sql, names.map((name) => args[name]))).rows;
        })
        .then((rows): RpcResponse => ({ data: SCALAR.has(fn) ? (rows[0]?.value ?? null) : rows, error: null }))
        .catch((error: unknown): RpcResponse => ({
          data: null,
          error: { message: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code },
        }));
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => pending.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

function sparse(dims: number, values: number[]): string {
  const out = new Array<number>(dims).fill(0);
  values.forEach((value, index) => {
    out[index] = value;
  });
  return `[${out.join(',')}]`;
}

async function insertDoc(db: PGlite, userId: string, docType: string, scopes: string[] = [], status = 'ready'): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO documents (id, filename, content, metadata, lineage_id, source_key, status, is_current, doc_type, scopes, user_id)
     VALUES ($1, $2, 'A neutral synthetic paragraph.', '{}', $1, $3, $4, true, $5, $6, $7)`,
    [id, `doc-${id}.md`, `legacy:${id}`, status, docType, scopes, userId],
  );
  return id;
}

async function insertChunk(db: PGlite, documentId: string, language: string, vector: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata, language, embedding, is_current, status)
     VALUES ($1, $2, 'A neutral synthetic sentence.', 0, '{}'::jsonb, $3, $4::vector, true, 'ready')`,
    [id, documentId, language, vector],
  );
  return id;
}

async function centroidCount(db: PGlite, tenantKey: string): Promise<number> {
  const result = await db.query<{ n: string | number }>('SELECT count(*) AS n FROM public.rag_scope_centroids WHERE tenant_key = $1', [tenantKey]);
  return Number(result.rows[0]?.n ?? 0);
}

describe('scope centroids through the build, loader and example services (multi-tenant PGlite)', () => {
  let db: PGlite;
  const embedded: string[] = [];

  before(async () => {
    ({ db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' }));
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [USER_A, 'scope-a@example.invalid', USER_B, 'scope-b@example.invalid']);
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec('DELETE FROM public.rag_scope_negative_examples; DELETE FROM public.rag_scope_centroids;');
    await db.exec('DELETE FROM chunk_embeddings; DELETE FROM document_chunks; DELETE FROM documents;');
    embedded.length = 0;
    resetCentroidCacheForTests();
    setRagDepsForTests({
      adminClient: () => serviceRpc(db) as never,
      embedder: async (text) => {
        embedded.push(text);
        return new Array<number>(1536).fill(0).map((_, index) => (index === 0 ? 1 : 0));
      },
      profileEmbedder: async (text, { profile }) => {
        embedded.push(text);
        return { vector: new Array<number>(profile.dims).fill(0).map((_, index) => (index === 1 ? 1 : 0)), model: profile.model };
      },
    });
  });

  afterEach(async () => {
    await centroidRefreshesSettledForTests();
    resetRagDepsForTests();
  });

  async function seed(): Promise<void> {
    const docA = await insertDoc(db, USER_A, 'general', ['region:north']);
    const docA2 = await insertDoc(db, USER_A, 'general');
    await insertChunk(db, docA, 'en', sparse(1536, [0.5, 0.25]));
    await insertChunk(db, docA, 'en', sparse(1536, [0.25, 0.5]));
    await insertChunk(db, docA2, 'en', sparse(1536, [0.75, 0, 0.5]));
    await insertChunk(db, docA2, 'it', sparse(1536, [0, 0, 1]));
    const quarantined = await insertDoc(db, USER_A, 'general', [], 'quarantined');
    await insertChunk(db, quarantined, 'en', sparse(1536, [9, 9, 9]));
    const docB = await insertDoc(db, USER_B, 'product_technical');
    await insertChunk(db, docB, 'zh', sparse(1536, [0, 0, 0, 1]));
  }

  test('a rebuild for tenant A yields the SQL counts and writes nothing for tenant B', async () => {
    await seed();
    const result = await rebuildScopeCentroids(SCOPE_A, { profile: LEGACY_PROFILE });
    assert.equal(result.tenantKey, KEY_A);
    assert.equal(result.profileId, LEGACY);
    assert.deepEqual(result.counts, {
      doc_type: { groups: 2, chunks: 4 },
      scope_tag: { groups: 1, chunks: 2 },
      tenant: { groups: 2, chunks: 4 },
    });
    assert.ok((await centroidCount(db, KEY_A)) === 5);
    assert.equal(await centroidCount(db, KEY_B), 0);
  });

  test('the loader reads tenant A unit-normalized centroids and never sees tenant B', async () => {
    await seed();
    await rebuildScopeCentroids(SCOPE_A, { profile: LEGACY_PROFILE });
    await rebuildScopeCentroids(SCOPE_B, { profile: LEGACY_PROFILE });
    assert.equal(getCentroidSnapshot(SCOPE_A, LEGACY), null);
    await centroidRefreshesSettledForTests();
    const snapshot = getCentroidSnapshot(SCOPE_A, LEGACY);
    assert.ok(snapshot);
    assert.equal(snapshot.tenantKey, KEY_A);
    assert.equal(snapshot.dims, 1536);
    assert.equal(snapshot.unsupported, false);
    assert.deepEqual(snapshot.centroids.map((c) => `${c.kind}|${c.key}`).sort(), [
      'doc_type|general/en',
      'doc_type|general/it',
      'scope_tag|region:north/en',
      'tenant|tenant/en',
      'tenant|tenant/it',
    ]);
    for (const centroid of snapshot.centroids) {
      assert.equal(centroid.vector.length, 1536);
      const norm = Math.sqrt(Array.from(centroid.vector).reduce((sum, value) => sum + value * value, 0));
      assert.ok(Math.abs(norm - 1) < 1e-3);
      assert.ok(Math.abs(centroid.vector[3] ?? 0) < 1e-6, 'tenant B direction never appears in tenant A');
    }
  });

  test('examples are embedded at save time, stored per tenant, and the rebuild re-embeds them for a new profile', async () => {
    const added = await addScopeExample(SCOPE_A, { text: 'A neutral synthetic out-of-scope question', actorId: USER_A });
    assert.equal(added.ok, true);
    assert.deepEqual(embedded, ['A neutral synthetic out-of-scope question']);
    const duplicate = await addScopeExample(SCOPE_A, { text: 'a NEUTRAL synthetic   out-of-scope question', actorId: USER_A });
    assert.deepEqual(duplicate, { ok: false, code: 'example_exists' });
    const statusA = await scopeGateStatus(SCOPE_A);
    assert.ok(statusA.ok);
    assert.equal(statusA.status.examples, 1);
    const statusB = await scopeGateStatus(SCOPE_B);
    assert.ok(statusB.ok);
    assert.equal(statusB.status.examples, 0);

    await seed();
    const result = await rebuildScopeCentroids(SCOPE_A, { profile: HALF, reembedExamples: true });
    assert.equal(result.examples.reembedded, 1);
    const rows = await db.query<{ embedding_profile_id: string; dims: number; tenant_key: string }>(
      'SELECT embedding_profile_id, dims, tenant_key FROM public.rag_scope_negative_examples ORDER BY embedding_profile_id',
    );
    assert.deepEqual(rows.rows.map((row) => [row.embedding_profile_id, row.dims, row.tenant_key]), [
      ['bge-m3-1024', 1024, KEY_A],
      [LEGACY, 1536, KEY_A],
    ]);
    const again = await rebuildScopeCentroids(SCOPE_A, { profile: HALF, reembedExamples: true });
    assert.equal(again.examples.reembedded, 0);

    if (added.ok) {
      assert.deepEqual(await deleteScopeExample(SCOPE_B, added.example.id), { ok: false, code: 'not_found' });
      assert.deepEqual(await deleteScopeExample(SCOPE_A, added.example.id), { ok: true });
    }
  });

  test('status reports unsupported while a doc-type-scoped binding is active for the tenant', async () => {
    const before = await scopeGateStatus(SCOPE_A);
    assert.ok(before.ok);
    assert.equal(before.status.unsupported, false);
    await db.exec('ALTER TABLE public.embedding_profile_bindings DISABLE TRIGGER USER');
    try {
      await db.query(
        "INSERT INTO public.embedding_profile_bindings (doc_type, tenant_key, profile_id, status, created_by) VALUES ('general', $1, 'bge-m3-1024', 'active', 'tester')",
        [KEY_A],
      );
    } finally {
      await db.exec('ALTER TABLE public.embedding_profile_bindings ENABLE TRIGGER USER');
    }
    const bound = await scopeGateStatus(SCOPE_A);
    assert.ok(bound.ok);
    assert.equal(bound.status.unsupported, true);
    const other = await scopeGateStatus(SCOPE_B);
    assert.ok(other.ok);
    assert.equal(other.status.unsupported, false);
    await db.exec('DELETE FROM public.embedding_profile_bindings');
  });
});
