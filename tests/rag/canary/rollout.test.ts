import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETRIEVAL_BACKEND_IDS, type BackendId } from '@/lib/rag/backend/types';
import type { EmbeddingProvider } from '@/lib/rag/embeddings/types';
import { toPoint, type SyncRow } from '@/lib/rag/sync/servable';
import type { VectorPoint } from '@/lib/rag/sync/stores/types';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import {
  CANARY_ACTOR,
  CANARY_SENTENCE,
  LEGACY_PROFILE,
  SECOND_PROFILE,
  SECOND_PROFILE_DIMS,
  canaryBackends,
  createCanaryEnv,
  foreignMarkers,
  isExternalBackend,
  type CanaryAskProfile,
  type CanaryEnv,
} from './factory';

// Plan 07-47 Task 3 (D-12, LANG-11): a mixed rollout keeps every tenant inside its own data on every backend. Tenant a is on the
// candidate arm (SECOND_PROFILE, backfilling), tenant b on the incumbent (LEGACY_PROFILE). Synthetic neutral content only.
const ENABLED = canaryBackends();
const SETUP_TIMEOUT = 240_000;
const CASE_TIMEOUT = 120_000;
const PROFILES: readonly CanaryAskProfile[] = ['chat', 'embed', 'voice'];

function silenceLogs(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function fakeSecondProvider(calls: string[]): EmbeddingProvider {
  const vectors = (texts: string[], dims: number | undefined) => texts.map((text) => embedText(text, dims ?? SECOND_PROFILE_DIMS));
  return {
    id: 'voyage',
    model: 'voyage-4-large',
    maxInputTokens: 32_000,
    supportedDims: [SECOND_PROFILE_DIMS],
    normalize: true,
    async embedDocuments(texts, opts) {
      return { vectors: vectors(texts, opts.dims), model: 'voyage-4-large', host: 'canary-fake', usage: { tokens: texts.length } };
    },
    async embedQuery(text, opts) {
      calls.push(text);
      return { vectors: vectors([text], opts.dims), model: 'voyage-4-large', host: 'canary-fake', usage: { tokens: 1 } };
    },
  };
}

interface Rollout {
  env: CanaryEnv;
  rolloutId: string;
  p2Calls: string[];
  close(): Promise<void>;
}

async function rolloutEnv(backend: BackendId): Promise<Rollout> {
  const env = await createCanaryEnv(backend, 'multi-tenant');
  const p2Calls: string[] = [];
  const [{ runReembed }, registry, deps, ingestDeps, ingestConfig, ragConfig, activeProfile, rollout] = await Promise.all([
    import('@/lib/rag/ingest/reembed/run'),
    import('@/lib/rag/embeddings/registry'),
    import('@/lib/rag/deps'),
    import('@/lib/rag/ingest/deps'),
    import('@/lib/rag/ingest/config'),
    import('@/lib/rag/config'),
    import('@/lib/rag/embeddings/active-profile'),
    import('@/lib/rag/rollout/resolve'),
  ]);
  registry.setEmbeddingProvidersForTests({ voyage: fakeSecondProvider(p2Calls) });
  const report = await runReembed({ db: env.client, profileId: SECOND_PROFILE, actor: CANARY_ACTOR, signal: new AbortController().signal });
  expect(report.status, report.reason ?? '').toBe('completed');
  await env.sql("UPDATE public.embedding_profiles SET status = 'backfilling' WHERE id = $1 AND status = 'available'", [SECOND_PROFILE]);
  await env.settle();

  const ingest = ingestDeps.getIngestDeps();
  const previousIngestEnv = ingest.ingestEnv;
  ingestDeps.setIngestDepsForTests({ ingestEnv: () => ({ ...previousIngestEnv(), RAG_EMBEDDING_PROFILES: 'on' }) });
  const rag = deps.getRagDeps();
  const previousRagEnv = rag.ragEnv;
  deps.setRagDepsForTests({ ragEnv: () => ({ ...previousRagEnv(), RAG_ROLLOUTS: 'true', RAG_EMBEDDING_PROFILES: 'on' }) });
  ingestConfig.resetIngestConfigForTests();
  ragConfig.resetRagConfigForTests();
  activeProfile.resetActiveProfileForTests();
  rollout.resetRolloutCacheForTests();

  const [row] = await env.sql<{ id: string }>("SELECT public.rag_rollout_start('embedding_profile', $1::jsonb, 'tenants', NULL, $2::text[], NULL) AS id", [
    JSON.stringify({ embedding_profile_id: SECOND_PROFILE }),
    [env.tenants.a!.tenantKey],
  ]);
  return {
    env,
    rolloutId: String(row!.id),
    p2Calls,
    async close() {
      rollout.resetRolloutCacheForTests();
      activeProfile.resetActiveProfileForTests();
      ingestDeps.setIngestDepsForTests({ ingestEnv: previousIngestEnv });
      await env.close();
    },
  };
}

function embedDetail(result: Awaited<ReturnType<CanaryEnv['ask']>>): string | undefined {
  return result.result.stages.find((row) => row.name === 'embed')?.detail;
}

function searchDetail(result: Awaited<ReturnType<CanaryEnv['ask']>>): string {
  return result.result.stages.find((row) => row.name === 'search')?.detail ?? '';
}

/** The chunk ids and texts a request returned: the candidates, plus the voice results for the voice profile. */
function served(answer: Awaited<ReturnType<CanaryEnv['ask']>>): { chunkIds: string[]; texts: string[] } {
  const voice = answer.result.voice?.results ?? [];
  return {
    chunkIds: [...new Set([...answer.chunkIds, ...voice.map((row) => String(row.chunk_id))])],
    texts: [...answer.texts, ...voice.map((row) => row.content)],
  };
}

async function chunkTenants(env: CanaryEnv, chunkIds: string[]): Promise<string[]> {
  if (chunkIds.length === 0) return [];
  const rows = await env.sql<{ tenant_key: string }>('SELECT DISTINCT tenant_key FROM public.document_chunks WHERE id = ANY($1::uuid[])', [chunkIds]);
  return rows.map((row) => row.tenant_key).sort();
}

async function pointCount(env: CanaryEnv, tenantKey: string): Promise<number> {
  if (!env.store) return 0;
  let n = 0;
  for (const profile of [LEGACY_PROFILE, SECOND_PROFILE]) {
    for (const label of ['a', 'b'] as const) n += (await env.store.listDocumentIds(profile, tenantKey, env.tenants[label]!.documentId)).length;
  }
  return n;
}

for (const backend of RETRIEVAL_BACKEND_IDS as readonly BackendId[]) {
  describe.runIf(ENABLED.includes(backend))(`mixed-rollout canary (${backend})`, () => {
    let setup: Rollout;

    beforeAll(async () => {
      silenceLogs();
      setup = await rolloutEnv(backend);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await setup?.close();
      vi.restoreAllMocks();
    });

    beforeEach(silenceLogs);

    for (const profile of PROFILES) {
      it(
        `${profile}: tenant a is served from the candidate profile with only its own documents; tenant b from the incumbent with only its own`,
        async () => {
          const { env, rolloutId } = setup;
          const a = env.tenants.a!;
          const b = env.tenants.b!;
          setup.p2Calls.length = 0;
          const askA = await env.ask(a.scope, `${CANARY_SENTENCE} ${a.marker}`, { profile });
          expect(askA.result.status, askA.result.reason).not.toBe('error');
          expect(embedDetail(askA), 'a embeds with the candidate profile').toBe(SECOND_PROFILE);
          expect(setup.p2Calls.length).toBeGreaterThan(0);
          expect(searchDetail(askA)).toContain(`rollout=${rolloutId}:candidate`);
          const servedA = served(askA);
          expect(servedA.chunkIds.length, 'a finds its own document').toBeGreaterThan(0);
          expect(await chunkTenants(env, servedA.chunkIds)).toEqual([a.tenantKey]);
          for (const marker of foreignMarkers(env, 'a')) expect(servedA.texts.join(' ')).not.toContain(marker);

          setup.p2Calls.length = 0;
          const askB = await env.ask(b.scope, `${CANARY_SENTENCE} ${b.marker}`, { profile });
          expect(askB.result.status, askB.result.reason).not.toBe('error');
          expect(embedDetail(askB), 'b embeds with the incumbent').toBe(LEGACY_PROFILE);
          expect(setup.p2Calls).toEqual([]);
          expect(searchDetail(askB)).toContain(`rollout=${rolloutId}:incumbent`);
          const servedB = served(askB);
          expect(servedB.chunkIds.length, 'b finds its own document').toBeGreaterThan(0);
          expect(await chunkTenants(env, servedB.chunkIds)).toEqual([b.tenantKey]);
          for (const marker of foreignMarkers(env, 'b')) expect(servedB.texts.join(' ')).not.toContain(marker);
        },
        CASE_TIMEOUT,
      );
    }

    it.runIf(isExternalBackend(backend))(
      "a point planted in the candidate collection under a's partition with b's chunk id is dropped by re-validation",
      async () => {
        const { env } = setup;
        const a = env.tenants.a!;
        const b = env.tenants.b!;
        const response = await env.client
          .rpc('rag_vector_sync_chunk_row', { p_tenant_key: a.tenantKey, p_chunk_id: a.chunkIds[0]!, p_profile_id: SECOND_PROFILE })
          .abortSignal(new AbortController().signal);
        expect(response.error).toBeNull();
        const template = toPoint((Array.isArray(response.data) ? response.data[0] : response.data) as SyncRow);
        const foreignId = b.chunkIds[0]!.toLowerCase();
        const planted: VectorPoint = {
          id: foreignId,
          vector: env.queryVector(`${CANARY_SENTENCE} ${a.marker}`, SECOND_PROFILE),
          payload: { ...template.payload, document_id: b.documentId },
        };
        expect(await env.store!.upsert(SECOND_PROFILE, a.tenantKey, [planted])).toBe(1);
        const raw = await env.rawStoreSearch(a.scope, `${CANARY_SENTENCE} ${a.marker}`, { profileId: SECOND_PROFILE });
        expect(
          [...raw.dense, ...raw.lexical].some((hit) => String(hit.id).toLowerCase() === foreignId),
          'negative control: the raw scoped query returns the planted point',
        ).toBe(true);

        const askA = await env.ask(a.scope, `${CANARY_SENTENCE} ${a.marker}`);
        expect(embedDetail(askA)).toBe(SECOND_PROFILE);
        expect(askA.chunkIds).not.toContain(b.chunkIds[0]);
        expect(await chunkTenants(env, askA.chunkIds)).toEqual([a.tenantKey]);
      },
      CASE_TIMEOUT,
    );

    // Last in the file: it moves tenant a back to the incumbent.
    it(
      "after a's per-tenant rollback a is served from the incumbent again and nothing was deleted from either profile",
      async () => {
        const { env, rolloutId } = setup;
        const a = env.tenants.a!;
        const before = await pointCount(env, a.tenantKey);
        const vectorsBefore = await env.sql<{ n: number }>('SELECT count(*)::int AS n FROM public.chunk_embeddings WHERE profile_id = $1', [SECOND_PROFILE]);
        await env.sql("SELECT public.rag_rollout_set_tenant($1::uuid, $2, 'exclude', NULL)", [rolloutId, a.tenantKey]);
        (await import('@/lib/rag/rollout/resolve')).resetRolloutCacheForTests();
        const askA = await env.ask(a.scope, `${CANARY_SENTENCE} ${a.marker}`);
        expect(embedDetail(askA)).toBe(LEGACY_PROFILE);
        expect(searchDetail(askA)).toContain(`rollout=${rolloutId}:incumbent`);
        expect(await chunkTenants(env, askA.chunkIds)).toEqual([a.tenantKey]);
        expect(await pointCount(env, a.tenantKey), 'no point deleted').toBe(before);
        const vectorsAfter = await env.sql<{ n: number }>('SELECT count(*)::int AS n FROM public.chunk_embeddings WHERE profile_id = $1', [SECOND_PROFILE]);
        expect(vectorsAfter).toEqual(vectorsBefore);
      },
      CASE_TIMEOUT,
    );
  });
}
