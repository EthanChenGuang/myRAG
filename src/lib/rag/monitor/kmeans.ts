import { seededRandom } from '../ingest/backfill/sample';

/** Seeded spherical k-means over unit vectors (D-40). Pure: no I/O, the same input and seed give the same clusters. */
export interface KMeansResult {
  centroids: Float32Array[];
  /** Cluster index of every input vector. */
  assignments: Int32Array;
  iterations: number;
}

export interface KMeansOptions {
  k: number;
  seed: string;
  maxIterations?: number;
}

export interface CentroidRef {
  clusterId: string;
  centroid: ArrayLike<number>;
}

export const NOVEL_CLUSTER = 'novel';
export const DEFAULT_MAX_ITERATIONS = 50;
export const MIN_CLUSTER_SIZE = 5;
export const CARRY_MIN_COSINE = 0.85;

const CLUSTER_ID_RE = /^c-([0-9]{2,3})$/;

/** k = clamp(round(sqrt(n / 2)), 4, 40), never more than n. */
export function chooseK(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const k = Math.min(40, Math.max(4, Math.round(Math.sqrt(n / 2))));
  return Math.min(k, Math.floor(n));
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

function norm(a: ArrayLike<number>): number {
  return Math.sqrt(dot(a, a));
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Number.NEGATIVE_INFINITY;
  const n = norm(a) * norm(b);
  return n === 0 ? 0 : dot(a, b) / n;
}

function cosineDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const d = 1 - cosine(a, b);
  return Number.isFinite(d) ? Math.min(2, Math.max(0, d)) : 2;
}

/** A unit-length copy; a zero vector stays zero. */
export function normalize(vector: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(vector);
  const length = norm(out);
  if (length === 0) return out;
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i] as number) / length;
  return out;
}

/** k-means++ seeding with cosine distance: indices of k distinct input vectors. */
export function kmeansPlusPlus(vectors: readonly Float32Array[], k: number, rand: () => number): number[] {
  const n = vectors.length;
  const want = Math.min(Math.max(0, Math.floor(k)), n);
  if (want === 0) return [];
  const chosen: number[] = [Math.min(n - 1, Math.floor(rand() * n))];
  const nearest = new Float64Array(n);
  for (let i = 0; i < n; i += 1) nearest[i] = cosineDistance(vectors[i] as Float32Array, vectors[chosen[0] as number] as Float32Array);

  while (chosen.length < want) {
    let total = 0;
    for (let i = 0; i < n; i += 1) total += (nearest[i] as number) ** 2;
    let next = -1;
    if (total > 0) {
      let target = rand() * total;
      for (let i = 0; i < n; i += 1) {
        const weight = (nearest[i] as number) ** 2;
        if (weight === 0) continue;
        target -= weight;
        if (target <= 0) {
          next = i;
          break;
        }
      }
      if (next === -1) {
        for (let i = n - 1; i >= 0; i -= 1) {
          if ((nearest[i] as number) > 0) {
            next = i;
            break;
          }
        }
      }
    }
    if (next === -1) {
      // Every remaining vector duplicates a seed: take the first unchosen index so seeds stay distinct.
      const taken = new Set(chosen);
      for (let i = 0; i < n; i += 1) {
        if (!taken.has(i)) {
          next = i;
          break;
        }
      }
    }
    chosen.push(next);
    const seed = vectors[next] as Float32Array;
    for (let i = 0; i < n; i += 1) nearest[i] = Math.min(nearest[i] as number, cosineDistance(vectors[i] as Float32Array, seed));
    nearest[next] = 0;
  }
  return chosen;
}

function nearestCentroid(vector: Float32Array, centroids: readonly Float32Array[]): number {
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let c = 0; c < centroids.length; c += 1) {
    const score = dot(vector, centroids[c] as Float32Array);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function meanDirection(vectors: readonly Float32Array[], assignments: Int32Array, cluster: number, dim: number): Float32Array | null {
  const sum = new Float32Array(dim);
  let members = 0;
  for (let i = 0; i < vectors.length; i += 1) {
    if (assignments[i] !== cluster) continue;
    members += 1;
    const v = vectors[i] as Float32Array;
    for (let d = 0; d < dim; d += 1) sum[d] = (sum[d] as number) + (v[d] as number);
  }
  return members === 0 ? null : normalize(sum);
}

/** Lloyd iterations on the unit sphere: at most maxIterations passes, stopping when no assignment changes. */
export function sphericalKMeans(vectors: readonly Float32Array[], options: KMeansOptions): KMeansResult {
  const maxIterations = Math.max(1, Math.floor(options.maxIterations ?? DEFAULT_MAX_ITERATIONS));
  const units = vectors.map((v) => normalize(v));
  const n = units.length;
  const dim = units[0]?.length ?? 0;
  const seeds = kmeansPlusPlus(units, options.k, seededRandom(options.seed, 'spherical-kmeans'));
  const centroids: Float32Array[] = seeds.map((i) => Float32Array.from(units[i] as Float32Array));
  const assignments = new Int32Array(n).fill(-1);
  if (centroids.length === 0) return { centroids, assignments, iterations: 0 };

  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    let changed = false;
    for (let i = 0; i < n; i += 1) {
      const c = nearestCentroid(units[i] as Float32Array, centroids);
      if (assignments[i] !== c) {
        assignments[i] = c;
        changed = true;
      }
    }
    if (!changed) break;
    for (let c = 0; c < centroids.length; c += 1) {
      const next = meanDirection(units, assignments, c, dim);
      if (next) centroids[c] = next;
    }
  }
  return { centroids, assignments, iterations };
}

/**
 * Merges every cluster under minSize members into the cluster with the nearest centroid, smallest first, and recomputes the
 * receiving centroid. Empty clusters are dropped; a lone cluster is kept whatever its size. Cluster indices are renumbered in order.
 */
export function mergeSmallClusters(result: KMeansResult, vectors: readonly Float32Array[], minSize = MIN_CLUSTER_SIZE): KMeansResult {
  const units = vectors.map((v) => normalize(v));
  const dim = units[0]?.length ?? result.centroids[0]?.length ?? 0;
  const assignments = Int32Array.from(result.assignments);
  const centroids = new Map<number, Float32Array>(result.centroids.map((c, i) => [i, c]));
  const sizes = new Map<number, number>([...centroids.keys()].map((c) => [c, 0]));
  for (const c of assignments) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  for (const [c, size] of sizes) {
    if (size === 0) {
      centroids.delete(c);
      sizes.delete(c);
    }
  }

  for (;;) {
    if (centroids.size <= 1) break;
    let smallest = -1;
    for (const [c, size] of sizes) {
      if (size >= minSize) continue;
      if (smallest === -1 || size < (sizes.get(smallest) as number) || (size === sizes.get(smallest) && c < smallest)) smallest = c;
    }
    if (smallest === -1) break;
    const from = centroids.get(smallest) as Float32Array;
    let target = -1;
    let best = Number.NEGATIVE_INFINITY;
    for (const [c, centroid] of centroids) {
      if (c === smallest) continue;
      const score = dot(from, centroid);
      if (score > best || (score === best && c < target)) {
        best = score;
        target = c;
      }
    }
    for (let i = 0; i < assignments.length; i += 1) if (assignments[i] === smallest) assignments[i] = target;
    sizes.set(target, (sizes.get(target) as number) + (sizes.get(smallest) as number));
    sizes.delete(smallest);
    centroids.delete(smallest);
    const recomputed = meanDirection(units, assignments, target, dim);
    if (recomputed) centroids.set(target, recomputed);
  }

  const order = [...centroids.keys()].sort((a, b) => a - b);
  const renumber = new Map(order.map((c, i) => [c, i]));
  for (let i = 0; i < assignments.length; i += 1) assignments[i] = renumber.get(assignments[i] as number) ?? -1;
  return { centroids: order.map((c) => centroids.get(c) as Float32Array), assignments, iterations: result.iterations };
}

/** The nearest centroid by cosine distance, or novel when every centroid is farther than the threshold. */
export function assignNearest(
  vector: ArrayLike<number>,
  centroids: readonly CentroidRef[],
  threshold: number,
): { clusterId: string; distance: number } {
  let bestId: string | null = null;
  let bestDistance = 2;
  for (const { clusterId, centroid } of centroids) {
    const distance = cosineDistance(vector, centroid);
    if (bestId === null || distance < bestDistance) {
      bestId = clusterId;
      bestDistance = distance;
    }
  }
  if (bestId === null || bestDistance > threshold) return { clusterId: NOVEL_CLUSTER, distance: bestDistance };
  return { clusterId: bestId, distance: bestDistance };
}

/** The nearest-rank percentile of member-to-centroid cosine distances at fit time, within [0, 2]. */
export function distanceThreshold(result: KMeansResult, vectors: readonly Float32Array[], percentile = 0.95): number {
  const distances: number[] = [];
  for (let i = 0; i < vectors.length; i += 1) {
    const centroid = result.centroids[result.assignments[i] as number];
    if (centroid) distances.push(cosineDistance(vectors[i] as Float32Array, centroid));
  }
  if (distances.length === 0) return 0;
  distances.sort((a, b) => a - b);
  const p = Math.min(1, Math.max(0, percentile));
  const index = Math.min(distances.length - 1, Math.max(0, Math.ceil(p * distances.length) - 1));
  return Math.min(2, Math.max(0, distances[index] as number));
}

function formatClusterId(n: number): string {
  return `c-${String(n).padStart(2, '0')}`;
}

/**
 * Opaque ids for refitted centroids: a new centroid keeps an old id when their cosine is at least minCosine (best pairs first, each
 * old id used once); every other centroid gets the next number above the highest old one. Centroids of another dimension never match.
 */
export function carryClusterIds(
  oldCentroids: readonly CentroidRef[],
  newCentroids: readonly ArrayLike<number>[],
  minCosine = CARRY_MIN_COSINE,
): string[] {
  const pairs: Array<{ next: number; old: number; score: number }> = [];
  newCentroids.forEach((centroid, next) => {
    oldCentroids.forEach((old, index) => {
      const score = cosine(centroid, old.centroid);
      if (score >= minCosine) pairs.push({ next, old: index, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.next - b.next || a.old - b.old);

  const ids: Array<string | null> = newCentroids.map(() => null);
  const usedOld = new Set<number>();
  for (const pair of pairs) {
    if (ids[pair.next] !== null || usedOld.has(pair.old)) continue;
    ids[pair.next] = (oldCentroids[pair.old] as CentroidRef).clusterId;
    usedOld.add(pair.old);
  }

  let counter = 0;
  for (const old of oldCentroids) {
    const match = CLUSTER_ID_RE.exec(old.clusterId);
    if (match) counter = Math.max(counter, Number(match[1]));
  }
  return ids.map((id) => {
    if (id !== null) return id;
    counter += 1;
    return formatClusterId(counter);
  });
}
