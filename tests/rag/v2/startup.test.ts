import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getV2StartupVerdict, resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { resetRagConfigForTests } from '@/lib/rag/config';

const DEFAULT_DEPS = {
  ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_HNSW_ITERATIVE_SCAN: 'relaxed_order' } as const),
  adminClient: () => ({ from: vi.fn() }) as unknown as SupabaseClient,
  icuSegmentsChinese: () => true,
  pgvectorVersion: async () => '0.8.7',
  chunkingCoverage: async () => [],
};

function coverage(docType: string, profileId: string, isActive: boolean, total: number, withChildren: number) {
  return { docType, profileId, isActive, currentReadyDocuments: total, documentsWithChildren: withChildren, missingDocuments: total - withChildren };
}

function chunkingWarnings(): string[] {
  return (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((call: unknown[]) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
    .filter((line: string) => line.includes('[RAG Chunking]'));
}

describe('verifyV2Startup', () => {
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

  it('RAG_PIPELINE=legacy runs no startup check', async () => {
    const icu = vi.fn(() => true);
    const version = vi.fn(async () => '0.8.7');
    const chunkingCoverage = vi.fn(async () => [coverage('contract_legal', 'p256-1024', true, 5, 2)]);
    const verdict = await verifyV2Startup({
      ragEnv: () => ({ RAG_PIPELINE: 'legacy' }),
      adminClient: () => null,
      icuSegmentsChinese: icu,
      pgvectorVersion: version,
      chunkingCoverage,
    });
    expect(icu).not.toHaveBeenCalled();
    expect(version).not.toHaveBeenCalled();
    expect(chunkingCoverage).not.toHaveBeenCalled();
    expect(chunkingWarnings()).toEqual([]);
    expect(verdict.status).toBe('not_checked');
    expect(getV2StartupVerdict()).toMatchObject({ status: 'not_checked' });
  });

  it('v2 with failing ICU logs once and sets icu_unavailable', async () => {
    const verdict = await verifyV2Startup({
      ...DEFAULT_DEPS,
      icuSegmentsChinese: () => false,
    });
    expect(verdict.reasons).toContain('icu_unavailable');
    const errorCalls = (console.error as ReturnType<typeof vi.spyOn>).mock.calls.length;
    await verifyV2Startup({ ...DEFAULT_DEPS, icuSegmentsChinese: () => false });
    expect((console.error as ReturnType<typeof vi.spyOn>).mock.calls.length).toBe(errorCalls);
  });

  it('v2 without service role key reports admin_key_missing without logging secrets', async () => {
    const verdict = await verifyV2Startup({
      ...DEFAULT_DEPS,
      adminClient: () => null,
    });
    expect(verdict.reasons).toContain('admin_key_missing');
    const text = (console.error as ReturnType<typeof vi.spyOn>).mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
    expect(text).not.toMatch(/eyJ|sk-/);
  });

  it('v2 with relaxed_order and pgvector 0.7.4 warns about 0.8.0 once', async () => {
    await verifyV2Startup({
      ...DEFAULT_DEPS,
      pgvectorVersion: async () => '0.7.4',
    });
    const warnText = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
    expect(warnText).toMatch(/0\.8\.0/);
    expect(warnText).toMatch(/iterative scan/i);
    const count = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls.length;
    await verifyV2Startup({ ...DEFAULT_DEPS, pgvectorVersion: async () => '0.7.4' });
    expect((console.warn as ReturnType<typeof vi.spyOn>).mock.calls.length).toBe(count);
  });

  it('v2 startup warns about documents missing from the active chunking profile', async () => {
    const DOC_ID = '11111111-2222-4333-8444-555555555555';
    const chunkingCoverage = vi.fn<(signal: AbortSignal) => Promise<ReturnType<typeof coverage>[]>>(async () => [
      coverage('contract_legal', 'legacy', false, 5, 5),
      coverage('contract_legal', 'p256-1024', true, 5, 2),
      coverage('general', 'legacy', true, 10, 4),
      coverage('general', 'p128-512', false, 10, 0),
    ]);
    const verdict = await verifyV2Startup({ ...DEFAULT_DEPS, chunkingCoverage });
    const lines = chunkingWarnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('contract_legal');
    expect(lines[0]).toContain('p256-1024');
    expect(lines[0]).toMatch(/\b3\b/);
    expect(lines[0]).toContain('npm run rag:rechunk -- --profile p256-1024');
    expect(lines[0]).not.toContain(DOC_ID);
    expect(verdict.chunkingCoverage).toEqual({ state: 'checked', missing: { contract_legal: 3 } });
    expect(verdict.status).toBe('ok');
    expect(chunkingCoverage).toHaveBeenCalledTimes(1);
    expect(chunkingCoverage.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    await verifyV2Startup({ ...DEFAULT_DEPS, chunkingCoverage });
    expect(chunkingWarnings()).toHaveLength(1);
    expect(chunkingCoverage).toHaveBeenCalledTimes(1);
  });

  it('v2 startup logs nothing about chunking when the active profile misses no document', async () => {
    const verdict = await verifyV2Startup({
      ...DEFAULT_DEPS,
      chunkingCoverage: async () => [coverage('contract_legal', 'p256-1024', true, 5, 5)],
    });
    expect(chunkingWarnings()).toEqual([]);
    expect(verdict.chunkingCoverage).toEqual({ state: 'checked', missing: {} });
  });

  it('v2 startup records coverage_unchecked on a coverage RPC error without throwing or degrading', async () => {
    const verdict = await verifyV2Startup({
      ...DEFAULT_DEPS,
      chunkingCoverage: async () => {
        throw Object.assign(new Error('connection reset: secret text'), { code: 'XX000' });
      },
    });
    expect(verdict.chunkingCoverage).toEqual({ state: 'coverage_unchecked', missing: {} });
    expect(verdict.status).toBe('ok');
    const logged = [...chunkingWarnings(), ...(console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call.join(' '))].join('\n');
    expect(logged).not.toContain('secret text');
  });

  it('v2 startup records coverage_unchecked when the coverage read outlasts its bound', async () => {
    let seen: AbortSignal | null = null;
    const verdict = await verifyV2Startup({
      ...DEFAULT_DEPS,
      chunkingCoverageTimeoutMs: 20,
      chunkingCoverage: (signal) => {
        seen = signal;
        return new Promise(() => undefined);
      },
    });
    expect(verdict.chunkingCoverage).toEqual({ state: 'coverage_unchecked', missing: {} });
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
  });

  it('v2 startup without the service role key does not read the coverage', async () => {
    const chunkingCoverage = vi.fn(async () => []);
    const verdict = await verifyV2Startup({ ...DEFAULT_DEPS, adminClient: () => null, chunkingCoverage });
    expect(chunkingCoverage).not.toHaveBeenCalled();
    expect(verdict.chunkingCoverage).toEqual({ state: 'coverage_unchecked', missing: {} });
  });
});
