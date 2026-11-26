import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { effectiveTuningParams, resetTuningParamsForTests } from '@/lib/rag/v2/tuning-params';

const DEFAULTS = {
  tableLookup: { min_cells: 2, limit: 10, weight: 1 },
  diversity: { mmr_lambda: 0.7, mmr_window_factor: 3 },
  dupClusterThreshold: 0.95,
};

function config(env: Record<string, string> = {}): RagConfig {
  return loadRagConfig({ RAG_PIPELINE: 'v2', ...env });
}

function warnLines(): string[] {
  return (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((call: unknown[]) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
    .filter((line: string) => line.includes('[RAG Config]') && line.includes('tuning'));
}

describe('effectiveTuningParams (04.2-06, D-16, D-48, D-49)', () => {
  beforeEach(() => {
    resetRagConfigForTests();
    resetTuningParamsForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTuningParamsForTests();
    resetRagConfigForTests();
  });

  it('returns the contract defaults for chat without overrides', () => {
    expect(effectiveTuningParams('chat', config(), undefined)).toEqual(DEFAULTS);
  });

  it('applies eval-only overrides for the eval profile', () => {
    const overrides = { table_lookup: { min_cells: 3 }, diversity: { mmr_lambda: 0.5 } };
    expect(effectiveTuningParams('eval', config(), overrides)).toEqual({
      tableLookup: { min_cells: 3, limit: 10, weight: 1 },
      diversity: { mmr_lambda: 0.5, mmr_window_factor: 3 },
      dupClusterThreshold: 0.95,
    });
  });

  it.each(['chat', 'embed', 'voice'] as const)('ignores eval overrides for profile %s', (profile) => {
    const overrides = { table_lookup: { min_cells: 3 }, diversity: { mmr_lambda: 0.5 }, dup_cluster: { threshold: 0.9 } };
    expect(effectiveTuningParams(profile, config(), overrides)).toEqual(DEFAULTS);
  });

  it('the shipped retrieval-params.json has no mmr_lambda, so every profile gets 0.7', () => {
    for (const profile of ['chat', 'embed', 'voice', 'eval'] as const) {
      expect(effectiveTuningParams(profile, config(), undefined).diversity.mmr_lambda).toBe(0.7);
    }
  });

  it('takes mmr_lambda from the committed retrieval parameters when the field is present', () => {
    const withLambda = effectiveTuningParams('chat', config(), undefined, { committedMmrLambda: 0.6 });
    expect(withLambda.diversity.mmr_lambda).toBe(0.6);
    for (const profile of ['embed', 'voice', 'eval'] as const) {
      expect(effectiveTuningParams(profile, config(), undefined, { committedMmrLambda: 0.6 }).diversity.mmr_lambda).toBe(0.6);
    }
    expect(effectiveTuningParams('chat', config(), undefined, { committedMmrLambda: undefined }).diversity.mmr_lambda).toBe(0.7);
  });

  it('an eval lambda override wins over the committed lambda', () => {
    const params = effectiveTuningParams('eval', config(), { diversity: { mmr_lambda: 0.5 } }, { committedMmrLambda: 0.6 });
    expect(params.diversity.mmr_lambda).toBe(0.5);
  });

  it('a fixture-fitted duplicate threshold applies in eval only; the deployment threshold override is eval-only too', () => {
    const overrides = { dup_cluster: { threshold: 0.9, by_profile: { 'profile-a': { threshold: 0.93, source: 'fixture' as const } } } };
    expect(effectiveTuningParams('eval', config(), overrides, { embeddingProfileId: 'profile-a' }).dupClusterThreshold).toBe(0.93);
    expect(effectiveTuningParams('eval', config(), overrides, { embeddingProfileId: 'profile-b' }).dupClusterThreshold).toBe(0.9);
    expect(effectiveTuningParams('chat', config(), overrides, { embeddingProfileId: 'profile-a' }).dupClusterThreshold).toBe(0.95);
  });

  it('ignores an invalid override value with one [RAG Config] warning and keeps the default', () => {
    const bad = { table_lookup: { min_cells: 0 }, diversity: { mmr_lambda: 2 } };
    const first = effectiveTuningParams('eval', config(), bad);
    effectiveTuningParams('eval', config(), bad);
    expect(first).toEqual(DEFAULTS);
    const lines = warnLines();
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes('table_lookup'))).toBe(true);
    expect(lines.some((line) => line.includes('diversity'))).toBe(true);
    expect(lines.join(' ')).not.toContain('"min_cells":0');
  });

  it('keeps a valid field of an override while another override is invalid', () => {
    const params = effectiveTuningParams('eval', config(), { table_lookup: { limit: 5 }, diversity: { mmr_window_factor: 0 } });
    expect(params.tableLookup).toEqual({ min_cells: 2, limit: 5, weight: 1 });
    expect(params.diversity).toEqual(DEFAULTS.diversity);
  });
});
