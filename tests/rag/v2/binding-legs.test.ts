import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendSearchRequest, RetrievalBackend, RetrievalFilters } from '@/lib/rag/backend/types';
import { EmbeddingProfileMismatchError } from '@/lib/rag/backend/supabase-rpc';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import type { EmbeddingProfile } from '@/lib/rag/embeddings/active-profile';
import type { EffectiveBinding } from '@/lib/rag/embeddings/bindings';
import { mintScope } from '@/lib/rag/tenant/scope';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import {
  bindingFailureDetail,
  bindingHashFields,
  planBindingLegs,
  runBindingLegs,
  startBindingEmbeds,
  type BindingLegDeps,
  type BindingLegPlan,
} from '@/lib/rag/v2/stages/binding-legs';
import { hit } from '../fusion/helpers';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const scope = mintScope('org', '00000000-0000-4000-8000-0000000000aa', ORG_A);
const GLOBAL = 'voyage-4-large-1024';
const LAW = 'voyage-law-2-1024';
const FINANCE = 'voyage-finance-2-1024';
const DOMAIN = 'voyage-4-large-1024-domain';

function profile(id: string, model: string): EmbeddingProfile {
  return {
    id,
    provider: 'voyage',
    model,
    dims: 4,
    storage: 'halfvec',
    status: 'available',
    queryInstruction: null,
    scoreCalibration: {},
    activatedAt: null,
    activatedBy: null,
    previousActiveId: null,
    hasEvidence: true,
  };
}

const PROFILES: Record<string, EmbeddingProfile> = {
  [GLOBAL]: { ...profile(GLOBAL, 'voyage-4-large'), status: 'active' },
  [LAW]: profile(LAW, 'voyage-law-2'),
  [FINANCE]: profile(FINANCE, 'voyage-finance-2'),
  [DOMAIN]: profile(DOMAIN, 'voyage-4-large'),
};

function binding(docType: string, profileId: string, stale = false): EffectiveBinding {
  return {
    bindingId: `b-${docType}`,
    docType,
    tenantKey: null,
    profile: { ...PROFILES[profileId]!, docTypes: [docType] },
    stale,
  };
}

function deps(bindings: EffectiveBinding[] | (() => Promise<EffectiveBinding[]>)): BindingLegDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    effectiveBindings: async (tenantKey) => {
      reads.push(tenantKey);
      return typeof bindings === 'function' ? bindings() : bindings;
    },
    profileById: async (id) => {
      const found = PROFILES[id];
      if (!found) throw new Error('unknown profile');
      return found;
    },
  };
}

function config(over: Record<string, string> = {}): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig({
    RAG_PIPELINE: 'v2',
    RAG_EMBEDDING_PROFILES: 'on',
    RAG_DOMAIN_EMBEDDINGS: 'on',
    RAG_DOMAIN_EMBEDDING_MAX_LEGS: '2',
    ...over,
  });
}

const baseFilters: RetrievalFilters = { currentOnly: true };
const STANDARD = [binding('contract_legal', LAW), binding('financial_report', FINANCE, true)];

function docTypes(legs: readonly BindingLegPlan[]): string[] {
  return legs.map((leg) => leg.docType);
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetRagConfigForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('planBindingLegs', () => {
  it('plans one leg per fresh binding and skips stale bindings', async () => {
    const fake = deps(STANDARD);
    const plan = await planBindingLegs({ profile: 'chat', config: config(), scope, filters: baseFilters }, fake);
    expect(docTypes(plan.legs)).toEqual(['contract_legal']);
    expect(plan.legs[0]).toMatchObject({ profileId: LAW, source: 'binding' });
    expect(fake.reads).toEqual([`o:${ORG_A}`]);
    expect(plan.controlLeg).toBeNull();
    expect(plan.failures).toEqual([]);
  });

  it('intersects with the request docTypes filter', async () => {
    const none = await planBindingLegs(
      { profile: 'chat', config: config(), scope, filters: { ...baseFilters, docTypes: ['general'] } },
      deps(STANDARD),
    );
    expect(none.legs).toEqual([]);
    const one = await planBindingLegs(
      { profile: 'chat', config: config(), scope, filters: { ...baseFilters, docTypes: ['contract_legal', 'general'] } },
      deps(STANDARD),
    );
    expect(docTypes(one.legs)).toEqual(['contract_legal']);
  });

  it('caps at maxLegs keeping the lowest doc type ids', async () => {
    const fresh = [binding('financial_report', FINANCE), binding('contract_legal', LAW)];
    const plan = await planBindingLegs(
      { profile: 'embed', config: config({ RAG_DOMAIN_EMBEDDING_MAX_LEGS: '1' }), scope, filters: baseFilters },
      deps(fresh),
    );
    expect(docTypes(plan.legs)).toEqual(['contract_legal']);
    const both = await planBindingLegs({ profile: 'embed', config: config(), scope, filters: baseFilters }, deps(fresh));
    expect(docTypes(both.legs)).toEqual(['contract_legal', 'financial_report']);
  });

  it('plans nothing and reads nothing while off, with maxLegs 0 or for voice', async () => {
    for (const [profileName, over] of [
      ['chat', { RAG_DOMAIN_EMBEDDINGS: 'off' }],
      ['chat', { RAG_EMBEDDING_PROFILES: 'off' }],
      ['chat', { RAG_DOMAIN_EMBEDDING_MAX_LEGS: '0' }],
      ['voice', {}],
      ['media', {}],
    ] as const) {
      const fake = deps(STANDARD);
      const plan = await planBindingLegs({ profile: profileName, config: config(over), scope, filters: baseFilters }, fake);
      expect(plan.legs).toEqual([]);
      expect(plan.controlLeg).toBeNull();
      if (profileName === 'voice' || over.RAG_DOMAIN_EMBEDDINGS === 'off' || over.RAG_EMBEDDING_PROFILES === 'off') {
        expect(fake.reads).toEqual([]);
      }
    }
  });

  it('honours the eval override and the control leg only for the eval profile', async () => {
    const options = { embeddingBindings: { contract_legal: DOMAIN }, domainControlLeg: 'contract_legal' as const };
    const evalPlan = await planBindingLegs({ profile: 'eval', config: config(), scope, filters: baseFilters, options }, deps(STANDARD));
    expect(evalPlan.legs).toHaveLength(1);
    expect(evalPlan.legs[0]).toMatchObject({ docType: 'contract_legal', profileId: DOMAIN, source: 'eval_override' });
    expect(evalPlan.controlLeg).toBe('contract_legal');

    const chatPlan = await planBindingLegs({ profile: 'chat', config: config(), scope, filters: baseFilters, options }, deps(STANDARD));
    expect(chatPlan.legs).toHaveLength(1);
    expect(chatPlan.legs[0]).toMatchObject({ profileId: LAW, source: 'binding' });
    expect(chatPlan.controlLeg).toBeNull();
  });

  it('the eval override bypasses staleness and the effective set', async () => {
    const fake = deps(STANDARD);
    const plan = await planBindingLegs(
      { profile: 'eval', config: config(), scope, filters: baseFilters, options: { embeddingBindings: { financial_report: FINANCE } } },
      fake,
    );
    expect(docTypes(plan.legs)).toEqual(['financial_report']);
    expect(fake.reads).toEqual([]);
  });

  it('an unreadable binding registry plans no leg and records one failure instead of throwing', async () => {
    const plan = await planBindingLegs(
      { profile: 'chat', config: config(), scope, filters: baseFilters },
      deps(async () => {
        throw new Error('registry down');
      }),
    );
    expect(plan.legs).toEqual([]);
    expect(plan.failures).toEqual([{ docType: 'registry', reason: 'error' }]);
  });

  it('hash fields name the planned legs and the control leg only', async () => {
    expect(bindingHashFields({ legs: [], controlLeg: null, failures: [] })).toEqual({});
    const plan = await planBindingLegs(
      { profile: 'eval', config: config(), scope, filters: baseFilters, options: { domainControlLeg: 'contract_legal' } },
      deps(STANDARD),
    );
    expect(bindingHashFields(plan)).toEqual({ embeddingBindings: { contract_legal: LAW }, domainControlLeg: 'contract_legal' });
  });
});

function leg(docType: string, profileId: string): BindingLegPlan {
  return { docType, profileId, profile: PROFILES[profileId]!, source: 'binding' };
}

describe('startBindingEmbeds', () => {
  it('resolves each leg to a vector with the binding profile', async () => {
    const seen: string[] = [];
    const embeds = startBindingEmbeds([leg('contract_legal', LAW)], 'neutral question', new AbortController().signal, 500, async (text, _signal, used) => {
      seen.push(`${used.id}|${text}`);
      return { vector: [1, 0, 0, 0], profile: used };
    });
    expect(await Promise.all(embeds)).toEqual([{ vector: [1, 0, 0, 0] }]);
    expect(seen).toEqual([`${LAW}|neutral question`]);
  });

  it('a provider sleeping past the timeout yields timeout within timeoutMs + 50 ms', async () => {
    const started = Date.now();
    const [embed] = startBindingEmbeds([leg('contract_legal', LAW)], 'q', new AbortController().signal, 100, () => new Promise(() => undefined));
    expect(await embed).toEqual({ failure: 'timeout' });
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('a wrong model echo yields mismatch and an error yields error, never a rejection', async () => {
    const embeds = startBindingEmbeds(
      [leg('contract_legal', LAW), leg('financial_report', FINANCE)],
      'q',
      new AbortController().signal,
      500,
      async (_text, _signal, used) => {
        if (used.id === LAW) throw new EmbeddingProfileMismatchError('model', { profile: LAW, model: 'voyage-law-2', dims: 4, actual: 'other-model' });
        throw new Error('provider down');
      },
    );
    expect(await Promise.all(embeds)).toEqual([{ failure: 'mismatch' }, { failure: 'error' }]);
  });

  it('an override profile that could not be resolved fails without a provider call', async () => {
    const embed = vi.fn();
    const [result] = startBindingEmbeds(
      [{ docType: 'contract_legal', profileId: 'missing', profile: null, source: 'eval_override', resolveFailure: 'error' }],
      'q',
      new AbortController().signal,
      500,
      embed,
    );
    expect(await result).toEqual({ failure: 'error' });
    expect(embed).not.toHaveBeenCalled();
  });
});

function recordingBackend(handler?: (req: BackendSearchRequest) => Promise<{ dense: string[] }>): RetrievalBackend & { requests: BackendSearchRequest[] } {
  const requests: BackendSearchRequest[] = [];
  return {
    id: 'pgvector',
    requests,
    async search(req) {
      requests.push(req);
      const { dense } = handler ? await handler(req) : { dense: ['x1', 'x2'] };
      return { dense: dense.map((chunkId, index) => hit(chunkId, { rank: index + 1, similarity: 0.5 })), lexical: [] };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

describe('runBindingLegs', () => {
  const filters: RetrievalFilters = { currentOnly: true, languages: ['en'], sources: ['upload'] };

  it('calls the backend once per ready leg with the request scope and narrowed filters', async () => {
    const cfg = config();
    const params = effectiveRetrievalParams('chat', cfg, null);
    const backend = recordingBackend();
    const output = await runBindingLegs({
      backend,
      scope,
      filters,
      params,
      plan: { legs: [leg('contract_legal', LAW)], controlLeg: null, failures: [] },
      embeds: [Promise.resolve({ vector: [0, 1, 0, 0] })],
      globalEmbedding: { vector: [1, 1, 1, 1], profile: PROFILES[GLOBAL]! },
      signal: new AbortController().signal,
      timeoutMs: 500,
    });

    expect(backend.requests).toHaveLength(1);
    const req = backend.requests[0]!;
    expect(req.scope).toBe(scope);
    expect(req.embeddingProfileId).toBe(LAW);
    expect(req.denseVector).toEqual([0, 1, 0, 0]);
    expect(req.lexicalTokens).toEqual([]);
    expect(req.lexicalLimit).toBe(0);
    expect(req.denseLimit).toBe(params.candidate_pool_size);
    expect(req.filters).toEqual({ currentOnly: true, languages: ['en'], sources: ['upload'], docTypes: ['contract_legal'] });

    expect(output.lists).toHaveLength(1);
    expect(output.lists[0]!.id).toBe('dense_domain:contract_legal');
    expect(output.lists[0]!.weight).toBe(1);
    expect(output.lists[0]!.hits.every((row) => row.similarity === null)).toBe(true);
    expect(output.counts).toEqual({ domain: 2 });
    expect(output.failures).toEqual([]);
  });

  it('uses leg_weights.domain when set', async () => {
    const cfg = config();
    const base = effectiveRetrievalParams('chat', cfg, null);
    const params = { ...base, leg_weights: { dense: 1, lexical: 1, exact_id: 1, ...(base.leg_weights ?? {}), domain: 0.5 } };
    const output = await runBindingLegs({
      backend: recordingBackend(),
      scope,
      filters,
      params,
      plan: { legs: [leg('contract_legal', LAW)], controlLeg: null, failures: [] },
      embeds: [Promise.resolve({ vector: [0, 1, 0, 0] })],
      globalEmbedding: { vector: [1, 1, 1, 1], profile: PROFILES[GLOBAL]! },
      signal: new AbortController().signal,
      timeoutMs: 500,
    });
    expect(output.lists[0]!.weight).toBe(0.5);
  });

  it('drops failed legs, skips the backend for a failed embed and never rejects', async () => {
    const cfg = config();
    const backend = recordingBackend(async (req) => {
      if (req.embeddingProfileId === FINANCE) throw new Error('backend down');
      return { dense: ['x1'] };
    });
    const output = await runBindingLegs({
      backend,
      scope,
      filters,
      params: effectiveRetrievalParams('chat', cfg, null),
      plan: { legs: [leg('contract_legal', LAW), leg('financial_report', FINANCE), leg('general', DOMAIN)], controlLeg: null, failures: [] },
      embeds: [Promise.resolve({ failure: 'timeout' }), Promise.resolve({ vector: [1, 0, 0, 0] }), Promise.resolve({ vector: [0, 0, 1, 0] })],
      globalEmbedding: { vector: [1, 1, 1, 1], profile: PROFILES[GLOBAL]! },
      signal: new AbortController().signal,
      timeoutMs: 500,
    });
    expect(backend.requests.map((req) => req.embeddingProfileId)).toEqual([FINANCE, DOMAIN]);
    expect(output.failures).toEqual([
      { docType: 'contract_legal', reason: 'timeout' },
      { docType: 'financial_report', reason: 'error' },
    ]);
    expect(output.lists.map((list) => list.id)).toEqual(['dense_domain:general']);
    expect(bindingFailureDetail(output.failures)).toBe('binding_leg_timeout:contract_legal');
  });

  it('adds the control leg with the global profile and the global vector', async () => {
    const cfg = config();
    const backend = recordingBackend();
    const output = await runBindingLegs({
      backend,
      scope,
      filters,
      params: effectiveRetrievalParams('eval', cfg, null),
      plan: { legs: [], controlLeg: 'contract_legal', failures: [] },
      embeds: [],
      globalEmbedding: { vector: [1, 1, 1, 1], profile: PROFILES[GLOBAL]! },
      signal: new AbortController().signal,
      timeoutMs: 500,
    });
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]).toMatchObject({
      embeddingProfileId: GLOBAL,
      denseVector: [1, 1, 1, 1],
      lexicalLimit: 0,
      filters: { docTypes: ['contract_legal'] },
    });
    expect(output.lists.map((list) => list.id)).toEqual(['dense_domain_control:contract_legal']);
    expect(output.counts).toEqual({ domain: 0, domain_control: 2 });
  });

  it('a backend call past timeoutMs is dropped as a timeout', async () => {
    const cfg = config();
    const started = Date.now();
    const output = await runBindingLegs({
      backend: recordingBackend(() => new Promise(() => undefined)),
      scope,
      filters,
      params: effectiveRetrievalParams('chat', cfg, null),
      plan: { legs: [leg('contract_legal', LAW)], controlLeg: null, failures: [] },
      embeds: [Promise.resolve({ vector: [1, 0, 0, 0] })],
      globalEmbedding: { vector: [1, 1, 1, 1], profile: PROFILES[GLOBAL]! },
      signal: new AbortController().signal,
      timeoutMs: 80,
    });
    expect(output.failures).toEqual([{ docType: 'contract_legal', reason: 'timeout' }]);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
