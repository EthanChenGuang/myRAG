import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import type { RetrievalOverrides } from '@/lib/rag-eval/contracts.generated';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';

function config(env: Record<string, string> = {}): RagConfig {
  return loadRagConfig({ RAG_PIPELINE: 'v2', ...env });
}

function evalOverrides(partial: Partial<RetrievalOverrides>): RetrievalOverrides {
  return {
    candidate_pool_size: null,
    final_top_k: null,
    rrf_k: null,
    rerank_input_cap: null,
    leg_weights: null,
    rerank_model: null,
    ...partial,
  };
}

function configWarnings(): string[] {
  const spy = console.warn as unknown as ReturnType<typeof vi.spyOn>;
  return spy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((text: string) => text.includes('[RAG Config]'));
}

describe('effectiveRetrievalParams cap bounds and clamp', () => {
  beforeEach(() => {
    resetRagConfigForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRagConfigForTests();
  });

  it('returns the committed parameters unchanged without an override', () => {
    const params = effectiveRetrievalParams('chat', config(), null);
    expect(params.candidate_pool_size).toBe(75);
    expect(params.rerank_input_cap).toBe(75);
    expect(configWarnings()).toEqual([]);
  });

  it.each([25, 50, 100])('takes an override cap of %i', (cap) => {
    const params = effectiveRetrievalParams(
      'eval',
      config(),
      evalOverrides({ candidate_pool_size: 100, rerank_input_cap: cap }),
    );
    expect(params.rerank_input_cap).toBe(cap);
  });

  it.each([24, 101])('keeps the previous cap for %i and warns once naming 25..100', (cap) => {
    const overrides = evalOverrides({ rerank_input_cap: cap });
    expect(effectiveRetrievalParams('eval', config(), overrides).rerank_input_cap).toBe(75);
    effectiveRetrievalParams('eval', config(), overrides);
    const warns = configWarnings().filter((text) => text.includes('rerank_input_cap'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('25..100');
  });

  it('clamps the cap to a lowered pool from the environment override and warns once', () => {
    const cfg = config({ RAG_RETRIEVAL_PARAMS_OVERRIDE: 'pool=25' });
    const first = effectiveRetrievalParams('chat', cfg, null);
    expect(first.candidate_pool_size).toBe(25);
    expect(first.rerank_input_cap).toBe(25);
    const second = effectiveRetrievalParams('chat', cfg, null);
    expect(second.rerank_input_cap).toBe(25);
    const clampWarns = configWarnings().filter((text) => text.includes('candidate_pool_size'));
    expect(clampWarns).toHaveLength(1);
  });

  it('keeps a cap below the pool without a warning', () => {
    const cfg = config({ RAG_RETRIEVAL_PARAMS_OVERRIDE: 'pool=50,cap=25' });
    const params = effectiveRetrievalParams('chat', cfg, null);
    expect(params.candidate_pool_size).toBe(50);
    expect(params.rerank_input_cap).toBe(25);
    expect(configWarnings()).toEqual([]);
  });

  it('applies the same clamp to eval-profile overrides', () => {
    const overrides = evalOverrides({ candidate_pool_size: 30 });
    const params = effectiveRetrievalParams('eval', config(), overrides);
    expect(params.candidate_pool_size).toBe(30);
    expect(params.rerank_input_cap).toBe(30);
    effectiveRetrievalParams('eval', config(), overrides);
    expect(configWarnings().filter((text) => text.includes('candidate_pool_size'))).toHaveLength(1);
  });

  it('does not apply eval overrides outside the eval profile', () => {
    const overrides = evalOverrides({ candidate_pool_size: 40 });
    const params = effectiveRetrievalParams('chat', config(), overrides);
    expect(params.candidate_pool_size).toBe(75);
    expect(params.rerank_input_cap).toBe(75);
  });
});
