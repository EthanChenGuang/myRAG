import { afterEach, describe, expect, test, vi } from 'vitest';
import rawCalibration from '../../../eval/config/scope-gate.json';
import { ScopeGateCalibrationSchema } from '@/lib/rag-eval/contracts.generated';
import type { CentroidSnapshot } from '@/lib/rag/scope/centroids';
import { scoreScope, type ScopeCell } from '@/lib/rag/scope/score';
import { maxDot, maxDotJs } from '@/lib/rag/scope/max-dot';
import {
  parseScopeGateCalibration,
  resetScopeGateCalibrationForTests,
  scopeGateCalibrationFor,
  setScopeGateCalibrationForTests,
} from '@/lib/rag/scope/calibration';

const DIMS = 8;
const CELL: ScopeCell = { threshold: 0.4, margin: 0.05 };

function unit(values: number[], dims = DIMS): Float32Array {
  const out = new Float32Array(dims);
  values.forEach((value, index) => {
    out[index] = value;
  });
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i += 1) out[i] = out[i]! / norm;
  return out;
}

/** A unit vector whose cosine with the first axis is exactly `cos`. */
function atCosine(cos: number, dims = DIMS): Float32Array {
  return unit([cos, Math.sqrt(1 - cos * cos)], dims);
}

function snapshot(partial: Partial<CentroidSnapshot> = {}): CentroidSnapshot {
  return {
    tenantKey: 's:default',
    profileId: 'legacy-1536',
    dims: DIMS,
    centroids: [{ kind: 'tenant', key: 'all', memberCount: 3, vector: unit([1]) }],
    examples: [],
    unsupported: false,
    loadedAt: 0,
    ...partial,
  };
}

function randomUnit(dims: number): Float32Array {
  const out = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i += 1) {
    out[i] = Math.random() - 0.5;
    norm += out[i]! * out[i]!;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i += 1) out[i] = out[i]! / norm;
  return out;
}

afterEach(() => {
  resetScopeGateCalibrationForTests();
  vi.restoreAllMocks();
});

describe('scoreScope labels (D-26, D-38, P-04)', () => {
  test('the score is the maximum over query vectors and centroids', () => {
    const result = scoreScope({
      queryVectors: [atCosine(0.2), atCosine(0.45)],
      snapshot: snapshot({ centroids: [{ kind: 'doc_type', key: 'a', memberCount: 1, vector: unit([1]) }, { kind: 'doc_type', key: 'b', memberCount: 1, vector: unit([0, 0, 1]) }] }),
      cell: null,
    });
    expect(result.score).toBeCloseTo(0.45, 5);
    expect(result.centroid_count).toBe(2);
  });

  test('below threshold minus margin is out_of_scope, within the margin unsure, at the threshold in_scope', () => {
    expect(scoreScope({ queryVectors: [atCosine(0.3)], snapshot: snapshot(), cell: CELL })).toMatchObject({ label: 'out_of_scope', reason: 'below_threshold' });
    expect(scoreScope({ queryVectors: [atCosine(0.38)], snapshot: snapshot(), cell: CELL })).toMatchObject({ label: 'unsure', reason: 'within_margin' });
    expect(scoreScope({ queryVectors: [atCosine(0.45)], snapshot: snapshot(), cell: CELL })).toMatchObject({ label: 'in_scope', reason: 'above_threshold' });
  });

  test('a negative example closer than every centroid is out_of_scope even inside the margin', () => {
    const result = scoreScope({ queryVectors: [atCosine(0.38)], snapshot: snapshot({ examples: [atCosine(0.3)] }), cell: CELL });
    expect(result.negative_score).not.toBeNull();
    expect(result.negative_score!).toBeGreaterThan(result.score!);
    expect(result).toMatchObject({ label: 'out_of_scope', reason: 'negative_closer' });
  });

  test('any non-HyDE variant reaching the threshold keeps the query in scope', () => {
    const result = scoreScope({ queryVectors: [atCosine(0.1), atCosine(0.5)], snapshot: snapshot(), cell: CELL });
    expect(result.label).toBe('in_scope');
  });

  test('no snapshot, empty centroids, a dims mismatch or no query vector are unsure', () => {
    expect(scoreScope({ queryVectors: [atCosine(0.1)], snapshot: null, cell: CELL })).toMatchObject({ label: 'unsure', reason: 'no_snapshot', score: null });
    expect(scoreScope({ queryVectors: [atCosine(0.1)], snapshot: snapshot({ centroids: [], dims: 0 }), cell: CELL })).toMatchObject({
      label: 'unsure',
      reason: 'no_centroids',
      score: null,
    });
    expect(scoreScope({ queryVectors: [unit([1], 4)], snapshot: snapshot(), cell: CELL })).toMatchObject({ label: 'unsure', reason: 'no_query_vector' });
    expect(scoreScope({ queryVectors: [], snapshot: snapshot(), cell: CELL })).toMatchObject({ label: 'unsure', reason: 'no_query_vector' });
  });

  test('no calibration cell is unsure with the score still reported', () => {
    const result = scoreScope({ queryVectors: [atCosine(0.1)], snapshot: snapshot(), cell: null });
    expect(result).toMatchObject({ label: 'unsure', reason: 'uncalibrated' });
    expect(result.score).toBeCloseTo(0.1, 5);
  });

  test('a skipped translate the gate asked for, or a scoped binding, is unsure with the score reported', () => {
    const skipped = scoreScope({ queryVectors: [atCosine(0.1)], snapshot: snapshot(), cell: CELL, flags: { translateSkipped: true } });
    expect(skipped).toMatchObject({ label: 'unsure', reason: 'translate_skipped' });
    expect(skipped.score).toBeCloseTo(0.1, 5);
    const bound = scoreScope({ queryVectors: [atCosine(0.1)], snapshot: snapshot({ unsupported: true }), cell: CELL });
    expect(bound).toMatchObject({ label: 'unsure', reason: 'scoped_binding' });
    expect(bound.score).toBeCloseTo(0.1, 5);
  });

  test('query vectors that are not unit length are normalized first', () => {
    const scaled = Float32Array.from(atCosine(0.45), (value) => value * 7);
    expect(scoreScope({ queryVectors: [scaled], snapshot: snapshot(), cell: CELL }).score).toBeCloseTo(0.45, 5);
    expect(scoreScope({ queryVectors: [[...atCosine(0.45)]], snapshot: snapshot(), cell: CELL }).score).toBeCloseTo(0.45, 5);
  });

  test('the result validates against the generated contract once a latency is added', async () => {
    const { ScopeGateResultSchema } = await import('@/lib/rag-eval/contracts.generated');
    const result = scoreScope({ queryVectors: [atCosine(0.3)], snapshot: snapshot(), cell: CELL });
    expect(ScopeGateResultSchema.safeParse({ ...result, latency_ms: 0.1 }).success).toBe(true);
  });
});

describe('maxDot kernel', () => {
  test('the SIMD kernel and the JavaScript kernel agree, also for dims that are not a multiple of four', () => {
    for (const dims of [4, 7, 1536]) {
      const queries = [randomUnit(dims), randomUnit(dims)];
      const refs = Array.from({ length: 13 }, () => randomUnit(dims));
      const expected = maxDotJs(queries, refs);
      expect(maxDot(queries, refs)).toBeCloseTo(expected, 4);
    }
  });

  test('no reference vector gives -Infinity', () => {
    expect(maxDot([randomUnit(4)], [])).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('scope gate benchmark (D-26)', () => {
  test('8 query vectors against 300 reference vectors at 2048 dimensions: p99 under 5 ms', () => {
    const dims = 2048;
    const centroids = Array.from({ length: 200 }, (_, index) => ({ kind: 'doc_type' as const, key: `k${index}`, memberCount: 1, vector: randomUnit(dims) }));
    const examples = Array.from({ length: 100 }, () => randomUnit(dims));
    const snap = snapshot({ dims, centroids, examples });
    const queries = Array.from({ length: 8 }, () => randomUnit(dims));
    // An unreachable threshold: no early exit, every query is scored against every vector.
    const cell: ScopeCell = { threshold: 2, margin: 0 };
    for (let i = 0; i < 30; i += 1) scoreScope({ queryVectors: queries, snapshot: snap, cell });
    const times: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      const started = performance.now();
      scoreScope({ queryVectors: queries, snapshot: snap, cell });
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const p99 = times[Math.ceil(times.length * 0.99) - 1]!;
    expect(p99).toBeLessThan(5);
  });
});

describe('scope gate calibration (D-27, P-36)', () => {
  test('the committed empty calibration validates and has no cells', () => {
    expect(ScopeGateCalibrationSchema.safeParse(rawCalibration).success).toBe(true);
    expect(parseScopeGateCalibration(rawCalibration)?.cells).toEqual([]);
  });

  test('scopeGateCalibrationFor returns null for every profile and mode with the committed file', () => {
    for (const profile of ['legacy-1536', 'bge-m3-1024', 'ft-a-1024']) {
      for (const mode of ['strict', 'balanced', 'flexible', 'bypass'] as const) expect(scopeGateCalibrationFor(profile, mode)).toBeNull();
    }
  });

  test('a calibrated cell is found by profile and mode; an uncalibrated one is not', () => {
    setScopeGateCalibrationForTests({
      schema_version: 1,
      recorded_at: '2026-11-27T00:00:00Z',
      source: 'fixture',
      cells: [
        { embedding_profile_id: 'legacy-1536', rag_mode: 'strict', threshold: 0.4, margin: 0.05, false_refusal_rate: 0, false_refusal_n: 10, correct_refusal_rate: 0.5, correct_refusal_n: 4, status: 'calibrated' },
        { embedding_profile_id: 'legacy-1536', rag_mode: 'balanced', threshold: null, margin: null, false_refusal_rate: null, false_refusal_n: 0, correct_refusal_rate: null, correct_refusal_n: 0, status: 'uncalibrated' },
      ],
    });
    expect(scopeGateCalibrationFor('legacy-1536', 'strict')).toEqual({ threshold: 0.4, margin: 0.05 });
    expect(scopeGateCalibrationFor('legacy-1536', 'balanced')).toBeNull();
    expect(scopeGateCalibrationFor('bge-m3-1024', 'strict')).toBeNull();
  });

  test('an invalid file logs once and returns null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setScopeGateCalibrationForTests({ schema_version: 2, cells: 'no' });
    expect(scopeGateCalibrationFor('legacy-1536', 'strict')).toBeNull();
    expect(scopeGateCalibrationFor('legacy-1536', 'balanced')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('[Scope Gate]');
  });

  test('a file repeating a profile and mode pair is invalid', () => {
    const cell = { embedding_profile_id: 'legacy-1536', rag_mode: 'strict', threshold: 0.4, margin: 0.05, false_refusal_rate: 0, false_refusal_n: 1, correct_refusal_rate: 0, correct_refusal_n: 1, status: 'calibrated' };
    expect(parseScopeGateCalibration({ schema_version: 1, recorded_at: '2026-11-27T00:00:00Z', source: 'fixture', cells: [cell, cell] })).toBeNull();
  });
});
