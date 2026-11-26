import type { FusedHit } from './rrf';

export interface DedupeCounts {
  candidates_in: number;
  deduped: number;
  rerank_input: number;
  capped_from: number;
  /** D-34: set only when the terminology reservation ran; absent keeps the serialized counts unchanged. */
  term_reserved?: number;
}

export interface DedupeResult {
  hits: FusedHit[];
  counts: DedupeCounts;
}

export function dedupeAndCap(
  fused: FusedHit[],
  options: { byParent: boolean; cap: number },
): DedupeResult {
  const candidates_in = fused.length;
  const seenChunks = new Set<string>();
  const seenParents = new Set<string>();
  const deduped: FusedHit[] = [];
  let removed = 0;

  for (const row of fused) {
    const { chunkId, parentId } = row.hit;
    if (seenChunks.has(chunkId)) {
      removed += 1;
      continue;
    }
    if (options.byParent && parentId !== null && seenParents.has(parentId)) {
      removed += 1;
      continue;
    }

    seenChunks.add(chunkId);
    if (options.byParent && parentId !== null) {
      seenParents.add(parentId);
    }
    deduped.push(row);
  }

  const capped_from = deduped.length;
  const hits = deduped.slice(0, options.cap);

  return {
    hits,
    counts: {
      candidates_in,
      deduped: removed,
      rerank_input: hits.length,
      capped_from,
    },
  };
}