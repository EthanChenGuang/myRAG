import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { clusterPublishedDocument } from '@/lib/rag/dedupe/cluster';
import { LEGACY_PROFILE } from '@/lib/rag/embeddings/active-profile';
import { mintScope } from '@/lib/rag/tenant/scope';
import {
  dupClusterParamsHaveProfileEntries,
  dupClusterThreshold,
  effectiveTuningParams,
  resetDupClusterParamsForTests,
  resetTuningParamsForTests,
  setDupClusterParamsForTests,
} from '@/lib/rag/v2/tuning-params';

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

describe('dupClusterThreshold (04.2-16, D-49)', () => {
  const dirs: string[] = [];

  function paramsFile(body: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-params-'));
    dirs.push(dir);
    const file = path.join(dir, 'dup-cluster-params.json');
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  }

  function withEntry(source: 'fixture' | 'live') {
    return { threshold: 0.95, by_profile: { p1: { threshold: 0.9, source } }, provenance: { source: 'calibration' }, config_hash: null };
  }

  beforeEach(() => {
    resetDupClusterParamsForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDupClusterParamsForTests();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is 0.95 when the file does not exist', () => {
    setDupClusterParamsForTests(path.join(os.tmpdir(), 'no-such-dir-04.2-16', 'dup-cluster-params.json'));
    expect(dupClusterThreshold('p1', {})).toBe(0.95);
    expect(dupClusterThreshold('p1', { evalRun: true })).toBe(0.95);
    expect(dupClusterParamsHaveProfileEntries()).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('applies a fixture entry only to an eval run of that profile', () => {
    setDupClusterParamsForTests(paramsFile(withEntry('fixture')));
    expect(dupClusterParamsHaveProfileEntries()).toBe(true);
    expect({ profile: 'p1', source: 'fixture', evalRun: true, threshold: dupClusterThreshold('p1', { evalRun: true }) }).toEqual({
      profile: 'p1', source: 'fixture', evalRun: true, threshold: 0.9,
    });
    expect({ profile: 'p1', source: 'fixture', evalRun: false, threshold: dupClusterThreshold('p1', { evalRun: false }) }).toEqual({
      profile: 'p1', source: 'fixture', evalRun: false, threshold: 0.95,
    });
    expect(dupClusterThreshold('p1', {})).toBe(0.95);
    expect(dupClusterThreshold('p2', { evalRun: true })).toBe(0.95);
    expect(dupClusterThreshold(null, { evalRun: true })).toBe(0.95);
  });

  it('applies a live entry everywhere', () => {
    setDupClusterParamsForTests(paramsFile(withEntry('live')));
    expect(dupClusterThreshold('p1', { evalRun: true })).toBe(0.9);
    expect(dupClusterThreshold('p1', { evalRun: false })).toBe(0.9);
    expect(dupClusterThreshold('p2', { evalRun: false })).toBe(0.95);
  });

  it('uses the top-level threshold of the file for other profiles', () => {
    setDupClusterParamsForTests(paramsFile({ ...withEntry('live'), threshold: 0.97 }));
    expect(dupClusterThreshold('p2', {})).toBe(0.97);
  });

  it.each([['not json', '{'], ['schema failure', { threshold: 2 }], ['unknown key', { threshold: 0.95, extra: true }]])(
    'an invalid file (%s) gives 0.95 and one warning per process',
    (_label, body) => {
      setDupClusterParamsForTests(paramsFile(body));
      expect(dupClusterThreshold('p1', { evalRun: true })).toBe(0.95);
      expect(dupClusterThreshold('p1', {})).toBe(0.95);
      const lines = (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('[RAG Config]'),
      );
      expect(lines).toHaveLength(1);
    },
  );
});

describe('clustering threshold on the publish path (04.2-16, T-04.2-59)', () => {
  const dirs: string[] = [];
  const DOC = '00000000-0000-4000-8000-0000000000d1';
  const CHUNK = '00000000-0000-4000-8000-0000000000c1';

  function fakeDb(thresholds: number[]): RpcClient {
    return {
      rpc(fn: string, args: Record<string, unknown>) {
        let data: unknown[] = [];
        if (fn === 'rag_dup_backfill_candidates') data = args.p_after ? [] : [{ id: CHUNK, document_id: DOC, content: 'alpha beta gamma delta' }];
        if (fn === 'rag_dup_write_hashes') data = [{ written: 1 }];
        if (fn === 'rag_dup_candidates') thresholds.push(Number(args.p_threshold));
        if (fn === 'rag_dup_clusters_recompute') data = [{ recomputed: 0, dissolved: 0 }];
        const response: RpcResponse = { data, error: null };
        const request: RpcRequest = { abortSignal: () => request, then: (ok, fail) => Promise.resolve(response).then(ok, fail) };
        return request;
      },
    };
  }

  beforeEach(() => {
    resetDupClusterParamsForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-params-'));
    dirs.push(dir);
    const file = path.join(dir, 'dup-cluster-params.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ threshold: 0.95, by_profile: { [LEGACY_PROFILE.id]: { threshold: 0.9, source: 'fixture' } }, provenance: { source: 'calibration' } }),
    );
    setDupClusterParamsForTests(file);
  });

  afterEach(() => {
    resetDupClusterParamsForTests();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a production publish keeps the 0.95 cut with a fixture entry for the active profile', async () => {
    const seen: number[] = [];
    await clusterPublishedDocument(mintScope('single', null, null), DOC, { db: fakeDb(seen) });
    expect(seen).toEqual([0.95]);
  });

  it('only the harness option evalRun applies the fixture entry', async () => {
    const seen: number[] = [];
    await clusterPublishedDocument(mintScope('single', null, null), DOC, { db: fakeDb(seen), evalRun: true });
    expect(seen).toEqual([0.9]);
    const named: number[] = [];
    await clusterPublishedDocument(mintScope('single', null, null), DOC, { db: fakeDb(named), evalRun: true, embeddingProfileId: 'other-profile' });
    expect(named).toEqual([0.95]);
  });

  it('an explicit threshold option still wins', async () => {
    const seen: number[] = [];
    await clusterPublishedDocument(mintScope('single', null, null), DOC, { db: fakeDb(seen), evalRun: true, threshold: 0.99 });
    expect(seen).toEqual([0.99]);
  });
});
