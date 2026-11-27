import type { ScopeGateResult } from '@/lib/rag-eval/contracts.generated';
import type { CentroidSnapshot } from './centroids';
import { maxDot } from './max-dot';

/** A calibrated cell's decision values (D-27); null cells keep the gate score-only. */
export interface ScopeCell {
  threshold: number;
  margin: number;
}

/** P-13 and research Pitfall 5: conditions under which the gate only reports its score. */
export interface ScopeGateFlags {
  /** The query layer was asked to translate and the translate transform was skipped. */
  translateSkipped?: boolean;
  /** The tenant has a doc-type-scoped embedding binding (also read from the snapshot). */
  scopedBinding?: boolean;
}

export interface ScoreScopeInput {
  /** The non-HyDE variant embeddings, in any length; each is normalized before scoring. */
  queryVectors: readonly (Float32Array | readonly number[])[];
  snapshot: CentroidSnapshot | null;
  cell: ScopeCell | null;
  flags?: ScopeGateFlags;
}

export type ScopeScore = Omit<ScopeGateResult, 'latency_ms'>;

const centroidVectors = new WeakMap<CentroidSnapshot, Float32Array[]>();

function vectorsOf(snapshot: CentroidSnapshot): Float32Array[] {
  let vectors = centroidVectors.get(snapshot);
  if (!vectors) {
    vectors = snapshot.centroids.map((centroid) => centroid.vector);
    centroidVectors.set(snapshot, vectors);
  }
  return vectors;
}

function normalized(values: Float32Array | readonly number[], dims: number): Float32Array | null {
  if (values.length !== dims) return null;
  let norm = 0;
  for (let i = 0; i < dims; i += 1) {
    const value = values[i]!;
    if (!Number.isFinite(value)) return null;
    norm += value * value;
  }
  if (!(norm > 0)) return null;
  const scale = 1 / Math.sqrt(norm);
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i += 1) out[i] = values[i]! * scale;
  return out;
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * D-26, D-38, P-04: the maximum cosine similarity of any non-HyDE variant to the tenant's centroids, compared with the maximum
 * similarity to its negative examples. Pure and synchronous; it fails open: every case without a usable snapshot, query vector or
 * calibrated cell, and every flagged case, is unsure. A query reaching the threshold is in scope without scoring the rest.
 */
export function scoreScope(input: ScoreScopeInput): ScopeScore {
  const { snapshot, cell } = input;
  if (!snapshot) return { label: 'unsure', score: null, negative_score: null, reason: 'no_snapshot', centroid_count: 0 };
  const centroidCount = snapshot.centroids.length;
  if (centroidCount === 0 || snapshot.dims <= 0) {
    return { label: 'unsure', score: null, negative_score: null, reason: 'no_centroids', centroid_count: centroidCount };
  }
  const queries: Float32Array[] = [];
  for (const vector of input.queryVectors) {
    const unit = normalized(vector, snapshot.dims);
    if (unit) queries.push(unit);
  }
  if (queries.length === 0) {
    return { label: 'unsure', score: null, negative_score: null, reason: 'no_query_vector', centroid_count: centroidCount };
  }

  const unsureReason = input.flags?.translateSkipped
    ? 'translate_skipped'
    : snapshot.unsupported || input.flags?.scopedBinding
      ? 'scoped_binding'
      : cell === null
        ? 'uncalibrated'
        : null;
  const decides = unsureReason === null && cell !== null;

  const centroids = vectorsOf(snapshot);
  let best = Number.NEGATIVE_INFINITY;
  let reached = false;
  if (decides) {
    for (const query of queries) {
      const value = maxDot([query], centroids);
      if (value > best) best = value;
      if (best >= cell.threshold) {
        reached = true;
        break;
      }
    }
  } else {
    best = maxDot(queries, centroids);
  }
  const score = finite(best);
  if (reached && score !== null) {
    return { label: 'in_scope', score, negative_score: null, reason: 'above_threshold', centroid_count: centroidCount };
  }
  const negativeScore = snapshot.examples.length > 0 ? finite(maxDot(queries, snapshot.examples as Float32Array[])) : null;

  if (!decides || score === null) {
    return { label: 'unsure', score, negative_score: negativeScore, reason: unsureReason ?? 'no_score', centroid_count: centroidCount };
  }
  if (negativeScore !== null && negativeScore > score) {
    return { label: 'out_of_scope', score, negative_score: negativeScore, reason: 'negative_closer', centroid_count: centroidCount };
  }
  if (score < cell.threshold - cell.margin) {
    return { label: 'out_of_scope', score, negative_score: negativeScore, reason: 'below_threshold', centroid_count: centroidCount };
  }
  return { label: 'unsure', score, negative_score: negativeScore, reason: 'within_margin', centroid_count: centroidCount };
}
