import { createClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { externalLexicalParams, resetLexicalParamsChecks, type LexicalParams } from '@/lib/rag/backend/lexical-params';
import { createPgvectorBackend } from '@/lib/rag/backend/pgvector';
import { createQdrantBackend } from '@/lib/rag/backend/qdrant/adapter';
import { buildQdrantClients, type QdrantApi } from '@/lib/rag/backend/qdrant/client';
import { qdrantErrorStatus } from '@/lib/rag/backend/qdrant/errors';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { canonicalTenantKey, qdrantCollectionName, weaviateCollectionName } from '@/lib/rag/backend/tenant-key';
import type { BackendSearchRequest, LexicalScoringRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { createWeaviateBackend } from '@/lib/rag/backend/weaviate/adapter';
import type { WeaviateClientLike } from '@/lib/rag/backend/weaviate/types';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { resetLexstatsCacheForTests } from '@/lib/rag/lexical/stats';
import { main as vectorSyncCli } from '@/lib/rag/sync/cli';
import { drainSlice } from '@/lib/rag/sync/drain';
import { createQdrantStore } from '@/lib/rag/sync/stores/qdrant';
import type { VectorStore, VectorSyncTarget } from '@/lib/rag/sync/stores/types';
import { createWeaviateStore } from '@/lib/rag/sync/stores/weaviate';
import type { VectorStoreFactories } from '@/lib/rag/sync/targets';
import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';
import { lexicalScoringArg } from '@/lib/rag/v2/stages/search';
import { bm25Reference } from '../../helpers/bm25-reference';
import { createEmptyFixtureDatabase } from '../../../eval/harness/pglite-supabase.mts';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../../eval/harness/fake-edge.mts';
import { createFakeQdrantClient } from '../backend/qdrant-fake-client';
import { createFakeWeaviate } from '../backend/weaviate-fake';
import { PROFILE_ID } from './dataset';

/**
 * LEX-05 parity: one synthetic two-tenant fixture, ranked by the lexical leg of pgvector (rag_bm25_search_chunks), Weaviate and Qdrant
 * at k1 1.5 and at k1 1.2 (b 0.75), against the TypeScript reference BM25. P and Q swap between the two settings; R stays third.
 * Tenant B holds decoys that would rank first for the same query if anything crossed tenants.
 */

const CI = process.env.CI_BACKEND_CANARY === '1';
const USER_A = '00000000-0000-4000-8000-00000000a053';
const USER_B = '00000000-0000-4000-8000-00000000b053';
const tenantA = mintScope('personal', USER_A, null);
const tenantB = mintScope('personal', USER_B, null);
const RARE = 'parityrare';
const COMMON = 'paritycommon';
const QUERY = [RARE, COMMON];
const K12: LexicalParams = { k1: 1.2, b: 0.75 };
const K15: LexicalParams = { k1: 1.5, b: 0.75 };
const MARGIN = 0.07;
/** The external stores get their own collection: the parity DB syncs only this profile, so no other suite's collection is touched. */
const EXT_PROFILE = 'qwen3-8b-1024';
const EXT_DIMS = 1024;

function filler(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
}

function uuid(tag: string, n: number): string {
  return `00000000-0000-4000-8${tag}-${String(n).padStart(12, '0')}`;
}

interface FixtureChunk {
  name: string;
  chunkId: string;
  docId: string;
  userId: string;
  tokens: string[];
}

function chunk(name: string, userId: string, n: number, tokens: string[]): FixtureChunk {
  const tag = userId === USER_A ? '053' : '153';
  return { name, chunkId: uuid(tag, 100 + n), docId: uuid(tag, 200 + n), userId, tokens };
}

const TENANT_A_CHUNKS: FixtureChunk[] = [
  chunk('P', USER_A, 1, [RARE, ...filler('alphafill', 59)]),
  chunk('Q', USER_A, 2, Array.from({ length: 30 }, () => COMMON)),
  chunk('R', USER_A, 3, [COMMON, ...filler('gammafill', 13)]),
  ...Array.from({ length: 4 }, (_, i) => chunk(`F${i + 1}`, USER_A, 4 + i, [`deltafill${String.fromCharCode(97 + i)}`])),
  ...Array.from({ length: 6 }, (_, i) => chunk(`C${i + 1}`, USER_A, 8 + i, [COMMON, ...filler(`zeta${String.fromCharCode(97 + i)}fill`, 19)])),
];

const TENANT_B_CHUNKS: FixtureChunk[] = [
  chunk('DB1', USER_B, 1, [RARE, RARE, RARE, COMMON, COMMON, COMMON]),
  chunk('DB2', USER_B, 2, [RARE, COMMON]),
  chunk('DB3', USER_B, 3, ['thetafill', 'thetafillb', 'thetafillc']),
];

const ID = Object.fromEntries([...TENANT_A_CHUNKS, ...TENANT_B_CHUNKS].map((c) => [c.name, c.chunkId])) as Record<string, string>;
const A_IDS = new Set(TENANT_A_CHUNKS.map((c) => c.chunkId));
const B_IDS = new Set(TENANT_B_CHUNKS.map((c) => c.chunkId));

/** The calibrated reference scores (P, Q, R) at each setting; the self-check recomputes them. */
const CALIBRATED = {
  k12: { P: 1.122165, Q: 1.034358, R: 0.543881 },
  k15: { P: 1.068974, Q: 1.158672, R: 0.548818 },
} as const;
const ORDER_K12 = [ID.P, ID.Q, ID.R];
const ORDER_K15 = [ID.Q, ID.P, ID.R];

function referenceTop(chunks: FixtureChunk[], params: LexicalParams): Array<{ id: string; name: string; score: number }> {
  const scores = bm25Reference({ docs: chunks.map((c) => c.tokens), query: QUERY, k1: params.k1, b: params.b });
  return chunks
    .map((c, i) => ({ id: c.chunkId, name: c.name, score: scores[i] as number }))
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
}

function gap(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(a, b);
}

function bm25Env(params: LexicalParams): Record<string, string> {
  return {
    RAG_PIPELINE: 'v2',
    RAG_LEXICAL_SEARCH: 'true',
    RAG_LEXICAL_SCORING: 'bm25',
    RAG_LEXICAL_BM25_K1: String(params.k1),
    RAG_LEXICAL_BM25_B: String(params.b),
    RAG_SUPPORTED_LANGUAGES: 'en',
    RAG_PRIMARY_LANGUAGE: 'en',
  };
}

function searchRequest(scope: TenantScope, scoring: LexicalScoringRequest | undefined, profileId: string = PROFILE_ID): BackendSearchRequest {
  return {
    scope,
    embeddingProfileId: profileId,
    denseVector: embedText(QUERY.join(' '), profileId === EXT_PROFILE ? EXT_DIMS : undefined),
    lexicalTokens: [...QUERY],
    lexicalLanguages: null,
    access: { mode: 'off' },
    filters: { currentOnly: true },
    denseLimit: 0,
    lexicalLimit: 10,
    signal: new AbortController().signal,
    ...(scoring ? { lexicalScoring: scoring } : {}),
  };
}

function scoringFor(params: LexicalParams): LexicalScoringRequest {
  resetRagConfigForTests();
  return lexicalScoringArg(loadRagConfig(bm25Env(params))).lexicalScoring as LexicalScoringRequest;
}

async function insertFixture(db: PGlite): Promise<void> {
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [
    USER_A,
    'parity-a@example.invalid',
    USER_B,
    'parity-b@example.invalid',
  ]);
  for (const c of [...TENANT_A_CHUNKS, ...TENANT_B_CHUNKS]) {
    const text = c.tokens.join(' ');
    await db.query(
      `INSERT INTO documents (id, filename, content, user_id, language, doc_type, source, is_current, status, created_at)
       VALUES ($1, $2, $3, $4, 'en', 'general', 'upload', true, 'ready', '2025-06-01T00:00:00Z')`,
      [c.docId, `parity-${c.name.toLowerCase()}.md`, `neutral parity sample ${c.name}`, c.userId],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, chunk_index, metadata, language, doc_type, source, is_current, status, created_at)
       VALUES ($1, $2, $3, $4::vector, $5, 0, '{}'::jsonb, 'en', 'general', 'upload', true, 'ready', '2025-06-01T00:00:00Z')`,
      [c.chunkId, c.docId, `neutral parity sample ${c.name}`, `[${embedText(text).join(',')}]`, text],
    );
  }
}

interface Fixture {
  db: PGlite;
  edge: FakeEdge;
  client: RpcClient;
  close(): Promise<void>;
}

async function fixtureDatabase(): Promise<Fixture> {
  const { db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', supabaseGrants: true });
  const edge = await startFakeEdge({ db });
  const env = fixtureProcessEnv(edge.url);
  const client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as RpcClient;
  return {
    db,
    edge,
    client,
    close: async () => {
      await edge.close().catch(() => undefined);
      await db.close().catch(() => undefined);
    },
  };
}

async function rpc(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await client.rpc(fn, args).abortSignal(new AbortController().signal);
  if (response.error) throw new Error(`parity: ${fn} failed (${response.error.code ?? 'rpc_error'})`);
  return response.data;
}

/**
 * As in production (D-12): the target is enabled first, the rows go through the outbox triggers, and drainSlice moves them. The
 * external profile is the only synced one in this database, with its vectors in chunk_embeddings.
 */
async function seedThroughOutbox(fixture: Fixture, store: VectorStore, target: VectorSyncTarget): Promise<void> {
  await fixture.db.query("UPDATE public.embedding_profiles SET status = 'retired' WHERE status = 'active'");
  await fixture.db.query("UPDATE public.embedding_profiles SET status = 'active' WHERE id = $1", [EXT_PROFILE]);
  await rpc(fixture.client, 'rag_vector_sync_set_target', { p_target: target, p_enabled: true, p_actor: 'parity-seed' });
  await insertFixture(fixture.db);
  for (const c of [...TENANT_A_CHUNKS, ...TENANT_B_CHUNKS]) {
    const tenantKey = c.userId === USER_A ? canonicalTenantKey(tenantA) : canonicalTenantKey(tenantB);
    await fixture.db.query(
      `INSERT INTO public.chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
       SELECT $1::uuid, p.id, $2, $3::halfvec, p.model, p.dims FROM public.embedding_profiles p WHERE p.id = $4`,
      [c.chunkId, tenantKey, `[${embedText(c.tokens.join(' '), EXT_DIMS).join(',')}]`, EXT_PROFILE],
    );
  }
  for (let slice = 0; slice < 20; slice += 1) {
    const report = await drainSlice({ store, rpc: fixture.client, budgetMs: 60_000, batch: 100 });
    if (report.failed > 0) throw new Error(`parity: ${report.failed} outbox rows failed`);
    if (report.claimed === 0) return;
  }
  throw new Error('parity: the outbox did not drain');
}

async function lexicalIds(backend: RetrievalBackend, scope: TenantScope, scoring: LexicalScoringRequest | undefined, profileId?: string): Promise<string[]> {
  const legs = await backend.search(searchRequest(scope, scoring, profileId));
  return legs.lexical.map((hit) => hit.chunkId);
}

async function lexicalScores(
  backend: RetrievalBackend,
  scope: TenantScope,
  scoring: LexicalScoringRequest | undefined,
  profileId?: string,
): Promise<Record<string, number | null>> {
  const legs = await backend.search(searchRequest(scope, scoring, profileId));
  const names = new Map([...TENANT_A_CHUNKS, ...TENANT_B_CHUNKS].map((c) => [c.chunkId, c.name]));
  return Object.fromEntries(legs.lexical.slice(0, 3).map((hit) => [names.get(hit.chunkId) ?? hit.chunkId, hit.lexicalScore]));
}

function expectTenantsApart(aIds: string[], bIds: string[]): void {
  expect(aIds.filter((id) => B_IDS.has(id))).toEqual([]);
  expect(bIds.filter((id) => A_IDS.has(id))).toEqual([]);
  expect(bIds.length).toBeGreaterThan(0);
}

beforeEach(() => {
  resetLexicalParamsChecks();
  resetLexstatsCacheForTests();
});

describe('lexical-params parity fixture (LEX-05)', () => {
  it('fixture flips: P above Q at k1 1.2, Q above P at k1 1.5, R third at both, with the calibrated margin', () => {
    const at12 = referenceTop(TENANT_A_CHUNKS, K12);
    const at15 = referenceTop(TENANT_A_CHUNKS, K15);
    expect(at12.slice(0, 3).map((r) => r.id)).toEqual(ORDER_K12);
    expect(at15.slice(0, 3).map((r) => r.id)).toEqual(ORDER_K15);
    for (const [setting, top] of [['k12', at12], ['k15', at15]] as const) {
      const byName = Object.fromEntries(top.map((r) => [r.name, r.score]));
      for (const name of ['P', 'Q', 'R'] as const) expect(byName[name]).toBeCloseTo(CALIBRATED[setting][name], 6);
      expect(gap(byName.P, byName.Q)).toBeGreaterThanOrEqual(MARGIN);
      expect(gap(Math.min(byName.P, byName.Q), byName.R)).toBeGreaterThanOrEqual(MARGIN);
      expect(top[3] === undefined || top[3].score < byName.R).toBe(true);
    }
    const decoy = referenceTop([...TENANT_A_CHUNKS, ...TENANT_B_CHUNKS], K15);
    expect(decoy[0]?.id).toBe(ID.DB1);
  });
});

describe('request level (fakes): the configured pair reaches every store', () => {
  it('pgvector: rag_bm25_search_chunks carries p_k1 1.5 and p_b 0.75 under bm25, and no BM25 call under the default', async () => {
    const fixture = await fixtureDatabase();
    try {
      await insertFixture(fixture.db);
      for (const scope of [tenantA, tenantB]) {
        await fixture.db.query('SELECT rag_lexstats_enable($1)', [canonicalTenantKey(scope)]);
        await fixture.db.query('SELECT rag_lexstats_rebuild($1)', [canonicalTenantKey(scope)]);
      }
      const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const recording: RpcClient = {
        rpc(fn, args) {
          calls.push({ fn, args: args ?? {} });
          return fixture.client.rpc(fn, args);
        },
      };
      const backend = createPgvectorBackend({ adminClient: () => recording, getConfig: () => loadRagConfig(bm25Env(K15)) });
      await backend.search(searchRequest(tenantA, scoringFor(K15)));
      const bm25 = calls.find((c) => c.fn === 'rag_bm25_search_chunks');
      expect(bm25?.args).toMatchObject({ p_k1: 1.5, p_b: 0.75 });
      calls.length = 0;
      resetRagConfigForTests();
      expect(lexicalScoringArg(loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_LEXICAL_BM25_K1: '1.5' })).lexicalScoring).toBeUndefined();
      await backend.search(searchRequest(tenantA, undefined));
      expect(calls.some((c) => c.fn === 'rag_bm25_search_chunks')).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('weaviate and qdrant: bm25k1 1.5 in the creation body and k 1.5 on the lexical node; the default pair builds today\'s', async () => {
    resetRagConfigForTests();
    const raised = externalLexicalParams(loadRagConfig(bm25Env(K15)));
    resetRagConfigForTests();
    const shipped = externalLexicalParams(loadRagConfig({ RAG_LEXICAL_BM25_K1: '1.5' }));
    for (const [pair, k1] of [[raised, 1.5], [shipped, 1.2]] as const) {
      const weaviate = createFakeWeaviate();
      await createWeaviateStore({ client: weaviate, lexicalParams: () => pair }).ensureCollection({ profileId: PROFILE_ID, dims: 3 });
      const created = JSON.parse(JSON.stringify(weaviate.calls.find((c) => c.op === 'collections.create')!.args)) as Record<string, unknown>;
      expect((created.invertedIndex as { bm25: unknown }).bm25).toEqual({ k1, b: 0.75 });

      const qdrant = createFakeQdrantClient();
      const store = createQdrantStore({ writeClient: qdrant, lexicalParams: () => pair, log: () => undefined });
      await store.ensureCollection({ profileId: PROFILE_ID, dims: 3 });
      await store.searchLegs({ ...searchRequest(tenantA, undefined), profileId: PROFILE_ID, denseVector: [0.1, 0.2, 0.3], denseLimit: 1 });
      const batch = qdrant.requests.filter((r) => r.method === 'queryBatch').at(-1)!;
      const lexical = (batch.body as { searches: Array<Record<string, unknown>> }).searches.find((s) => s.using === 'lexical_text')!;
      expect(lexical.query).toEqual(k1 === 1.5 ? { text: { query: QUERY.join(' '), scoring: { bm25: { k: 1.5, b: 0.75 } } } } : { text: QUERY.join(' ') });
    }
  });
});

describe('ranking level: pgvector (PGlite)', () => {
  let fixture: Fixture;
  let backend: RetrievalBackend;

  beforeAll(async () => {
    fixture = await fixtureDatabase();
    await insertFixture(fixture.db);
    for (const scope of [tenantA, tenantB]) {
      await fixture.db.query('SELECT rag_lexstats_enable($1)', [canonicalTenantKey(scope)]);
      await fixture.db.query('SELECT rag_lexstats_rebuild($1)', [canonicalTenantKey(scope)]);
    }
    backend = createPgvectorBackend({ adminClient: () => fixture.client, getConfig: () => loadRagConfig(bm25Env(K15)) });
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it('pgvector returns the reference order at k1 1.5 and the k1 1.2 order at k1 1.2', async () => {
    expect((await lexicalIds(backend, tenantA, scoringFor(K15))).slice(0, 3)).toEqual(ORDER_K15);
    expect((await lexicalIds(backend, tenantA, scoringFor(K12))).slice(0, 3)).toEqual(ORDER_K12);
  });

  it('pgvector keeps the tenants apart at both settings', async () => {
    for (const params of [K12, K15]) {
      expectTenantsApart(await lexicalIds(backend, tenantA, scoringFor(params)), await lexicalIds(backend, tenantB, scoringFor(params)));
    }
  });

  it('pgvector scores equal the reference', async () => {
    for (const [params, setting] of [[K12, 'k12'], [K15, 'k15']] as const) {
      const scores = await lexicalScores(backend, tenantA, scoringFor(params));
      for (const name of ['P', 'Q', 'R'] as const) expect(scores[name]).toBeCloseTo(CALIBRATED[setting][name], 5);
    }
  });
});

interface ExternalHarness {
  target: VectorSyncTarget;
  fixture: Fixture;
  backendFor(params: LexicalParams): RetrievalBackend;
  rebuildTo(params: LexicalParams): Promise<number>;
  close(): Promise<void>;
}

const LOCAL_KEYS = {
  qdrantWrite: 'local-qdrant-write-key-placeholder-000000',
  qdrantRead: 'local-qdrant-read-key-placeholder-0000000',
};

async function weaviateHarness(): Promise<ExternalHarness> {
  const { getWeaviateReadClient, getWeaviateWriteClient } = await import('@/lib/rag/backend/weaviate/client');
  const write: WeaviateClientLike = await getWeaviateWriteClient();
  const read: WeaviateClientLike = await getWeaviateReadClient();
  const collection = weaviateCollectionName(EXT_PROFILE);
  if (await write.collections.exists(collection)) await write.collections.delete(collection);
  const fixture = await fixtureDatabase();
  const pair = { current: K15 };
  const store = createWeaviateStore({ client: write, lexicalParams: () => pair.current, warn: () => undefined });
  await seedThroughOutbox(fixture, store, 'weaviate');
  return {
    target: 'weaviate',
    fixture,
    backendFor: (params) =>
      createWeaviateBackend({ readClient: read, revalidate: () => fixture.client, readiness: async () => true, lexicalParams: () => params, log: () => undefined }),
    rebuildTo: async (params) => {
      pair.current = params;
      const factories = { weaviate: async () => createWeaviateStore({ client: write, lexicalParams: () => params, warn: () => undefined }) } as unknown as VectorStoreFactories;
      return vectorSyncCli(['vector-sync', 'rebuild-lexical', '--target', 'weaviate', '--confirm'], { out: () => undefined, err: () => undefined }, { rpc: fixture.client, factories });
    },
    close: async () => {
      await write.collections.delete(collection).catch(() => undefined);
      await fixture.close();
    },
  };
}

async function qdrantHarness(): Promise<ExternalHarness> {
  const clients = buildQdrantClients(
    {
      url: process.env.QDRANT_URL ?? '',
      apiKey: process.env.QDRANT_API_KEY || LOCAL_KEYS.qdrantWrite,
      readApiKey: process.env.QDRANT_READ_API_KEY || LOCAL_KEYS.qdrantRead,
      nodeEnv: 'test',
    },
    { warn: () => undefined },
  );
  const collection = qdrantCollectionName(EXT_PROFILE);
  const drop = async (client: QdrantApi) => {
    try {
      await client.deleteCollection(collection);
    } catch (error) {
      if (qdrantErrorStatus(error) !== 404) throw error;
    }
  };
  await drop(clients.write);
  const fixture = await fixtureDatabase();
  const store = createQdrantStore({ writeClient: clients.write, lexicalParams: () => K15, log: () => undefined });
  await seedThroughOutbox(fixture, store, 'qdrant');
  return {
    target: 'qdrant',
    fixture,
    backendFor: (params) => createQdrantBackend({ readClient: clients.read, adminClient: () => fixture.client, readiness: async () => true, lexicalParams: () => params }),
    rebuildTo: async (params) => {
      const factories = { qdrant: async () => createQdrantStore({ writeClient: clients.write, lexicalParams: () => params, log: () => undefined }) } as unknown as VectorStoreFactories;
      return vectorSyncCli(['vector-sync', 'rebuild-lexical', '--target', 'qdrant', '--confirm'], { out: () => undefined, err: () => undefined }, { rpc: fixture.client, factories });
    },
    close: async () => {
      await drop(clients.write).catch(() => undefined);
      await fixture.close();
    },
  };
}

function externalRanking(name: 'weaviate' | 'qdrant', url: string | undefined, build: () => Promise<ExternalHarness>): void {
  if (!url) {
    if (CI) {
      it(`${name} parity needs its backend in the backend-canary job`, () => {
        expect.fail(`${name.toUpperCase()}_URL is not set while CI_BACKEND_CANARY=1`);
      });
    } else {
      describe.skip(`ranking level: ${name} (no ${name.toUpperCase()}_URL)`, () => {
        it('skipped', () => undefined);
      });
    }
    return;
  }
  describe(`ranking level: ${name}`, () => {
    let harness: ExternalHarness;
    const observed: Record<string, Record<string, number | null>> = {};

    beforeAll(async () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      harness = await build();
    }, 180_000);

    afterAll(async () => {
      vi.restoreAllMocks();
      await harness?.close();
      if (Object.keys(observed).length > 0) console.info(`[Parity] ${name} lexical scores`, JSON.stringify(observed));
    });

    it(`${name} returns the reference order at k1 1.5 and keeps the tenants apart`, async () => {
      const backend = harness.backendFor(K15);
      observed.k15 = await lexicalScores(backend, tenantA, undefined, EXT_PROFILE);
      expect((await lexicalIds(backend, tenantA, undefined, EXT_PROFILE)).slice(0, 3)).toEqual(ORDER_K15);
      expectTenantsApart(await lexicalIds(backend, tenantA, undefined, EXT_PROFILE), await lexicalIds(backend, tenantB, undefined, EXT_PROFILE));
    }, 60_000);

    it(`${name} after rebuild-lexical to k1 1.2 returns the k1 1.2 order and keeps the tenants apart`, async () => {
      expect(await harness.rebuildTo(K12)).toBe(0);
      const backend = harness.backendFor(K12);
      observed.k12 = await lexicalScores(backend, tenantA, undefined, EXT_PROFILE);
      expect((await lexicalIds(backend, tenantA, undefined, EXT_PROFILE)).slice(0, 3)).toEqual(ORDER_K12);
      expectTenantsApart(await lexicalIds(backend, tenantA, undefined, EXT_PROFILE), await lexicalIds(backend, tenantB, undefined, EXT_PROFILE));
    }, 180_000);
  });
}

externalRanking('weaviate', process.env.WEAVIATE_URL, weaviateHarness);
externalRanking('qdrant', process.env.QDRANT_URL, qdrantHarness);

