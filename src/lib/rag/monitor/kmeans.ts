export interface KMeansResult {
  centroids: Float32Array[];
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

export function chooseK(_n: number): number {
  return -1;
}

export function normalize(vector: ArrayLike<number>): Float32Array {
  return Float32Array.from(vector);
}

export function kmeansPlusPlus(_vectors: readonly Float32Array[], _k: number, _rand: () => number): number[] {
  return [];
}

export function sphericalKMeans(_vectors: readonly Float32Array[], _options: KMeansOptions): KMeansResult {
  return { centroids: [], assignments: new Int32Array(0), iterations: 0 };
}

export function mergeSmallClusters(result: KMeansResult, _vectors: readonly Float32Array[], _minSize = 5): KMeansResult {
  return result;
}

export function assignNearest(_vector: ArrayLike<number>, _centroids: readonly CentroidRef[], _threshold: number): { clusterId: string; distance: number } {
  return { clusterId: '', distance: -1 };
}

export function distanceThreshold(_result: KMeansResult, _vectors: readonly Float32Array[], _percentile = 0.95): number {
  return -1;
}

export function carryClusterIds(_oldCentroids: readonly CentroidRef[], newCentroids: readonly ArrayLike<number>[], _minCosine = 0.85): string[] {
  return newCentroids.map(() => '');
}
