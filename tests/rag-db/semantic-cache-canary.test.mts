import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import {
  V2_CACHE_QUESTION,
  createTwoTenantV2Database,
  insertV2CacheSource,
  insertV2CacheSourceVersion,
  v2CacheServiceRoleRpc,
  type TwoTenantV2Database,
  type TwoTenantV2Tenant,
  type V2CacheSource,
  type V2TenantLabel,
} from '../../eval/harness/two-tenant-v2.mts';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { createPgvectorSemanticCache } from '@/lib/rag/cache/pgvector';
import { computeCacheKeyHash, hashSystemPromptTemplate } from '@/lib/rag/cache/keys';
import type { CacheQuery, SemanticCache } from '@/lib/rag/cache/types';
import type { CachedAnswer } from '@/lib/rag-eval/contracts.generated';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';

const CONFIG = { ttl: 3600, refusalTtl: 600, maxDistance: 0.05 };
const TEMPLATE_ONE = 'You answer from the knowledge base only.\n\n{{context}}';
const TEMPLATE_TWO = 'You answer from the knowledge base only, in short sentences.\n\n{{context}}';
const NEW_PROFILE = 'voyage-4-large-1024';

function answer(text: string, sources: V2CacheSource[], overrides: Partial<CachedAnswer> = {}): CachedAnswer {
  return {
    answer_language: 'en',
    answer_text: text,
    created_at: '2026-11-25T00:00:00.000Z',
    groundedness: {
      checkedAt: null,
      label: null,
      latencyMs: null,
      reason: null,
      score: null,
      scorer: null,
      status: 'not_checked',
      threshold: null,
      thresholdSource: null,
      truncated: false,
    },
    is_refusal: false,
    rag_mode: 'strict',
    trace_id: 'trace-placeholder',
    source_versions: sources.map((source) => ({ document_id: source.documentId, version: source.version })),
    ...overrides,
  };
}

describe('two-tenant canary: the semantic cache never crosses tenants, entry profiles, prompts or document versions', () => {
  let fixture: TwoTenantV2Database;
  let rpc: RpcClient;
  let cache: SemanticCache;
  let activeProfile: string;

  const db = (): PGlite => fixture.db;
  const tenant = (label: V2TenantLabel): TwoTenantV2Tenant => fixture.seed.tenants[label];
  const scopeOf = (label: V2TenantLabel): TenantScope => {
    const t = tenant(label);
    return mintScope(t.organizationId ? 'org' : 'personal', t.userId, t.organizationId);
  };
  const query = (label: V2TenantLabel, overrides: Partial<CacheQuery> = {}): CacheQuery => ({
    scope: scopeOf(label),
    standalone: V2_CACHE_QUESTION,
    vector: embedText(V2_CACHE_QUESTION),
    embeddingProfileId: activeProfile,
    answerLanguage: 'en',
    ragMode: 'strict',
    generatorModel: 'provider/model-a',
    retrievalConfigHash: 'c'.repeat(64),
    queryFramework: 'llamaindex',
    entryProfile: 'chat',
    systemPromptHash: hashSystemPromptTemplate(TEMPLATE_ONE),
    maxDistance: CONFIG.maxDistance,
    ...overrides,
  });
  const rowsOf = async (label: V2TenantLabel): Promise<number> =>
    (await db().query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_semantic_cache WHERE tenant_key = $1', [tenant(label).scopeKey])).rows[0]!.n;
  const asServiceRole = async <T,>(sql: string, params: unknown[]): Promise<T[]> =>
    db().transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE service_role');
      return (await tx.query<T>(sql, params)).rows;
    });

  before(async () => {
    fixture = await createTwoTenantV2Database();
    rpc = v2CacheServiceRoleRpc(fixture.db);
    cache = createPgvectorSemanticCache({ adminClient: () => rpc, config: CONFIG });
    activeProfile = (await db().query<{ id: string }>("SELECT id FROM embedding_profiles WHERE status = 'active'")).rows[0]!.id;
  });

  after(async () => {
    await fixture?.db.close();
  });

  beforeEach(async () => {
    await db().query('DELETE FROM public.rag_semantic_cache');
  });

  test('the key hash carries no tenant: both tenants compute the same key for the same question', () => {
    assert.equal(computeCacheKeyHash(query('a')), computeCacheKeyHash(query('b')));
    assert.equal(computeCacheKeyHash(query('a')), computeCacheKeyHash(query('o')));
    assert.notEqual(scopeKey(scopeOf('a')), scopeKey(scopeOf('b')));
  });

  test('the same question and vector stored in tenant A misses in tenant B and in organization O, and hits in A', async () => {
    const source = await insertV2CacheSource(db(), tenant('a'));
    await cache.store(query('a'), answer('tenant A cached placeholder', [source]));

    assert.equal(await cache.check(query('b')), null, 'tenant B must not see tenant A entry');
    assert.equal(await cache.check(query('o')), null, 'organization O must not see tenant A personal entry');
    const hit = await cache.check(query('a'));
    assert.equal(hit?.answer.answer_text, 'tenant A cached placeholder', 'positive control: tenant A hits');
    assert.ok(hit && hit.distance <= CONFIG.maxDistance);
  });

  test('each tenant stores the same question and gets back only its own answer', async () => {
    const sources = { a: await insertV2CacheSource(db(), tenant('a')), b: await insertV2CacheSource(db(), tenant('b')) };
    await cache.store(query('a'), answer('tenant A cached placeholder', [sources.a]));
    await cache.store(query('b'), answer('tenant B cached placeholder', [sources.b]));
    assert.equal((await cache.check(query('a')))?.answer.answer_text, 'tenant A cached placeholder');
    assert.equal((await cache.check(query('b')))?.answer.answer_text, 'tenant B cached placeholder');
    assert.equal(await rowsOf('a'), 1);
    assert.equal(await rowsOf('b'), 1);
  });

  test('tenant B cannot store an answer that cites a tenant A document', async () => {
    const source = await insertV2CacheSource(db(), tenant('a'));
    await assert.rejects(cache.store(query('b'), answer('cross tenant placeholder', [source])));
    assert.equal(await rowsOf('b'), 0);
    assert.equal(await cache.check(query('b')), null);
  });

  test("rag_soft_delete_document on A's source makes A's entry a miss; B's entry still hits", async () => {
    const sources = { a: await insertV2CacheSource(db(), tenant('a')), b: await insertV2CacheSource(db(), tenant('b')) };
    await cache.store(query('a'), answer('tenant A cached placeholder', [sources.a]));
    await cache.store(query('b'), answer('tenant B cached placeholder', [sources.b]));
    assert.ok(await cache.check(query('a')), 'positive control: tenant A hits before the delete');

    const outcome = await asServiceRole<{ outcome: string }>('SELECT outcome FROM rag_soft_delete_document($1, $2::uuid, $3)', [
      tenant('a').scopeKey,
      sources.a.lineageId,
      'config_upload',
    ]);
    assert.ok(outcome[0]?.outcome, 'the soft delete ran');
    assert.equal(await cache.check(query('a')), null);
    assert.equal(await rowsOf('a'), 0);
    assert.equal((await cache.check(query('b')))?.answer.answer_text, 'tenant B cached placeholder');
  });

  test("rag_publish_document_version replacing A's source makes A's entry a miss; B's entry still hits", async () => {
    const sources = { a: await insertV2CacheSource(db(), tenant('a')), b: await insertV2CacheSource(db(), tenant('b')) };
    const next = await insertV2CacheSourceVersion(db(), tenant('a'), sources.a);
    await cache.store(query('a'), answer('tenant A cached placeholder', [sources.a]));
    await cache.store(query('b'), answer('tenant B cached placeholder', [sources.b]));
    assert.ok(await cache.check(query('a')), 'positive control: tenant A hits before the publish');

    const published = await asServiceRole<{ outcome: string }>('SELECT outcome FROM rag_publish_document_version($1, $2)', [next, tenant('a').scopeKey]);
    assert.equal(published[0]?.outcome, 'published');
    assert.equal(await cache.check(query('a')), null);
    assert.equal((await cache.check(query('b')))?.answer.answer_text, 'tenant B cached placeholder');
  });

  test("a version replace that the trigger misses is still a miss: the hit re-validates A's source versions", async () => {
    const source = await insertV2CacheSource(db(), tenant('a'));
    await cache.store(query('a'), answer('tenant A cached placeholder', [source]));
    await db().exec('ALTER TABLE documents DISABLE TRIGGER USER');
    try {
      await db().query('UPDATE documents SET version = version + 1 WHERE id = $1', [source.documentId]);
    } finally {
      await db().exec('ALTER TABLE documents ENABLE TRIGGER USER');
    }
    assert.equal(await rowsOf('a'), 1, 'the trigger was bypassed, the row is still there');
    assert.equal(await cache.check(query('a')), null);
  });

  test('after an active embedding-profile change, A misses with the new profile and vector, with no dimension error', async () => {
    const source = await insertV2CacheSource(db(), tenant('a'));
    await cache.store(query('a'), answer('tenant A cached placeholder', [source]));
    const previous = activeProfile;
    await db().query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [previous]);
    await db().query("UPDATE embedding_profiles SET status = 'active' WHERE id = $1", [NEW_PROFILE]);
    try {
      const current = (await db().query<{ id: string; dims: number }>("SELECT id, dims FROM embedding_profiles WHERE status = 'active'")).rows;
      assert.deepEqual(
        current.map((row) => row.id),
        [NEW_PROFILE],
      );
      const vector = embedText(V2_CACHE_QUESTION, current[0]!.dims);
      assert.equal(await cache.check(query('a', { embeddingProfileId: NEW_PROFILE, vector })), null, 'the new profile misses');
      assert.equal(await cache.check(query('a', { embeddingProfileId: previous, vector })), null, 'a vector of the new dimension misses the old rows');
      assert.equal(await cache.check(query('b', { embeddingProfileId: NEW_PROFILE, vector })), null);
    } finally {
      await db().query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [NEW_PROFILE]);
      await db().query("UPDATE embedding_profiles SET status = 'active' WHERE id = $1", [previous]);
    }
    assert.ok(await cache.check(query('a')), 'positive control: the old profile row is untouched by the lookups');
  });

  test('an entry stored through chat misses through embed and eval; chat still hits', async () => {
    const source = await insertV2CacheSource(db(), tenant('a'));
    await cache.store(query('a', { entryProfile: 'chat' }), answer('chat cached placeholder', [source]));
    assert.equal(await cache.check(query('a', { entryProfile: 'embed' })), null);
    assert.equal(await cache.check(query('a', { entryProfile: 'eval' })), null);
    assert.equal(await cache.check(query('b', { entryProfile: 'embed' })), null);
    assert.equal((await cache.check(query('a', { entryProfile: 'chat' })))?.answer.answer_text, 'chat cached placeholder');
  });

  test('an entry stored under one system-prompt template misses under another; the same template hits', async () => {
    const source = await insertV2CacheSource(db(), tenant('a'));
    await cache.store(query('a', { systemPromptHash: hashSystemPromptTemplate(TEMPLATE_ONE) }), answer('template one placeholder', [source]));
    assert.equal(await cache.check(query('a', { systemPromptHash: hashSystemPromptTemplate(TEMPLATE_TWO) })), null);
    assert.equal(
      (await cache.check(query('a', { systemPromptHash: hashSystemPromptTemplate(TEMPLATE_ONE) })))?.answer.answer_text,
      'template one placeholder',
    );
  });

  test("a cached refusal in A is invalidated by a document upload in A; B's cached refusal stays", async () => {
    await cache.store(query('a'), answer('placeholder refusal A', [], { is_refusal: true }));
    await cache.store(query('b'), answer('placeholder refusal B', [], { is_refusal: true }));
    assert.equal((await cache.check(query('a')))?.answer.is_refusal, true, 'positive control: the refusal hits');

    const a = tenant('a');
    await db().exec('SET ROLE authenticated');
    await db().query("SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)", [a.userId]);
    try {
      await db().query(`INSERT INTO documents (filename, content, metadata, user_id) VALUES ('v2-cache-upload.md', 'placeholder upload', '{}'::jsonb, $1)`, [
        a.userId,
      ]);
    } finally {
      await db().exec('RESET ROLE');
      await db().query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)");
    }
    assert.equal(await cache.check(query('a')), null);
    assert.equal(await rowsOf('a'), 0);
    assert.equal((await cache.check(query('b')))?.answer.answer_text, 'placeholder refusal B');
  });

  test("invalidateTenant(A) deletes only A's entries", async () => {
    const sources = { a: await insertV2CacheSource(db(), tenant('a')), b: await insertV2CacheSource(db(), tenant('b')) };
    await cache.store(query('a'), answer('tenant A cached placeholder', [sources.a]));
    await cache.store(query('b'), answer('tenant B cached placeholder', [sources.b]));
    assert.equal(await cache.invalidateTenant(scopeOf('a')), 1);
    assert.equal(await cache.check(query('a')), null);
    assert.equal((await cache.check(query('b')))?.answer.answer_text, 'tenant B cached placeholder');
  });
});
