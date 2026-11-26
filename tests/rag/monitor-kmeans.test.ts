import { describe, expect, test } from 'vitest';
import * as backfillSample from '@/lib/rag/ingest/backfill/sample';
import {
  assignNearest,
  carryClusterIds,
  chooseK,
  distanceThreshold,
  kmeansPlusPlus,
  mergeSmallClusters,
  normalize,
  sphericalKMeans,
  type KMeansResult,
} from '@/lib/rag/monitor/kmeans';

const DIM = 16;

function rng(seed: string): () => number {
  return backfillSample.seededRandom(seed, 'test');
}

function basis(index: number, dim = DIM): Float32Array {
  const out = new Float32Array(dim);
  out[index] = 1;
  return out;
}

/** Unit vectors around `count` orthogonal directions with small seeded noise. */
function groups(sizes: number[], seed: string, noise = 0.05): { vectors: Float32Array[]; labels: number[] } {
  const random = rng(seed);
  const vectors: Float32Array[] = [];
  const labels: number[] = [];
  sizes.forEach((size, group) => {
    for (let i = 0; i < size; i += 1) {
      const v = basis(group);
      for (let d = 0; d < DIM; d += 1) v[d] = (v[d] ?? 0) + (random() - 0.5) * noise;
      vectors.push(normalize(v));
      labels.push(group);
    }
  });
  return { vectors, labels };
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/** The partition as a set of sorted member lists, independent of cluster numbering. */
function partition(assignments: ArrayLike<number>): string[] {
  const byCluster = new Map<number, number[]>();
  for (let i = 0; i < assignments.length; i += 1) {
    const c = assignments[i] as number;
    byCluster.set(c, [...(byCluster.get(c) ?? []), i]);
  }
  return [...byCluster.values()].map((members) => members.join(',')).sort();
}

describe('seededRandom export (O-3 item 4)', () => {
  test('the backfill sampler exports its seeded generator by name', () => {
    expect(typeof (backfillSample as Record<string, unknown>).seededRandom).toBe('function');
    const a = backfillSample.seededRandom('seed', 'salt');
    const b = backfillSample.seededRandom('seed', 'salt');
    const drawsA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(drawsA);
    for (const x of drawsA) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('chooseK', () => {
  test('k = clamp(round(sqrt(n / 2)), 4, 40)', () => {
    expect(chooseK(30)).toBe(4);
    expect(chooseK(200)).toBe(10);
    expect(chooseK(800)).toBe(20);
    expect(chooseK(5000)).toBe(40);
  });

  test('k never exceeds n', () => {
    expect(chooseK(3)).toBe(3);
    expect(chooseK(0)).toBe(0);
  });
});

describe('normalize', () => {
  test('returns a unit vector and leaves a zero vector at zero', () => {
    const v = normalize(Float32Array.from([3, 4]));
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
    expect(Array.from(normalize(new Float32Array(3)))).toEqual([0, 0, 0]);
  });
});

describe('kmeansPlusPlus', () => {
  test('picks k distinct seeds, one per well-separated group', () => {
    const { vectors, labels } = groups([20, 20, 20, 20], 'pp');
    const seeds = kmeansPlusPlus(vectors, 4, rng('pp-seed'));
    expect(seeds).toHaveLength(4);
    expect(new Set(seeds).size).toBe(4);
    expect(new Set(seeds.map((i) => labels[i])).size).toBe(4);
  });
});

describe('sphericalKMeans', () => {
  test('recovers four well-separated groups exactly', () => {
    const { vectors, labels } = groups([25, 30, 20, 25], 'four');
    const result = sphericalKMeans(vectors, { k: 4, seed: 'fit-1', maxIterations: 50 });
    expect(result.centroids).toHaveLength(4);
    expect(partition(result.assignments)).toEqual(partition(labels));
    expect(result.iterations).toBeLessThanOrEqual(50);
    for (const centroid of result.centroids) expect(Math.sqrt(dot(centroid, centroid))).toBeCloseTo(1, 5);
  });

  test('the same input and seed give identical centroids and assignments', () => {
    const { vectors } = groups([40, 40, 40], 'repro', 0.6);
    const a = sphericalKMeans(vectors, { k: 6, seed: 'same', maxIterations: 50 });
    const b = sphericalKMeans(vectors, { k: 6, seed: 'same', maxIterations: 50 });
    expect(Array.from(b.assignments)).toEqual(Array.from(a.assignments));
    expect(b.centroids.map((c) => Array.from(c))).toEqual(a.centroids.map((c) => Array.from(c)));
  });

  test('stops at maxIterations', () => {
    const { vectors } = groups([40, 40, 40], 'cap', 1.5);
    const result = sphericalKMeans(vectors, { k: 8, seed: 'cap', maxIterations: 1 });
    expect(result.iterations).toBe(1);
  });
});

describe('mergeSmallClusters', () => {
  test('a cluster of 3 members is merged into its nearest cluster', () => {
    const near = normalize(Float32Array.from([1, 0.2, 0, ...new Array(DIM - 3).fill(0)]));
    const vectors = [
      ...Array.from({ length: 10 }, () => basis(0)),
      ...Array.from({ length: 10 }, () => basis(1)),
      ...Array.from({ length: 3 }, () => near),
    ];
    const input: KMeansResult = {
      centroids: [basis(0), basis(1), near],
      assignments: Int32Array.from([...new Array(10).fill(0), ...new Array(10).fill(1), 2, 2, 2]),
      iterations: 1,
    };
    const merged = mergeSmallClusters(input, vectors, 5);
    expect(merged.centroids).toHaveLength(2);
    const sizes = new Map<number, number>();
    for (const c of merged.assignments) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    expect([...sizes.values()].sort((x, y) => x - y)).toEqual([10, 13]);
    expect(merged.assignments[20]).toBe(merged.assignments[0]);
  });

  test('keeps a lone cluster even when it is small', () => {
    const vectors = [basis(0), basis(0)];
    const merged = mergeSmallClusters({ centroids: [basis(0)], assignments: Int32Array.from([0, 0]), iterations: 1 }, vectors, 5);
    expect(merged.centroids).toHaveLength(1);
  });
});

describe('assignNearest and distanceThreshold', () => {
  const centroids = [
    { clusterId: 'c-01', centroid: basis(0) },
    { clusterId: 'c-02', centroid: basis(1) },
  ];

  test('assigns to the nearest centroid within the threshold', () => {
    const v = normalize(Float32Array.from([0.9, 0.1, ...new Array(DIM - 2).fill(0)]));
    const hit = assignNearest(v, centroids, 0.2);
    expect(hit.clusterId).toBe('c-01');
    expect(hit.distance).toBeGreaterThan(0);
    expect(hit.distance).toBeLessThan(0.2);
  });

  test('returns novel when every centroid is farther than the threshold', () => {
    const hit = assignNearest(basis(5), centroids, 0.3);
    expect(hit.clusterId).toBe('novel');
    expect(hit.distance).toBeCloseTo(1, 6);
  });

  test('the threshold is the 95th percentile of member distances', () => {
    const { vectors } = groups([50, 50], 'thr', 0.4);
    const result = sphericalKMeans(vectors, { k: 2, seed: 'thr', maxIterations: 50 });
    const threshold = distanceThreshold(result, vectors, 0.95);
    const distances = vectors.map((v, i) => 1 - dot(v, result.centroids[result.assignments[i] as number] as Float32Array));
    const within = distances.filter((d) => d <= threshold + 1e-6).length;
    expect(within / distances.length).toBeGreaterThanOrEqual(0.95);
    expect(threshold).toBeGreaterThan(0);
    expect(threshold).toBeLessThanOrEqual(2);
  });
});

describe('carryClusterIds', () => {
  const old = [
    { clusterId: 'c-01', centroid: basis(0) },
    { clusterId: 'c-03', centroid: basis(1) },
  ];

  function at(cosine: number, axis: number, other: number): Float32Array {
    const v = new Float32Array(DIM);
    v[axis] = cosine;
    v[other] = Math.sqrt(1 - cosine * cosine);
    return v;
  }

  test('keeps c-03 for a new centroid with cosine 0.9 to the old c-03', () => {
    const ids = carryClusterIds(old, [at(0.9, 1, 7)], 0.85);
    expect(ids).toEqual(['c-03']);
  });

  test('gives a new opaque id when the best cosine is 0.8', () => {
    const ids = carryClusterIds(old, [at(0.8, 1, 7)], 0.85);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^c-[0-9]{2,3}$/);
    expect(['c-01', 'c-03']).not.toContain(ids[0]);
  });

  test('an old id is carried to at most one new centroid; a first fit numbers from c-01', () => {
    const ids = carryClusterIds(old, [at(0.95, 1, 7), at(0.9, 1, 8), basis(0)], 0.85);
    expect(ids[0]).toBe('c-03');
    expect(ids[2]).toBe('c-01');
    expect(ids[1]).toBe('c-04');
    expect(carryClusterIds([], [basis(0), basis(1)], 0.85)).toEqual(['c-01', 'c-02']);
  });
});
