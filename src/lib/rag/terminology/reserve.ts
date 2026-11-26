import type { RankedHit } from '../backend/types';
import type { DedupeResult } from '../fusion/dedupe';
import type { FusedHit } from '../fusion/rrf';

export interface ReserveOptions {
  /** TerminologyParams.reserve_slots in force for the request; 0 turns the reservation off. */
  reserveSlots: number;
  /** The same parent-child dedupe switch the dedupe stage used. */
  byParent: boolean;
}

/**
 * D-34: up to reserveSlots of the best-ranked term:0 hits that fell outside the rerank input replace its lowest-ranked entries,
 * never more than half of it. Reserved hits keep their fused score and stand last in term:0 rank order; the length is unchanged.
 * A hit whose chunk, or with byParent whose parent, is already in the input does not count as outside.
 */
export function reserveTerminologyHits(
  result: DedupeResult,
  fused: readonly FusedHit[],
  termHits: readonly RankedHit[] | null | undefined,
  options: ReserveOptions,
): DedupeResult {
  if (!termHits || termHits.length === 0 || options.reserveSlots <= 0) return result;

  const limit = Math.min(options.reserveSlots, Math.floor(result.hits.length / 2));
  const inputChunks = new Set(result.hits.map((row) => row.hit.chunkId));
  const inputParents = new Set<string>();
  if (options.byParent) {
    for (const row of result.hits) if (row.hit.parentId !== null) inputParents.add(row.hit.parentId);
  }
  const fusedById = new Map(fused.map((row) => [row.hit.chunkId, row]));

  const reserved: FusedHit[] = [];
  for (const termHit of [...termHits].sort((a, b) => a.rank - b.rank)) {
    if (reserved.length >= limit) break;
    if (inputChunks.has(termHit.chunkId)) continue;
    const parentId = termHit.parentId;
    if (options.byParent && parentId !== null && inputParents.has(parentId)) continue;
    const row = fusedById.get(termHit.chunkId);
    if (!row) continue;
    reserved.push(row);
    inputChunks.add(termHit.chunkId);
    if (options.byParent && parentId !== null) inputParents.add(parentId);
  }

  const kept = result.hits.slice(0, result.hits.length - reserved.length);
  return {
    hits: [...kept, ...reserved],
    counts: { ...result.counts, term_reserved: reserved.length },
  };
}
