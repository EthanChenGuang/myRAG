import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETRIEVAL_BACKEND_IDS, type BackendId } from '@/lib/rag/backend/types';
import {
  CANARY_SENTENCE,
  LEGACY_PROFILE,
  canaryBackends,
  createCanaryEnv,
  foreignMarkers,
  type CanaryAnswer,
  type CanaryEnv,
  type CanaryLabel,
} from './factory';

const ENABLED = canaryBackends();
const SETUP_TIMEOUT = 180_000;
const CASE_TIMEOUT = 120_000;
const OTHERS: CanaryLabel[] = ['b', 'o', 'm'];

function silenceLogs(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

/** Markers or chunk ids of the given set that appear anywhere in the answer. */
function leakedInto(answer: CanaryAnswer, markers: string[], chunkIds: string[]): string[] {
  const ids = new Set(chunkIds);
  return [...answer.chunkIds.filter((id) => ids.has(id)), ...markers.filter((marker) => answer.texts.some((text) => text.includes(marker)))];
}

async function cacheRows(env: CanaryEnv, tenantKey: string): Promise<number> {
  const rows = await env.sql<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_semantic_cache WHERE tenant_key = $1', [tenantKey]);
  return Number(rows[0]?.n ?? 0);
}

async function validatedFor(env: CanaryEnv, tenantKey: string, chunkIds: string[]): Promise<string[]> {
  const response = await env.client
    .rpc('rag_validate_chunks', { p_tenant_key: tenantKey, p_ids: chunkIds, p_profile_id: LEGACY_PROFILE })
    .abortSignal(new AbortController().signal);
  if (response.error) throw new Error(`[Canary] rag_validate_chunks failed (${response.error.code ?? 'rpc_error'})`);
  return ((response.data ?? []) as Array<{ chunk_id: string }>).map((row) => String(row.chunk_id)).sort();
}

for (const backend of RETRIEVAL_BACKEND_IDS as readonly BackendId[]) {
  describe.runIf(ENABLED.includes(backend))(`semantic-cache canary, multi-tenant (${backend})`, () => {
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

    /** A asks (miss, stored), asks again (hit): returns both answers. */
    async function storedForA(question: string = CANARY_SENTENCE): Promise<{ stored: CanaryAnswer; hit: CanaryAnswer }> {
      const a = env.tenants.a!;
      const first = await env.ask(a.scope, question);
      expect(first.cache, 'first ask is a miss').toBe('miss');
      expect(first.backend, `the miss is served by ${backend}`).toBe(backend);
      expect(first.storeAttempted, 'the miss is stored after the response').toBe(true);
      expect(first.texts.some((text) => text.includes(a.marker)), 'A sees its own canary').toBe(true);
      expect(await cacheRows(env, a.tenantKey), 'one entry for A').toBe(1);
      const again = await env.ask(a.scope, question);
      expect(again.cache, 'positive control: A hits').toBe('hit');
      return { stored: first, hit: again };
    }

    it(
      "cross-tenant: an answer stored for A is a miss for B, O and M asking the identical question with the identical vector, and never carries A's marker or chunk ids",
      async () => {
        const a = env.tenants.a!;
        const { stored, hit } = await storedForA();
        expect(hit.result.reason).toBe('cache_hit');
        expect(hit.backend, 'a hit runs no search').toBeNull();
        expect(hit.answerText).toContain(a.marker);
        expect(hit.chunkIds.length).toBeGreaterThan(0);
        expect(hit.chunkIds.every((id) => a.chunkIds.includes(id))).toBe(true);
        expect(await validatedFor(env, a.tenantKey, hit.chunkIds), "the hit's chunks pass rag_validate_chunks under A").toEqual([...new Set(hit.chunkIds)].sort());
        expect(hit.documentIds).toEqual([a.documentId]);

        const ticket = stored.result.cacheTicket;
        expect(ticket, "A's request key").toBeDefined();
        const { createPgvectorSemanticCache } = await import('@/lib/rag/cache/pgvector');
        const raw = createPgvectorSemanticCache({ adminClient: () => env.client, config: { ttl: 3600, refusalTtl: 600, maxDistance: 0.05 } });
        const lookup = (label: CanaryLabel) => ({
          ...ticket!.key,
          scope: env.tenants[label]!.scope,
          standalone: ticket!.standalone,
          vector: ticket!.vector,
          embeddingProfileId: ticket!.embeddingProfileId,
        });
        expect((await raw.check(lookup('a')))?.answer.answer_text, 'positive control: the backend serves A').toContain(a.marker);
        for (const label of OTHERS) expect(await raw.check(lookup(label)), `${label}: the backend itself answers A's key with a miss`).toBeNull();
        for (const label of OTHERS) {
          const tenant = env.tenants[label]!;
          const other = await env.ask(tenant.scope, CANARY_SENTENCE, { store: false });
          expect(other.cache, `${label}: miss`).toBe('miss');
          expect(other.result.cacheHit, `${label}: no hit`).toBeUndefined();
          expect(other.result.cacheTicket?.vector, `${label}: identical vector`).toEqual(env.queryVector(CANARY_SENTENCE));
          expect(other.result.cacheTicket?.key.retrievalConfigHash, `${label}: identical key parts`).toBeDefined();
          expect(other.backend, `${label}: its own search on ${backend}`).toBe(backend);
          expect(leakedInto(other, [a.marker], a.chunkIds), `${label} never sees A`).toEqual([]);
          expect(other.chunkIds.every((id) => !a.chunkIds.includes(id))).toBe(true);
        }
        expect(await cacheRows(env, env.tenants.b!.tenantKey)).toBe(0);
      },
      CASE_TIMEOUT,
    );

    it(
      'cross-tenant: each tenant stores the identical question and gets back only its own answer; a foreign entry never satisfies a lookup',
      async () => {
        for (const label of ['a', 'b', 'o'] as const) {
          const tenant = env.tenants[label]!;
          const miss = await env.ask(tenant.scope, CANARY_SENTENCE);
          expect(miss.cache, `${label}: first ask misses although other tenants stored the same question`).toBe('miss');
          expect(leakedInto(miss, foreignMarkers(env, label), [])).toEqual([]);
        }
        for (const label of ['a', 'b', 'o'] as const) {
          const tenant = env.tenants[label]!;
          const hit = await env.ask(tenant.scope, CANARY_SENTENCE);
          expect(hit.cache, `${label}: hits its own entry`).toBe('hit');
          expect(hit.answerText).toContain(tenant.marker);
          expect(leakedInto(hit, foreignMarkers(env, label), []), `${label}: only its own answer`).toEqual([]);
          expect(hit.chunkIds.every((id) => tenant.chunkIds.includes(id))).toBe(true);
          expect(await validatedFor(env, tenant.tenantKey, hit.chunkIds)).toEqual([...new Set(hit.chunkIds)].sort());
          expect(await cacheRows(env, tenant.tenantKey)).toBe(1);
        }
        const m = await env.ask(env.tenants.m!.scope, CANARY_SENTENCE, { store: false });
        expect(m.cache, 'm (no documents) misses').toBe('miss');
        expect(leakedInto(m, foreignMarkers(env, 'm'), [])).toEqual([]);
      },
      CASE_TIMEOUT,
    );

    it(
      'cross-tenant: a hit on the backend never reuses the stored request for another tenant; each tenant search reports its own selection',
      async () => {
        await storedForA();
        const b = await env.ask(env.tenants.b!.scope, CANARY_SENTENCE, { store: false });
        expect(b.cache).toBe('miss');
        const search = b.result.stages.find((row) => row.name === 'search');
        expect(search?.attributes?.backend).toBe(backend);
        expect(search?.attributes?.fallback_reason ?? null).toBeNull();
        expect(b.texts.some((text) => text.includes(env.tenants.b!.marker)), 'B gets its own canary from its own search').toBe(true);
      },
      CASE_TIMEOUT,
    );
  });
}
