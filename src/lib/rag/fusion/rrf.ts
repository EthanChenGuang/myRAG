import type { RankedHit } from '../backend/types';

export interface RankedList {
  id: string;
  weight: number;
  hits: RankedHit[];
}

export interface FusedHit {
  hit: RankedHit;
  score: number;
  ranks: Record<string, number>;
  /** Set by the search stage with the query layer on: the dense similarity under the standalone variant (0 when absent). */
  standaloneSimilarity?: number;
}

export function rrf(lists: RankedList[], k = 60): FusedHit[] {
  const orderedLists = [...lists].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const acc = new Map<string, { score: number; ranks: Record<string, number>; hit: RankedHit }>();

  for (const list of orderedLists) {
    if (list.weight <= 0 || list.hits.length === 0) {
      continue;
    }
    for (const hit of list.hits) {
      const existing = acc.get(hit.chunkId);
      if (existing) {
        existing.score += list.weight / (k + hit.rank);
        existing.ranks[list.id] = hit.rank;
      } else {
        acc.set(hit.chunkId, {
          score: list.weight / (k + hit.rank),
          ranks: { [list.id]: hit.rank },
          hit,
        });
      }
    }
  }

  return [...acc.values()]
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.hit.chunkId < b.hit.chunkId ? -1 : a.hit.chunkId > b.hit.chunkId ? 1 : 0;
    })
    .map((entry) => ({
      hit: entry.hit,
      score: entry.score,
      ranks: entry.ranks,
    }));
}