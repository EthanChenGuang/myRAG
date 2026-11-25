import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import type { QueryEmbedding } from '@/lib/rag/embeddings/query-embedding';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import type { QueryVariant } from '@/lib/rag/types';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { createRetrievalPort, type RetrievalPortContext } from '@/lib/rag/v2/port';
import { hit } from '../fusion/helpers';

const TENANT_A = mintScope('personal', '00000000-0000-4000-8000-00000000000a', null);
const TENANT_B = mintScope('personal', '00000000-0000-4000-8000-00000000000b', null);

const VARIANTS: QueryVariant[] = [
  { text: 'Synthetic original question about the sample widget', language: 'en', kind: 'original' },
  { text: 'Synthetic condensed question about the sample widget', language: 'en', kind: 'condensed', legs: 'both' },
  {
    text: 'A synthetic passage describing the sample widget.',
    language: 'en',
    kind: 'hyde',
    legs: 'dense',
    denseText: 'A synthetic passage describing the sample widget, dense form.',
  },
];

function params() {
  resetRagConfigForTests();
  const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' });
  return effectiveRetrievalParams('eval', config, null);
}

function vectorFor(index: number): number[] {
  return Array.from({ length: 4 }, (_unused, position) => (position === index ? 1 : 0));
}

function variantIndexOf(req: BackendSearchRequest): number {
  return req.denseVector?.indexOf(1) ?? -1;
}

interface Recorder {
  calls: BackendSearchRequest[];
  scopes: string[];
  events: string[];
}

function recorder(): Recorder {
  return { calls: [], scopes: [], events: [] };
}

function fakeBackend(rec: Recorder, prefix = ''): RetrievalBackend {
  return {
    id: 'pgvector',
    async search(req) {
      rec.calls.push(req);
      rec.scopes.push(scopeKey(req.scope));
      rec.events.push('search');
      await new Promise((resolve) => setTimeout(resolve, 1));
      const index = variantIndexOf(req);
      return {
        dense: [hit(`${prefix}d${index}-a`, { rank: 1 }), hit(`${prefix}shared`, { rank: 2 })],
        lexical: req.lexicalTokens.length > 0 ? [hit(`${prefix}shared`, { rank: 1 }), hit(`${prefix}l${index}-a`, { rank: 2 })] : [],
      } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

function fakeEmbedder(rec: Recorder) {
  return vi.fn(async (texts: string[]): Promise<QueryEmbedding[]> => {
    rec.events.push(`embed:${texts.length}`);
    return texts.map((_text, index) => ({ vector: vectorFor(index), profile: null }));
  });
}

function makePort(rec: Recorder, overrides: Partial<RetrievalPortContext> = {}) {
  const embed = fakeEmbedder(rec);
  const handle = createRetrievalPort({
    scope: TENANT_A,
    backend: fakeBackend(rec),
    variants: VARIANTS,
    filters: { currentOnly: true },
    params: params(),
    signal: new AbortController().signal,
    embed,
    lexicalEnabled: true,
    ...overrides,
  });
  return { handle, embed };
}

describe('createRetrievalPort (D-18, A-4)', () => {
  beforeEach(() => resetRagConfigForTests());
  afterEach(() => {
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('exposes the variant texts, kinds and legs in order', () => {
    const { handle } = makePort(recorder());
    expect(handle.port.variants).toEqual([
      { index: 0, text: VARIANTS[0]!.text, kind: 'original', legs: 'both' },
      { index: 1, text: VARIANTS[1]!.text, kind: 'condensed', legs: 'both' },
      { index: 2, text: VARIANTS[2]!.text, kind: 'hyde', legs: 'dense' },
    ]);
  });

  it('makes one backend call for a variant that the dense and lexical retrievers both ask for', async () => {
    const rec = recorder();
    const { handle } = makePort(rec);
    const [first, second] = await Promise.all([handle.port.searchVariant(0), handle.port.searchVariant(0)]);
    const third = await handle.port.searchVariant(0);
    expect(rec.calls).toHaveLength(1);
    expect(first).toEqual({ dense: ['d0-a', 'shared'], lexical: ['shared', 'l0-a'] });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('makes one call per variant, all under the request signal, and sends no lexical tokens for a dense-only variant', async () => {
    const rec = recorder();
    const controller = new AbortController();
    const { handle } = makePort(rec, { signal: controller.signal });
    const lists = await Promise.all([0, 1, 2, 0, 1, 2].map((index) => handle.port.searchVariant(index)));
    expect(rec.calls).toHaveLength(3);
    expect(rec.calls.every((call) => call.signal === controller.signal)).toBe(true);
    expect(lists[2]).toEqual({ dense: ['d2-a', 'shared'], lexical: [] });
    const hyde = rec.calls.find((call) => variantIndexOf(call) === 2)!;
    expect(hyde.lexicalTokens).toEqual([]);
  });

  it('embeds every variant dense text in one batch before the first search', async () => {
    const rec = recorder();
    const { handle, embed } = makePort(rec);
    await handle.port.searchVariant(1);
    await handle.port.searchVariant(0);
    await handle.port.searchVariant(2);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]?.[0]).toEqual([VARIANTS[0]!.text, VARIANTS[1]!.text, VARIANTS[2]!.denseText]);
    expect(rec.events[0]).toBe('embed:3');
    expect(rec.events.filter((event) => event === 'search')).toHaveLength(3);
  });

  it('exposes no scope, tenant key, filters or backend', () => {
    const rec = recorder();
    const { handle } = makePort(rec, { filters: { currentOnly: true, sources: ['synthetic-source'] } });
    const port = handle.port;
    expect(Object.keys(port).sort()).toEqual(['finishRetrieval', 'searchVariant', 'variants']);
    const json = JSON.stringify(port);
    expect(json).not.toContain(scopeKey(TENANT_A).slice(2));
    expect(json).not.toContain('synthetic-source');
    expect(json).not.toContain('pgvector');
    expect(json).not.toMatch(/scope|tenant|filter|backend|signal/i);
    for (const value of Object.values(port)) {
      expect(value).not.toBe(TENANT_A);
    }
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.isFrozen(port.variants)).toBe(true);
  });

  it('rejects with an abort error and makes no call after the request signal aborts', async () => {
    const rec = recorder();
    const controller = new AbortController();
    const { handle, embed } = makePort(rec, { signal: controller.signal });
    controller.abort();
    await expect(handle.port.searchVariant(0)).rejects.toMatchObject({ name: 'AbortError' });
    expect(rec.calls).toHaveLength(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it('rejects an abort after a variant was searched instead of returning the memo', async () => {
    const rec = recorder();
    const controller = new AbortController();
    const { handle } = makePort(rec, { signal: controller.signal });
    await handle.port.searchVariant(0);
    controller.abort();
    await expect(handle.port.searchVariant(0)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(handle.port.searchVariant(1)).rejects.toMatchObject({ name: 'AbortError' });
    expect(rec.calls).toHaveLength(1);
  });

  it('rejects an index that names no variant without calling the backend', async () => {
    const rec = recorder();
    const { handle } = makePort(rec);
    await expect(handle.port.searchVariant(3)).rejects.toThrow(RangeError);
    await expect(handle.port.searchVariant(-1)).rejects.toThrow(RangeError);
    await expect(handle.port.searchVariant(0.5)).rejects.toThrow(RangeError);
    expect(rec.calls).toHaveLength(0);
  });

  it('keeps two tenants apart: each port reaches the backend only with its own scope, interleaved calls included', async () => {
    const rec = recorder();
    const backend = fakeBackend(rec);
    const make = (scope: TenantScope) =>
      createRetrievalPort({
        scope,
        backend,
        variants: VARIANTS,
        filters: { currentOnly: true },
        params: params(),
        signal: new AbortController().signal,
        embed: fakeEmbedder(recorder()),
        lexicalEnabled: true,
      });
    const a = make(TENANT_A);
    const b = make(TENANT_B);
    const order: Array<['a' | 'b', number]> = [
      ['a', 0],
      ['b', 0],
      ['b', 1],
      ['a', 1],
      ['a', 2],
      ['b', 2],
    ];
    await Promise.all(order.map(([who, index]) => (who === 'a' ? a : b).port.searchVariant(index)));
    expect(rec.calls).toHaveLength(6);
    const keyA = scopeKey(TENANT_A);
    const keyB = scopeKey(TENANT_B);
    expect(rec.scopes.filter((key) => key === keyA)).toHaveLength(3);
    expect(rec.scopes.filter((key) => key === keyB)).toHaveLength(3);
    expect(rec.calls.filter((call) => call.scope === TENANT_A)).toHaveLength(3);
    expect(rec.calls.filter((call) => call.scope === TENANT_B)).toHaveLength(3);
    expect(rec.calls.every((call) => call.scope === TENANT_A || call.scope === TENANT_B)).toBe(true);
  });

  it('finishRetrieval maps a fused order back to the collected hits with their legs and drops unknown ids', async () => {
    const rec = recorder();
    const backend: RetrievalBackend = {
      ...fakeBackend(rec),
      async search(req) {
        rec.calls.push(req);
        return {
          dense: [hit('c1', { rank: 1 }), hit('c2', { rank: 2 })],
          lexical: [hit('c3', { rank: 1 }), hit('c1', { rank: 2 })],
        };
      },
    };
    const { handle } = makePort(rec, { backend });
    await handle.port.searchVariant(0);
    expect(handle.port.finishRetrieval(['c3', 'unknown', 'c1', 'c3'])).toEqual([
      { chunkId: 'c3', legs: { 'lexical:0': 1 } },
      { chunkId: 'c1', legs: { 'dense:0': 1, 'lexical:0': 2 } },
    ]);
    const fused = handle.fusedHits(['c3', 'c1']);
    expect(fused.map((row) => row.hit.chunkId)).toEqual(['c3', 'c1']);
    expect(fused[1]!.ranks).toEqual({ 'dense:0': 1, 'lexical:0': 2 });
  });
});
