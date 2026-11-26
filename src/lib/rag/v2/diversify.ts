import type { FusedHit } from '../fusion/rrf';
import type { ResultDiversityMode } from '../config';

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
  relevanceByChunk?: ReadonlyMap<string, number>;
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

export function diversify(hits: FusedHit[], _options: DiversifyOptions): DiversifyResult {
  return { hits, alsoIn: new Map(), counts: { in: hits.length, kept: hits.length, collapsed: 0, mmr_moved: 0 } };
}
