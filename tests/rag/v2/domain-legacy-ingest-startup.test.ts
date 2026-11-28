import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { resetRagConfigForTests } from '@/lib/rag/config';

// quick-311 (I-1): legacy ingest writes no binding vectors; with domain bindings on that used to go unreported.
const DOMAIN_ENV = { RAG_PIPELINE: 'v2', RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: 'on' };

function deps(env: Record<string, string>, ingestPipeline: string | undefined, missing: () => Promise<number | null> = async () => 7) {
  const bindingVectorsMissing = vi.fn(missing);
  return {
    bindingVectorsMissing,
    deps: {
      ragEnv: () => env,
      adminClient: () => ({ from: vi.fn() }) as unknown as SupabaseClient,
      icuSegmentsChinese: () => true,
      pgvectorVersion: async () => '0.8.7',
      chunkingCoverage: async () => [],
      ingestPipeline: () => ingestPipeline,
      bindingVectorsMissing,
    },
  };
}

function legacyIngestWarnings(): string[] {
  return (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((call: unknown[]) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
    .filter((line: string) => line.includes('[RAG Config]') && line.includes('RAG_INGEST_PIPELINE=legacy'));
}

describe('startup warning for domain bindings with the legacy ingest pipeline (quick-311, I-1)', () => {
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

  it('domain bindings on, ingest unset (legacy): one [RAG Config] warning with the count of chunks missing binding vectors', async () => {
    const { deps: d, bindingVectorsMissing } = deps(DOMAIN_ENV, undefined);
    const verdict = await verifyV2Startup(d);
    await verifyV2Startup(d);
    const lines = legacyIngestWarnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('RAG_DOMAIN_EMBEDDINGS=on');
    expect(lines[0]).toContain('chunks missing binding vectors: 7');
    expect(lines[0]).toContain('npm run rag:reembed -- --profile');
    expect(bindingVectorsMissing).toHaveBeenCalledTimes(1);
    expect(verdict.status).toBe('ok');
    expect(verdict.reasons).toEqual([]);
  });

  it('explicit legacy and an unreadable count: the warning says unknown and startup is unchanged', async () => {
    const { deps: d } = deps(DOMAIN_ENV, ' Legacy ', async () => {
      throw new Error('read failed');
    });
    const verdict = await verifyV2Startup(d);
    const lines = legacyIngestWarnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('chunks missing binding vectors: unknown');
    expect(verdict.status).toBe('ok');
  });

  it('no warning and no count read with the unified pipeline, with domain bindings off, or under legacy retrieval', async () => {
    for (const [env, ingest] of [
      [DOMAIN_ENV, 'unified'],
      [{ RAG_PIPELINE: 'v2', RAG_EMBEDDING_PROFILES: 'on' }, undefined],
      [{ RAG_PIPELINE: 'v2', RAG_DOMAIN_EMBEDDINGS: 'on' }, undefined],
      [{ ...DOMAIN_ENV, RAG_PIPELINE: 'legacy' }, undefined],
    ] as const) {
      resetV2StartupForTests();
      resetRagConfigForTests();
      const { deps: d, bindingVectorsMissing } = deps({ ...env }, ingest);
      await verifyV2Startup(d);
      expect(bindingVectorsMissing).not.toHaveBeenCalled();
    }
    expect(legacyIngestWarnings()).toEqual([]);
  });
});
