import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { resetRagConfigForTests } from '@/lib/rag/config';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import type { EmbeddingProfile } from '@/lib/rag/embeddings/active-profile';
import type { EffectiveBinding } from '@/lib/rag/embeddings/bindings';
import { runRetrieval } from '@/lib/rag';
import { mintScope } from '@/lib/rag/tenant/scope';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { computeRetrievalConfigHash } from '@/lib/rag/v2/config-hash';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const timeline: Array<{ event: string; at: number }> = [];
let globalDelayMs = 0;
let bindingDelayMs = 0;
let bindingHang = false;
let effective: EffectiveBinding[] = [];
const bindingReads: string[] = [];

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
const LAW_PROFILE: EmbeddingProfile = { ...GLOBAL_PROFILE, id: 'voyage-law-2-1024', model: 'voyage-law-2', status: 'available' };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

vi.mock('@/lib/rag/embeddings/query-embedding', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/embeddings/query-embedding')>();
  return {
    ...original,
    embedQuery: async () => {
      timeline.push({ event: 'global_start', at: Date.now() });
      await sleep(globalDelayMs);
      timeline.push({ event: 'global_end', at: Date.now() });
      return { vector: [0.1, 0.2, 0.3], profile: GLOBAL_PROFILE };
    },
    embedQueryForEvalProfile: async (_text: string, _signal: AbortSignal, profile: EmbeddingProfile) => {
      timeline.push({ event: `binding_start:${profile.id}`, at: Date.now() });
      if (bindingHang) await new Promise(() => undefined);
      await sleep(bindingDelayMs);
      timeline.push({ event: 'binding_end', at: Date.now() });
      return { vector: [0.3, 0.2, 0.1], profile };
    },
  };
});

vi.mock('@/lib/rag/embeddings/bindings', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/embeddings/bindings')>();
  return {
    ...original,
    getEffectiveBindings: async (tenantKey: string) => {
      bindingReads.push(tenantKey);
      return effective;
    },
  };
});

vi.mock('@/lib/rag/v2/config-hash', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/v2/config-hash')>();
  return { ...original, computeRetrievalConfigHash: vi.fn(original.computeRetrievalConfigHash) };
});

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const scope = mintScope('org', '00000000-0000-4000-8000-0000000000aa', ORG_A);

function lawBinding(stale = false): EffectiveBinding {
  return { bindingId: 'b-1', docType: 'contract_legal', tenantKey: null, profile: { ...LAW_PROFILE, docTypes: ['contract_legal'] }, stale };
}

function install(env: Record<string, string> = {}): BackendSearchRequest[] {
  resetActiveChunkingProfilesForTests();
  const requests: BackendSearchRequest[] = [];
  const rpc = fakeRpcClient();
  installDeps({
    adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
    ragEnv: () => ({
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'false',
      RAG_RERANKER: 'none',
      RAG_EMBEDDING_PROFILES: 'on',
      RAG_DOMAIN_EMBEDDINGS: 'on',
      ...env,
    }),
  });
  const backend: RetrievalBackend = {
    id: 'pgvector',
    async search(req) {
      requests.push(req);
      if (req.embeddingProfileId === LAW_PROFILE.id) return { dense: [hit('z', { rank: 1, similarity: 0.3, documentId: 'doc-z' })], lexical: [] };
      return { dense: [hit('a', { rank: 1, similarity: 0.9, documentId: 'doc-a' })], lexical: [] };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  setRetrievalBackendForTests(backend);
  return requests;
}

async function retrieve(profile: 'chat' | 'eval' | 'voice' = 'chat', options: Record<string, unknown> = {}) {
  await verifyV2Startup();
  return runRetrieval({ scope, query: 'neutral sample question', profile, options, signal: new AbortController().signal });
}

beforeEach(() => {
  uninstallDeps();
  resetRagConfigForTests();
  resetV2StartupForTests();
  timeline.length = 0;
  bindingReads.length = 0;
  globalDelayMs = 0;
  bindingDelayMs = 0;
  bindingHang = false;
  effective = [];
  vi.mocked(computeRetrievalConfigHash).mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  uninstallDeps();
  resetRetrievalBackendForTests();
  vi.restoreAllMocks();
});

describe('v2 pipeline binding legs', () => {
  it('starts the binding embed before the global embed and runs both concurrently', async () => {
    effective = [lawBinding()];
    globalDelayMs = 80;
    bindingDelayMs = 80;
    const requests = install();
    const result = await retrieve();
    expect(timeline.map((row) => row.event)).toContain(`binding_start:${LAW_PROFILE.id}`);
    const bindingStart = timeline.find((row) => row.event === `binding_start:${LAW_PROFILE.id}`)!;
    const globalStart = timeline.find((row) => row.event === 'global_start')!;
    expect(timeline.indexOf(bindingStart)).toBeLessThan(timeline.indexOf(globalStart));
    const bindingEnd = timeline.find((row) => row.event === 'binding_end')!;
    const globalEnd = timeline.find((row) => row.event === 'global_end')!;
    // Serial embeds would end the binding embed about 80 ms after the global one.
    expect(bindingEnd.at - globalEnd.at).toBeLessThan(40);
    expect(requests.map((req) => req.embeddingProfileId)).toEqual([GLOBAL_PROFILE.id, LAW_PROFILE.id]);
    expect(requests.every((req) => req.scope === scope)).toBe(true);
    expect(bindingReads).toEqual([`o:${ORG_A}`]);
    expect(result.stages.find((row) => row.name === 'search')?.counts).toMatchObject({ domain: 1 });
  });

  it('with the switch off, no binding or stale bindings only, the backend calls and the config hash are unchanged', async () => {
    install({ RAG_DOMAIN_EMBEDDINGS: 'off' });
    const off = await retrieve();
    const offRequests = install({ RAG_DOMAIN_EMBEDDINGS: 'off' });
    await retrieve();

    effective = [];
    const noneRequests = install();
    const none = await retrieve();

    effective = [lawBinding(true)];
    const staleRequests = install();
    const stale = await retrieve();

    for (const [result, requests] of [
      [none, noneRequests],
      [stale, staleRequests],
    ] as const) {
      expect(result.retrievalConfigHash).toBe(off.retrievalConfigHash);
      expect(requests.map((req) => req.embeddingProfileId)).toEqual(offRequests.map((req) => req.embeddingProfileId));
      expect(result.stages.find((row) => row.name === 'search')).toMatchObject({ status: 'ok', counts: { dense: 1, lexical: 0 } });
      expect(result.stages.find((row) => row.name === 'search')?.counts).not.toHaveProperty('domain');
    }
    expect(timeline.some((row) => row.event.startsWith('binding_start'))).toBe(false);
  });

  it('a planned leg changes the hash, carries the binding map, and a timed-out leg keeps the same hash', async () => {
    install();
    const off = await retrieve();

    effective = [lawBinding()];
    install();
    const ok = await retrieve();
    expect(ok.retrievalConfigHash).not.toBe(off.retrievalConfigHash);
    const hashInputs = vi.mocked(computeRetrievalConfigHash).mock.calls.map(([input]) => input);
    expect(hashInputs.at(-1)).toMatchObject({ embeddingBindings: { contract_legal: LAW_PROFILE.id } });

    bindingHang = true;
    install({ RAG_DOMAIN_EMBEDDING_TIMEOUT_MS: '100' });
    const timedOut = await retrieve();
    expect(timedOut.retrievalConfigHash).toBe(ok.retrievalConfigHash);
    const search = timedOut.stages.find((row) => row.name === 'search');
    expect(search?.status).toBe('degraded');
    expect(search?.detail).toBe('binding_leg_timeout:contract_legal');
    expect(timedOut.status).not.toBe('error');
  });

  it('the eval control leg changes the hash and searches the global profile filtered to the doc type', async () => {
    install();
    const base = await retrieve('eval');
    const requests = install();
    const control = await retrieve('eval', { domainControlLeg: 'contract_legal' });
    expect(control.retrievalConfigHash).not.toBe(base.retrievalConfigHash);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ embeddingProfileId: GLOBAL_PROFILE.id, lexicalLimit: 0, filters: { docTypes: ['contract_legal'] } });
  });

  it('an eval binding override naming an unknown profile is an error, never a run on the global profile (03.1.1-10)', async () => {
    const requests = install();
    const result = await retrieve('eval', { embeddingBindings: { contract_legal: 'no-such-profile-1024' } });

    expect(result.status).toBe('error');
    expect(result.reason).toBe('embedding_profile_mismatch');
    expect(result.candidates).toEqual([]);
    expect(requests).toHaveLength(0);
    const record = result.stages.find((stage) => stage.reason === 'embedding_profile_mismatch');
    expect(record?.status).toBe('error');
    expect(record?.detail).toBe('unknown_profile:contract_legal');
  });

  it('a chat request ignores the eval override fields and runs the global profile', async () => {
    const requests = install();
    const result = await retrieve('chat', { embeddingBindings: { contract_legal: 'no-such-profile-1024' }, domainControlLeg: 'contract_legal' });

    expect(result.status).not.toBe('error');
    expect(requests).toHaveLength(1);
  });

  it('with the domain switch off an eval binding override or control leg is refused before any search', async () => {
    for (const options of [{ embeddingBindings: { contract_legal: LAW_PROFILE.id } }, { domainControlLeg: 'contract_legal' }]) {
      const requests = install({ RAG_DOMAIN_EMBEDDINGS: 'off' });
      const result = await retrieve('eval', options);
      expect(result.status).toBe('error');
      expect(result.reason).toBe('domain_embeddings_disabled');
      expect(requests).toHaveLength(0);
    }
  });

  it('on the legacy pipeline an eval binding override is refused, never ignored', async () => {
    install({ RAG_PIPELINE: 'legacy' });
    const result = await retrieve('eval', { embeddingBindings: { contract_legal: LAW_PROFILE.id } });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('domain_embeddings_disabled');
  });

  it('voice runs no binding leg and reads no binding', async () => {
    effective = [lawBinding()];
    const requests = install();
    await retrieve('voice');
    expect(bindingReads).toEqual([]);
    expect(requests.every((req) => req.embeddingProfileId !== LAW_PROFILE.id)).toBe(true);
  });
});
