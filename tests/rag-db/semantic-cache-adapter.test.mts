import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { createPgvectorSemanticCache } from '@/lib/rag/cache/pgvector';
import type { CacheQuery } from '@/lib/rag/cache/types';
import type { CachedAnswer } from '@/lib/rag-eval/contracts.generated';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';

const USER_B = '00000000-0000-4000-8000-0000000021b2';

const CASTS: Record<string, string> = {
  p_embedding: 'public.halfvec',
  p_answer: 'jsonb',
  p_source_versions: 'jsonb',
  p_document_ids: 'uuid[]',
};
const SETOF = new Set(['rag_cache_check']);

/** PostgREST-shaped service_role RPC access over PGlite: a SETOF function answers rows, any other function its single value. */
function serviceRoleRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const names = Object.keys(args);
      const values = names.map((name) => {
        const value = args[name];
        return CASTS[name] === 'jsonb' && value !== null ? JSON.stringify(value) : value;
      });
      const params = names.map((name, index) => `${name} => $${index + 1}${CASTS[name] ? `::${CASTS[name]}` : ''}`).join(', ');
      const sql = SETOF.has(fn) ? `SELECT * FROM public.${fn}(${params})` : `SELECT public.${fn}(${params}) AS value`;
      const pending: Promise<RpcResponse> = db
        .transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          return (await tx.query<Record<string, unknown>>(sql, values)).rows;
        })
        .then((rows): RpcResponse => ({ data: SETOF.has(fn) ? rows : (rows[0]?.value ?? null), error: null }))
        .catch((error: unknown): RpcResponse => ({
          data: null,
          error: { message: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code },
        }));
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => pending.then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

function answer(text: string, overrides: Partial<CachedAnswer> = {}): CachedAnswer {
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
    ...overrides,
  };
}

function query(scope: TenantScope, overrides: Partial<CacheQuery> = {}): CacheQuery {
  return {
    scope,
    standalone: 'what does the placeholder section describe',
    vector: [1, 0, 0, 0],
    embeddingProfileId: 'p1',
    answerLanguage: 'en',
    ragMode: 'strict',
    generatorModel: 'provider/model-a',
    retrievalConfigHash: 'a'.repeat(64),
    queryFramework: 'llamaindex',
    entryProfile: 'chat',
    systemPromptHash: 'b'.repeat(64),
    maxDistance: 0.05,
    ...overrides,
  };
}

const CONFIG = { ttl: 3600, refusalTtl: 600, maxDistance: 0.05 };
const NEAR = [0.99, Math.sqrt(1 - 0.99 * 0.99), 0, 0];

describe('pgvector semantic cache adapter over PGlite (multi-tenant)', () => {
  let db: PGlite;
  let rpc: RpcClient;
  const scopeA = mintScope('personal', FIXTURE_USER_ID, null);
  const scopeB = mintScope('personal', USER_B, null);
  const cache = () => createPgvectorSemanticCache({ adminClient: () => rpc, config: CONFIG });

  before(async () => {
    ({ db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' }));
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [USER_B, 'user-b@example.invalid']);
    rpc = serviceRoleRpc(db);
  });

  after(async () => {
    await db?.close();
  });

  test('store then check in tenant A hits with the stored answer and a masked stored query', async () => {
    await db.query('DELETE FROM public.rag_semantic_cache');
    await cache().store(query(scopeA, { standalone: 'forward the notes to someone@example.com' }), answer('tenant A placeholder answer'));
    const hit = await cache().check(query(scopeA, { vector: NEAR }));
    assert.ok(hit, 'expected a hit');
    assert.equal(hit.answer.answer_text, 'tenant A placeholder answer');
    assert.ok(hit.distance >= 0 && hit.distance <= 0.05, `distance ${hit.distance}`);
    const rows = await db.query<{ tenant_key: string; query_text_masked: string }>(
      'SELECT tenant_key, query_text_masked FROM public.rag_semantic_cache',
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.tenant_key, scopeKey(scopeA));
    assert.equal(rows.rows[0]!.query_text_masked, 'forward the notes to [EMAIL]');
  });

  test('the same text, vector and key hash in tenant B misses', async () => {
    assert.equal(await cache().check(query(scopeB)), null);
    assert.equal(await cache().check(query(scopeB, { vector: NEAR })), null);
    assert.ok(await cache().check(query(scopeA)), 'positive control: tenant A still hits');
  });

  test('a hit for profile p1 never returns a p2 row', async () => {
    await db.query('DELETE FROM public.rag_semantic_cache');
    await cache().store(query(scopeA, { embeddingProfileId: 'p2' }), answer('profile two placeholder'));
    assert.equal(await cache().check(query(scopeA, { embeddingProfileId: 'p1' })), null);
    await cache().store(query(scopeA, { embeddingProfileId: 'p1' }), answer('profile one placeholder'));
    assert.equal((await cache().check(query(scopeA, { embeddingProfileId: 'p1' })))?.answer.answer_text, 'profile one placeholder');
    assert.equal((await cache().check(query(scopeA, { embeddingProfileId: 'p2' })))?.answer.answer_text, 'profile two placeholder');
  });

  test('a refusal is stored with the refusal TTL', async () => {
    await db.query('DELETE FROM public.rag_semantic_cache');
    await cache().store(query(scopeA), answer('placeholder refusal', { is_refusal: true }));
    const row = await db.query<{ is_refusal: boolean; ttl: number }>(
      'SELECT is_refusal, extract(epoch FROM expires_at - created_at)::int AS ttl FROM public.rag_semantic_cache',
    );
    assert.equal(row.rows[0]!.is_refusal, true);
    assert.ok(Math.abs(row.rows[0]!.ttl - 600) <= 2, `ttl ${row.rows[0]!.ttl}`);
  });

  test("invalidateTenant(A) deletes only A's entries and returns the count", async () => {
    await db.query('DELETE FROM public.rag_semantic_cache');
    await cache().store(query(scopeA), answer('tenant A placeholder answer'));
    await cache().store(query(scopeB), answer('tenant B placeholder answer'));
    assert.equal(await cache().invalidateTenant(scopeA), 1);
    assert.equal(await cache().check(query(scopeA)), null);
    assert.equal((await cache().check(query(scopeB)))?.answer.answer_text, 'tenant B placeholder answer');
  });

  test('a row whose answer fails CachedAnswerSchema is served as a miss', async () => {
    await db.query('DELETE FROM public.rag_semantic_cache');
    await cache().store(query(scopeA), answer('valid placeholder'));
    assert.ok(await cache().check(query(scopeA)), 'positive control: the valid row hits');
    await db.query(`UPDATE public.rag_semantic_cache SET answer = '{"answer_text": "tampered"}'::jsonb`);
    assert.equal(await cache().check(query(scopeA)), null);
  });

  test('a store whose source is not a current document of the tenant is refused', async () => {
    await assert.rejects(
      cache().store(query(scopeA), answer('placeholder', { source_versions: [{ document_id: crypto.randomUUID(), version: 1 }] })),
    );
  });
});
