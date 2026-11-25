import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { retrievalOptionsAreDefault } from '@/lib/rag/cache/bypass';
import { computeCacheKeyHash } from '@/lib/rag/cache/keys';
import type { CacheKeyParts } from '@/lib/rag/cache/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { resetRagConfigForTests } from '@/lib/rag/config';
import type { EmbeddingProfile } from '@/lib/rag/embeddings/active-profile';
import type { EffectiveBinding } from '@/lib/rag/embeddings/bindings';
import { runRetrieval } from '@/lib/rag';
import { mintScope } from '@/lib/rag/tenant/scope';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const GLOBAL_PROFILE: EmbeddingProfile = {
  id: 'voyage-4-large-1024',
  provider: 'voyage',
  model: 'voyage-4-large',
  dims: 3,
  storage: 'halfvec',
  status: 'active',
  queryInstruction: null,
  scoreCalibration: {},
  activatedAt: null,
  activatedBy: null,
  previousActiveId: null,
  hasEvidence: true,
};
const B1_PROFILE: EmbeddingProfile = { ...GLOBAL_PROFILE, id: 'voyage-law-2-1024', model: 'voyage-law-2', status: 'available' };
const B2_PROFILE: EmbeddingProfile = { ...GLOBAL_PROFILE, id: 'voyage-finance-2-1024', model: 'voyage-finance-2', status: 'available' };

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const scopeA = mintScope('org', '00000000-0000-4000-8000-0000000000aa', ORG_A);
const scopeB = mintScope('org', '00000000-0000-4000-8000-0000000000bb', ORG_B);

/** Effective bindings per tenant key; a tenant missing from the map has none. */
let bindingsByTenant: Record<string, EffectiveBinding[]> = {};

vi.mock('@/lib/rag/embeddings/query-embedding', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/embeddings/query-embedding')>();
  return {
    ...original,
    embedQuery: async () => ({ vector: [0.1, 0.2, 0.3], profile: GLOBAL_PROFILE }),
    embedQueryForEvalProfile: async (_text: string, _signal: AbortSignal, profile: EmbeddingProfile) => ({ vector: [0.3, 0.2, 0.1], profile }),
  };
});

vi.mock('@/lib/rag/embeddings/bindings', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/embeddings/bindings')>();
  return { ...original, getEffectiveBindings: async (tenantKey: string) => bindingsByTenant[tenantKey] ?? [] };
});

function binding(profile: EmbeddingProfile, docType: string, tenantKey: string): EffectiveBinding {
  return { bindingId: `b-${profile.id}`, docType, tenantKey, profile: { ...profile, docTypes: [docType] }, stale: false };
}

function install(): void {
  resetActiveChunkingProfilesForTests();
  const rpc = fakeRpcClient();
  installDeps({
    adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
    ragEnv: () => ({
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'false',
      RAG_RERANKER: 'none',
      RAG_EMBEDDING_PROFILES: 'on',
      RAG_DOMAIN_EMBEDDINGS: 'on',
    }),
  });
  const backend: RetrievalBackend = {
    id: 'pgvector',
    async search() {
      return { dense: [hit('a', { rank: 1, similarity: 0.9, documentId: 'doc-a' })], lexical: [] };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  setRetrievalBackendForTests(backend);
}

async function configHashFor(scope: typeof scopeA): Promise<string> {
  install();
  await verifyV2Startup();
  const result = await runRetrieval({ scope, query: 'neutral sample question', profile: 'chat', options: {}, signal: new AbortController().signal });
  expect(result.status).not.toBe('error');
  expect(typeof result.retrievalConfigHash).toBe('string');
  return result.retrievalConfigHash as string;
}

const KEY_BASE: Omit<CacheKeyParts, 'retrievalConfigHash'> = {
  answerLanguage: 'en',
  ragMode: 'strict',
  generatorModel: 'provider/model-a',
  queryFramework: 'llamaindex',
  entryProfile: 'chat',
  systemPromptHash: 'b'.repeat(64),
};

function cacheKey(retrievalConfigHash: string): string {
  return computeCacheKeyHash({ ...KEY_BASE, retrievalConfigHash });
}

describe('binding overrides bypass the semantic cache (03.1.1-10)', () => {
  it('an eval binding map or control leg is an off-default retrieval option', () => {
    expect(retrievalOptionsAreDefault({ embeddingBindings: { contract_legal: 'voyage-law-2-1024' } }, 25)).toBe(false);
    expect(retrievalOptionsAreDefault({ domainControlLeg: 'contract_legal' }, 25)).toBe(false);
    expect(retrievalOptionsAreDefault({ embeddingBindings: {}, domainControlLeg: 'contract_legal' }, 25)).toBe(false);
  });

  it('absent options stay default', () => {
    expect(retrievalOptionsAreDefault(undefined, 25)).toBe(true);
    expect(retrievalOptionsAreDefault({}, 25)).toBe(true);
    expect(retrievalOptionsAreDefault({ maxResults: 25 }, 25)).toBe(true);
  });
});

describe('the cache key follows the tenant binding state (03.1.1-10)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    resetV2StartupForTests();
    bindingsByTenant = {};
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    vi.restoreAllMocks();
  });

  it('no binding, binding B1 and binding B2 give three different keys for the bound tenant', async () => {
    const tenantA = `o:${ORG_A}`;
    const none = cacheKey(await configHashFor(scopeA));
    bindingsByTenant = { [tenantA]: [binding(B1_PROFILE, 'contract_legal', tenantA)] };
    const b1 = cacheKey(await configHashFor(scopeA));
    bindingsByTenant = { [tenantA]: [binding(B2_PROFILE, 'contract_legal', tenantA)] };
    const b2 = cacheKey(await configHashFor(scopeA));

    expect(new Set([none, b1, b2]).size).toBe(3);
  });

  it("another tenant's binding leaves this tenant's key unchanged", async () => {
    const tenantA = `o:${ORG_A}`;
    const noneB = cacheKey(await configHashFor(scopeB));
    bindingsByTenant = { [tenantA]: [binding(B1_PROFILE, 'contract_legal', tenantA)] };
    const withABinding = cacheKey(await configHashFor(scopeB));

    expect(withABinding).toBe(noneB);
  });

  it('an entry stored while B1 is active is not found after B1 is deactivated (key level; the semantic_cache stage is not on trunk)', async () => {
    const tenantA = `o:${ORG_A}`;
    const store = new Map<string, string>();
    bindingsByTenant = { [tenantA]: [binding(B1_PROFILE, 'contract_legal', tenantA)] };
    store.set(cacheKey(await configHashFor(scopeA)), 'answer retrieved under B1');

    bindingsByTenant = {};
    expect(store.get(cacheKey(await configHashFor(scopeA)))).toBeUndefined();

    bindingsByTenant = { [tenantA]: [binding(B1_PROFILE, 'contract_legal', tenantA)] };
    expect(store.get(cacheKey(await configHashFor(scopeA)))).toBe('answer retrieved under B1');
  });
});
