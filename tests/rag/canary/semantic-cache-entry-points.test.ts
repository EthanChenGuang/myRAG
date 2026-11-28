import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETRIEVAL_BACKEND_IDS, type BackendId } from '@/lib/rag/backend/types';
import type { CacheHit, CacheQuery, SemanticCache } from '@/lib/rag/cache/types';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import { CANARY_SENTENCE, canaryBackends, createCanaryEnv, foreignMarkers, type CanaryAnswer, type CanaryEnv, type CanaryLabel } from './factory';
import { embedRequest, voiceRequest, type EntryConfig, type EntryOutcome } from './entry-points';

const ENABLED = canaryBackends();
const SETUP_TIMEOUT = 180_000;
const CASE_TIMEOUT = 120_000;
const CACHE_FUNCTIONS = ['rag_cache_check', 'rag_cache_store'];

function silenceLogs(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function chunkIdsOf(env: CanaryEnv, label: CanaryLabel): string[] {
  return env.tenants[label]!.chunkIds;
}

function leakedInto(answer: CanaryAnswer, markers: string[], chunkIds: string[]): string[] {
  const ids = new Set(chunkIds);
  return [...answer.chunkIds.filter((id) => ids.has(id)), ...markers.filter((marker) => answer.texts.some((text) => text.includes(marker)))];
}

function leakedFromOutcome(outcome: EntryOutcome, markers: string[], chunkIds: string[]): string[] {
  const ids = new Set(chunkIds);
  return outcome.ids.filter((id, index) => ids.has(id) || markers.some((marker) => outcome.contents[index]!.includes(marker)));
}

/** The embed entry point resolves the scope from the configured RAG_EMBED_TENANT only; the cache request then runs under that scope. */
async function embedScope(env: CanaryEnv, configured: string, backend: BackendId): Promise<TenantScope> {
  const outcome = await embedRequest(env, configured, {}, CANARY_SENTENCE, { backend });
  expect(outcome.refused, `embed ${configured} is served`).toBeNull();
  return outcome.scope!;
}

/**
 * Test-only negative control: a cache backend that ignores the tenant. Every check is answered from the given foreign scope's entries
 * (through the real pgvector cache functions), whatever scope the stage asked for; stores pass through.
 */
async function tenantIgnoringCache(env: CanaryEnv, foreign: TenantScope): Promise<{ cache: SemanticCache; raw: CacheHit[] }> {
  const { createPgvectorSemanticCache } = await import('@/lib/rag/cache/pgvector');
  const inner = createPgvectorSemanticCache({ adminClient: () => env.client, config: { ttl: 3600, refusalTtl: 600, maxDistance: 0.05 } });
  const raw: CacheHit[] = [];
  const cache: SemanticCache = {
    async check(q: CacheQuery) {
      const hit = await inner.check({ ...q, scope: foreign });
      if (hit) raw.push(hit);
      return hit;
    },
    store: (q, answer) => inner.store(q, answer),
    invalidateTenant: (scope, documentIds, opts) => inner.invalidateTenant(scope, documentIds, opts),
  };
  return { cache, raw };
}

/** voiceRequest with the cache switches on in the request environment, as a deployment with the semantic cache enabled runs it. */
async function voiceWithCacheOn(env: CanaryEnv, label: CanaryLabel, config: EntryConfig): Promise<EntryOutcome> {
  const deps = await import('@/lib/rag/deps');
  const previous = deps.getRagDeps().ragEnv;
  const base = previous();
  deps.setRagDepsForTests({ ragEnv: () => ({ ...base, RAG_QUERY_LAYER: 'true', RAG_SEMANTIC_CACHE: 'pgvector', RAG_SEMANTIC_CACHE_EMBED_STORE: 'true' }) });
  try {
    return await voiceRequest(env, env.tenants[label]!, CANARY_SENTENCE, config);
  } finally {
    deps.setRagDepsForTests({ ragEnv: previous });
  }
}

for (const backend of RETRIEVAL_BACKEND_IDS as readonly BackendId[]) {
  describe.runIf(ENABLED.includes(backend))(`semantic-cache canary through embed and voice, multi-tenant (${backend})`, () => {
    let env: CanaryEnv;

    beforeAll(async () => {
      env = await createCanaryEnv(backend, 'multi-tenant', { cache: 'pgvector' });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await env?.close();
    });

    beforeEach(async () => {
      silenceLogs();
      await env.sql('DELETE FROM public.rag_semantic_cache');
    });

    /** The embed configuration RAG_EMBED_TENANT=o:<O> asks (miss, stored) and asks again (hit). */
    async function storedForO(): Promise<{ scope: TenantScope; hit: CanaryAnswer }> {
      const o = env.tenants.o!;
      const scope = await embedScope(env, `o:${env.ids.orgO}`, backend);
      expect(scope).toMatchObject({ kind: 'org', organizationId: env.ids.orgO });
      const first = await env.ask(scope, CANARY_SENTENCE, { profile: 'embed' });
      expect(first.cache, 'embed o: first ask misses').toBe('miss');
      expect(first.backend).toBe(backend);
      expect(first.storeAttempted).toBe(true);
      expect(first.texts.some((text) => text.includes(o.marker))).toBe(true);
      const hit = await env.ask(scope, CANARY_SENTENCE, { profile: 'embed' });
      expect(hit.cache, 'positive control: embed o hits').toBe('hit');
      expect(hit.answerText).toContain(o.marker);
      expect(hit.documentIds).toEqual([o.documentId]);
      return { scope, hit };
    }

    it(
      "embed scope: an answer stored for RAG_EMBED_TENANT=o:<O> is a miss for the embed configuration u:<B> and for chat in A, with no O marker or chunk id",
      async () => {
        const o = env.tenants.o!;
        await storedForO();
        const scopeB = await embedScope(env, `u:${env.ids.userB}`, backend);
        const b = await env.ask(scopeB, CANARY_SENTENCE, { profile: 'embed', store: false });
        expect(b.cache, 'embed b: miss').toBe('miss');
        expect(b.result.cacheTicket?.vector, 'identical vector').toEqual(env.queryVector(CANARY_SENTENCE));
        expect(leakedInto(b, [o.marker], o.chunkIds), 'embed b never sees O').toEqual([]);
        expect(b.texts.some((text) => text.includes(env.tenants.b!.marker)), "B's own canary").toBe(true);

        const chatA = await env.ask(env.tenants.a!.scope, CANARY_SENTENCE, { store: false });
        expect(chatA.cache, 'chat in A: miss').toBe('miss');
        expect(leakedInto(chatA, [o.marker], o.chunkIds), 'chat in A never sees O').toEqual([]);

        const chatO = await env.ask(o.scope, CANARY_SENTENCE, { store: false });
        expect(chatO.cache, "chat in O itself misses the embed entry (entry profiles never share an entry)").toBe('miss');
      },
      CASE_TIMEOUT,
    );

    it(
      "negative control: a tenant-ignoring cache backend hands O's entry to B's lookup, and the stage's Supabase source re-check under B's key rejects it",
      async () => {
        const o = env.tenants.o!;
        const { canonicalTenantKey } = await import('@/lib/rag/backend/tenant-key');
        const { scope: scopeO } = await storedForO();
        const scopeB = await embedScope(env, `u:${env.ids.userB}`, backend);
        expect(canonicalTenantKey(scopeB)).toBe(env.tenants.b!.tenantKey);
        const broken = await tenantIgnoringCache(env, scopeO);

        const b = await env.ask(scopeB, CANARY_SENTENCE, { profile: 'embed', store: false, semanticCache: broken.cache });
        expect(broken.raw.length, "the fake did hand out O's entry").toBeGreaterThan(0);
        expect(broken.raw[0]!.answer.answer_text).toContain(o.marker);
        expect(b.cache, 'B gets a miss').toBe('miss');
        expect(b.result.cacheHit).toBeUndefined();
        expect(b.rpcCalls, 'the stage re-checked the sources under B').toContain('rag_cache_resolve_sources');
        expect(leakedInto(b, [o.marker], o.chunkIds), 'no O marker and no O chunk id').toEqual([]);
        expect(b.documentIds).not.toContain(o.documentId);

        const chatB = await env.ask(env.tenants.b!.scope, CANARY_SENTENCE, { store: false, semanticCache: broken.cache });
        expect(chatB.cache, 'chat in B is rejected the same way').toBe('miss');
        expect(leakedInto(chatB, [o.marker], o.chunkIds)).toEqual([]);

        const own = await env.ask(scopeO, CANARY_SENTENCE, { profile: 'embed', store: false, semanticCache: broken.cache });
        expect(own.cache, 'positive control: O itself still hits through the fake').toBe('hit');
      },
      CASE_TIMEOUT,
    );

    for (const voiceBackend of [undefined, backend] as const) {
      it(
        `voice is never cached (RAG_RETRIEVAL_BACKEND_VOICE ${voiceBackend ?? 'unset'}): no cache check or store, and no other tenant's marker`,
        async () => {
          await storedForO();
          const chatA = await env.ask(env.tenants.a!.scope, CANARY_SENTENCE);
          expect(chatA.storeAttempted).toBe(true);
          const config: EntryConfig = { backend, voiceBackend };
          for (const label of ['a', 'b', 'o'] as const) {
            const outcome = await voiceWithCacheOn(env, label, config);
            expect(outcome.refused, `voice ${label}`).toBeNull();
            expect(outcome.rpcCalls.filter((fn) => CACHE_FUNCTIONS.includes(fn)), `voice ${label}: no cache call`).toEqual([]);
            expect(outcome.result?.cacheHit).toBeUndefined();
            expect(outcome.result?.cacheTicket).toBeUndefined();
            expect(leakedFromOutcome(outcome, foreignMarkers(env, label), []), `voice ${label}: own tenant only`).toEqual([]);
            expect(outcome.contents.some((content) => content.includes(env.tenants[label]!.marker))).toBe(true);

            const direct = await env.ask(env.tenants[label]!.scope, CANARY_SENTENCE, { profile: 'voice', voiceBackend });
            expect(direct.cache, `voice ${label} with a cache context`).not.toBe('hit');
            expect(direct.storeAttempted).toBe(false);
            expect(direct.rpcCalls.filter((fn) => CACHE_FUNCTIONS.includes(fn)), `voice ${label} with a cache context: no cache call`).toEqual([]);
            expect(leakedInto(direct, foreignMarkers(env, label), chunkIdsOf(env, label === 'o' ? 'a' : 'o'))).toEqual([]);
          }
        },
        CASE_TIMEOUT,
      );
    }
  });
}
