import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getV2StartupVerdict, resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { resetRagConfigForTests } from '@/lib/rag/config';

const DEFAULT_DEPS = {
  ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_HNSW_ITERATIVE_SCAN: 'relaxed_order' } as const),
  adminClient: () => ({ from: vi.fn() }) as unknown as SupabaseClient,
  icuSegmentsChinese: () => true,
  pgvectorVersion: async () => '0.8.7',
};

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
    const verdict = await verifyV2Startup({
      ragEnv: () => ({ RAG_PIPELINE: 'legacy' }),
      adminClient: () => null,
      icuSegmentsChinese: icu,
      pgvectorVersion: version,
    });
    expect(icu).not.toHaveBeenCalled();
    expect(version).not.toHaveBeenCalled();
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
    const text = (console.error as ReturnType<typeof vi.spyOn>).mock.calls.map((call) => call.join(' ')).join('\n');
    expect(text).not.toMatch(/eyJ|sk-/);
  });

  it('v2 with relaxed_order and pgvector 0.7.4 warns about 0.8.0 once', async () => {
    await verifyV2Startup({
      ...DEFAULT_DEPS,
      pgvectorVersion: async () => '0.7.4',
    });
    const warnText = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls.map((call) => call.join(' ')).join('\n');
    expect(warnText).toMatch(/0\.8\.0/);
    expect(warnText).toMatch(/iterative scan/i);
    const count = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls.length;
    await verifyV2Startup({ ...DEFAULT_DEPS, pgvectorVersion: async () => '0.7.4' });
    expect((console.warn as ReturnType<typeof vi.spyOn>).mock.calls.length).toBe(count);
  });
});