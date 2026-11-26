import type { FusedHit } from '../fusion/rrf';
import type { ResultDiversityMode } from '../config';
import { lexicalTokens } from '../lexical/tokenize';

/** Another document of the kept chunk's duplicate cluster (D-21): the first dropped chunk of that document. */
export interface AlsoIn {
  documentId: string;
  filename: string;
  chunkId: string;
}

export interface DiversifyOptions {
  mode: ResultDiversityMode;
  lambda: number;
  windowFactor: number;
  finalTopK: number;
  /** The rerank scores when the rerank ran; otherwise relevance is the fused score. */
  relevanceByChunk?: ReadonlyMap<string, number>;
  /** The sub-questions a hit covers; a hit that is the only cover of one is never collapsed. */
  subQuestionOf?: (row: FusedHit) => readonly number[];
}

export interface DiversifyCounts {
  in: number;
  kept: number;
  collapsed: number;
  mmr_moved: number;
}

export interface DiversifyResult {
  hits: FusedHit[];
  alsoIn: Map<string, AlsoIn[]>;
  counts: DiversifyCounts;
}

function soleCovers(hits: FusedHit[], subQuestionOf: DiversifyOptions['subQuestionOf']): Set<number> {
  const protectedIndexes = new Set<number>();
  if (!subQuestionOf) return protectedIndexes;
  const coverers = new Map<number, number[]>();
  hits.forEach((row, index) => {
    for (const subQuestion of new Set(subQuestionOf(row))) {
      const list = coverers.get(subQuestion) ?? [];
      list.push(index);
      coverers.set(subQuestion, list);
    }
  });
  for (const list of coverers.values()) if (list.length === 1) protectedIndexes.add(list[0]!);
  return protectedIndexes;
}

function collapse(hits: FusedHit[], options: DiversifyOptions): { hits: FusedHit[]; alsoIn: Map<string, AlsoIn[]> } {
  const guarded = soleCovers(hits, options.subQuestionOf);
  const keeperByCluster = new Map<string, FusedHit>();
  const listed = new Map<string, Set<string>>();
  const alsoIn = new Map<string, AlsoIn[]>();
  const kept: FusedHit[] = [];
  hits.forEach((row, index) => {
    const cluster = row.hit.dupClusterId;
    if (!cluster) {
      kept.push(row);
      return;
    }
    const keeper = keeperByCluster.get(cluster);
    if (!keeper) {
      keeperByCluster.set(cluster, row);
      listed.set(row.hit.chunkId, new Set([row.hit.documentId]));
      kept.push(row);
      return;
    }
    if (guarded.has(index)) {
      kept.push(row);
      return;
    }
    const seen = listed.get(keeper.hit.chunkId)!;
    if (seen.has(row.hit.documentId)) return;
    seen.add(row.hit.documentId);
    const entries = alsoIn.get(keeper.hit.chunkId) ?? [];
    entries.push({ documentId: row.hit.documentId, filename: row.hit.document.filename, chunkId: row.hit.chunkId });
    alsoIn.set(keeper.hit.chunkId, entries);
  });
  return { hits: kept, alsoIn };
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function mmrOrder(window: FusedHit[], options: DiversifyOptions): FusedHit[] {
  if (window.length < 2) return window;
  const raw = window.map((row) => options.relevanceByChunk?.get(row.hit.chunkId) ?? row.score);
  const finite = raw.map((value) => (Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY));
  const usable = finite.filter((value) => Number.isFinite(value));
  const min = usable.length > 0 ? Math.min(...usable) : 0;
  const max = usable.length > 0 ? Math.max(...usable) : 0;
  const span = max - min;
  const relevance = finite.map((value) => (!Number.isFinite(value) ? 0 : span > 0 ? (value - min) / span : 1));
  const tokens = window.map((row) => new Set(lexicalTokens(row.hit.content)));
  const lambda = Math.min(Math.max(options.lambda, 0), 1);

  const maxSim = window.map(() => 0);
  const remaining = window.map((_, index) => index);
  const order: number[] = [];
  while (remaining.length > 0) {
    let bestAt = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    remaining.forEach((index, at) => {
      const score = lambda * relevance[index]! - (1 - lambda) * maxSim[index]!;
      if (score > bestScore) {
        bestScore = score;
        bestAt = at;
      }
    });
    const [chosen] = remaining.splice(bestAt, 1);
    order.push(chosen!);
    for (const index of remaining) {
      const sim = jaccard(tokens[index]!, tokens[chosen!]!);
      if (sim > maxSim[index]!) maxSim[index] = sim;
    }
  }
  return order.map((index) => window[index]!);
}

/**
 * D-21, D-48: `collapse` keeps the best-ranked chunk of each duplicate cluster; `mmr` collapses first, then reorders
 * the top window by maximal marginal relevance (min-max relevance, Jaccard of lexical token sets). Pure and deterministic.
 */
export function diversify(hits: FusedHit[], options: DiversifyOptions): DiversifyResult {
  if (options.mode === 'off') {
    return { hits, alsoIn: new Map(), counts: { in: hits.length, kept: hits.length, collapsed: 0, mmr_moved: 0 } };
  }
  const collapsed = collapse(hits, options);
  let out = collapsed.hits;
  let moved = 0;
  if (options.mode === 'mmr') {
    const size = Math.max(0, Math.floor(options.windowFactor) * Math.floor(options.finalTopK));
    const window = out.slice(0, size);
    const reordered = mmrOrder(window, options);
    moved = reordered.reduce((count, row, index) => (row === window[index] ? count : count + 1), 0);
    out = [...reordered, ...out.slice(size)];
  }
  return {
    hits: out,
    alsoIn: collapsed.alsoIn,
    counts: { in: hits.length, kept: out.length, collapsed: hits.length - collapsed.hits.length, mmr_moved: moved },
  };
}
