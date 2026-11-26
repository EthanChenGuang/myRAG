import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { resetRagConfigForTests } from '@/lib/rag/config';

const BASE_ENV = {
  RAG_PIPELINE: 'v2',
  RAG_DOC_ATTRIBUTES: 'true',
  RAG_ATTRIBUTE_FILTER: 'hard',
  RAG_EXACT_SCAN_CUTOFF: '0',
  RAG_HNSW_ITERATIVE_SCAN: 'off',
};

function deps(env: Record<string, string>) {
  return {
    ragEnv: () => env,
    adminClient: () => ({ from: vi.fn() }) as unknown as SupabaseClient,
    icuSegmentsChinese: () => true,
    pgvectorVersion: async () => '0.8.7',
    chunkingCoverage: async () => [],
  };
}

function attributeWarnings(): string[] {
  return (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((call: unknown[]) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
    .filter((line: string) => line.includes('[RAG Config]') && line.includes('RAG_ATTRIBUTE_FILTER=hard'));
}

describe('startup warning for a hard attribute filter on the approximate dense leg (03.3-19, D-30)', () => {
  beforeEach(() => {
    resetRagConfigForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetV2StartupForTests();
    resetRagConfigForTests();
  });

  it('hard, cutoff 0 and iterative scan off: one warning per process, no reason, same status', async () => {
    const plain = await verifyV2Startup(deps({ RAG_PIPELINE: 'v2', RAG_EXACT_SCAN_CUTOFF: '0', RAG_HNSW_ITERATIVE_SCAN: 'off' }));
    resetV2StartupForTests();
    const verdict = await verifyV2Startup(deps(BASE_ENV));
    await verifyV2Startup(deps(BASE_ENV));
    expect(attributeWarnings()).toHaveLength(1);
    expect(attributeWarnings()[0]).toContain('RAG_EXACT_SCAN_CUTOFF');
    expect(attributeWarnings()[0]).toContain('RAG_HNSW_ITERATIVE_SCAN');
    expect(verdict.reasons).toEqual(plain.reasons);
    expect(verdict.status).toBe(plain.status);
  });

  it.each([
    ['soft filter', { RAG_ATTRIBUTE_FILTER: 'soft' }],
    ['exact-scan cutoff above 0', { RAG_EXACT_SCAN_CUTOFF: '500' }],
    ['iterative scan on', { RAG_HNSW_ITERATIVE_SCAN: 'relaxed_order' }],
    ['filter off', { RAG_ATTRIBUTE_FILTER: 'off' }],
  ])('%s: no warning', async (_label, over) => {
    await verifyV2Startup(deps({ ...BASE_ENV, ...over }));
    expect(attributeWarnings()).toEqual([]);
  });

  it('the legacy pipeline runs no check', async () => {
    const verdict = await verifyV2Startup(deps({ ...BASE_ENV, RAG_PIPELINE: 'legacy' }));
    expect(verdict.status).toBe('not_checked');
    expect(attributeWarnings()).toEqual([]);
  });
});
