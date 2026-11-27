import { createHash } from 'node:crypto';
import type { BgeM3Via } from '../config';
import { createBgeM3Provider } from './bge-m3';
import type { EmbeddingProvider } from './types';
import { BGE_M3_MODEL_ID, BGE_M3_NATIVE_DIMS } from './types';

/** The D-26 tolerance: below it the route does not serve the weights the stored vectors came from. */
export const ROUTE_MIN_COSINE = 0.9999;

/** D-26: every component of the L2-normalized vectors within this absolute difference. */
export const ROUTE_MAX_COMPONENT_DELTA = 1e-3;

/** Fixed probe texts; changing them changes the reference file a comparison needs. */
export const ROUTE_PROBE_TEXTS: readonly string[] = [
  'Which shape is placed to the left of the red circle?',
  'Record 4711 was written at step 12 with a measured value of 0.35 and a weight of 19.',
  'The second section repeats the definition from the first section in shorter words.',
  'Each item in the list has a short title, a numeric code and one line of plain text.',
];

export interface RouteReferenceEntry {
  textSha256: string;
  vector: number[];
}

/** Vectors made by one route for the probe texts, e.g. stored DeepInfra vectors exported once, compared without a DeepInfra call. */
export interface RouteReference {
  model: string;
  host: string;
  entries: RouteReferenceEntry[];
}

export type RouteSide =
  | { route: string; status: 'ok'; host: string; dims: number; vectors: number[][] }
  | { route: string; status: 'unavailable'; reason: string };

export interface RouteComparison {
  against: string;
  cosines: number[];
  minCosine: number;
  /** Largest absolute component difference over all probes, after L2 normalization; NaN when a vector is missing or zero. */
  maxComponentDelta: number;
}

export interface RouteVerifyReport {
  model: string;
  probes: number;
  sides: RouteSide[];
  comparison: RouteComparison | null;
  verdict: 'match' | 'mismatch' | 'not_compared';
  minCosineRequired: number;
  maxComponentDeltaRequired: number;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return Number.NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? Number.NaN : dot / Math.sqrt(na * nb);
}

/** The reason kind only: an HTTP status or error name, never the vendor's message text. */
function reasonOf(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return `http_${status}`;
  if (error instanceof Error) {
    const missing = /([A-Z][A-Z0-9_]+_API_KEY) not configured/.exec(error.message);
    if (missing) return `${missing[1]}_not_configured`;
    if (error.name === 'EmbeddingProfileMismatch') return error.message.slice(0, 160);
    return error.name || 'error';
  }
  return 'error';
}

async function embedSide(route: string, provider: EmbeddingProvider, texts: readonly string[], signal: AbortSignal): Promise<RouteSide> {
  try {
    const output = await provider.embedDocuments([...texts], { dims: BGE_M3_NATIVE_DIMS, signal });
    return { route, status: 'ok', host: output.host, dims: output.vectors[0]?.length ?? 0, vectors: output.vectors };
  } catch (error) {
    if (signal.aborted) throw error;
    return { route, status: 'unavailable', reason: reasonOf(error) };
  }
}

function unitVector(vector: readonly number[]): number[] | null {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return norm === 0 || !Number.isFinite(norm) ? null : vector.map((x) => x / norm);
}

function maxDelta(a: readonly number[], b: readonly number[]): number {
  const ua = unitVector(a);
  const ub = unitVector(b);
  if (!ua || !ub || ua.length !== ub.length || ua.length === 0) return Number.NaN;
  let max = 0;
  for (let i = 0; i < ua.length; i += 1) max = Math.max(max, Math.abs(ua[i]! - ub[i]!));
  return max;
}

function compare(against: string, candidate: number[][], reference: number[][]): RouteComparison {
  const cosines = candidate.map((vector, index) => cosine(vector, reference[index] ?? []));
  const minCosine = cosines.reduce((min, value) => (Number.isNaN(value) ? Number.NaN : Math.min(min, value)), 1);
  const maxComponentDelta = candidate.reduce(
    (max, vector, index) => {
      const delta = maxDelta(vector, reference[index] ?? []);
      return Number.isNaN(max) || Number.isNaN(delta) ? Number.NaN : Math.max(max, delta);
    },
    candidate.length === reference.length ? 0 : Number.NaN,
  );
  return { against, cosines, minCosine, maxComponentDelta };
}

/** NaN fails both comparisons, so a missing or zero vector is never a match. */
function withinTolerance(comparison: RouteComparison): boolean {
  return comparison.minCosine >= ROUTE_MIN_COSINE && comparison.maxComponentDelta <= ROUTE_MAX_COMPONENT_DELTA;
}

export function referenceVectors(reference: RouteReference, texts: readonly string[]): number[][] {
  if (reference.model.toLowerCase() !== BGE_M3_MODEL_ID.toLowerCase()) throw new Error(`reference model ${reference.model} is not ${BGE_M3_MODEL_ID}`);
  const bySha = new Map(reference.entries.map((entry) => [entry.textSha256, entry.vector]));
  return texts.map((text) => {
    const vector = bySha.get(sha256Text(text));
    if (!vector) throw new Error('the reference file does not cover every probe text');
    return vector;
  });
}

export interface VerifyRouteInput {
  signal: AbortSignal;
  /** Provider per route; defaults to the hosted BGE-M3 provider pinned to that route. */
  providers?: Partial<Record<BgeM3Via, EmbeddingProvider>>;
  /** Compare OpenRouter with these vectors instead of calling DeepInfra. */
  reference?: RouteReference;
  texts?: readonly string[];
}

function routeProvider(via: BgeM3Via): EmbeddingProvider {
  return createBgeM3Provider({ serving: () => 'hosted', via: () => via });
}

/**
 * Embeds the probe texts through RAG_BGE_M3_VIA=openrouter and compares them with DeepInfra's vectors (a live DeepInfra call, or a
 * reference file of DeepInfra-made vectors). The profile id bge-m3-1024 may be served through OpenRouter only on a `match`.
 */
export async function verifyBgeM3Route(input: VerifyRouteInput): Promise<RouteVerifyReport> {
  const texts = input.texts ?? ROUTE_PROBE_TEXTS;
  const providers = input.providers ?? {};
  const sides: RouteSide[] = [];
  const openrouter = await embedSide('openrouter', providers.openrouter ?? routeProvider('openrouter'), texts, input.signal);
  sides.push(openrouter);

  let baseline: { against: string; vectors: number[][] } | null = null;
  if (input.reference) {
    baseline = { against: `reference:${input.reference.host}`, vectors: referenceVectors(input.reference, texts) };
  } else {
    const deepinfra = await embedSide('deepinfra', providers.deepinfra ?? routeProvider('deepinfra'), texts, input.signal);
    sides.push(deepinfra);
    if (deepinfra.status === 'ok') baseline = { against: 'deepinfra', vectors: deepinfra.vectors };
  }

  const comparison = openrouter.status === 'ok' && baseline ? compare(baseline.against, openrouter.vectors, baseline.vectors) : null;
  const verdict = comparison === null ? 'not_compared' : withinTolerance(comparison) ? 'match' : 'mismatch';
  return {
    model: BGE_M3_MODEL_ID,
    probes: texts.length,
    sides,
    comparison,
    verdict,
    minCosineRequired: ROUTE_MIN_COSINE,
    maxComponentDeltaRequired: ROUTE_MAX_COMPONENT_DELTA,
  };
}

/** A reference file from one route's vectors, so a later run compares without calling that route again. */
export function referenceFrom(side: Extract<RouteSide, { status: 'ok' }>, texts: readonly string[] = ROUTE_PROBE_TEXTS): RouteReference {
  return {
    model: BGE_M3_MODEL_ID,
    host: side.host,
    entries: texts.map((text, index) => ({ textSha256: sha256Text(text), vector: side.vectors[index] ?? [] })),
  };
}
