import type { RerankScore, RerankSpan } from './types';

export class RerankError extends Error {
  readonly provider: string;
  readonly status: number;

  constructor(provider: string, status: number) {
    super(`[RAG Rerank] ${provider} failed (${status})`);
    this.name = 'RerankError';
    this.provider = provider;
    this.status = status;
  }
}

export interface ScoreRow {
  index: number;
  score: number;
  spans?: RerankSpan[];
}

/** Every input index 0..n-1 must appear exactly once with a finite score. */
export function completeScores(n: number, rows: ScoreRow[]): RerankScore[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('[RAG Rerank] invalid document count');
  }
  if (rows.length !== n) {
    throw new Error(`[RAG Rerank] incomplete rerank response: expected ${n} scores, got ${rows.length}`);
  }
  const seen = new Set<number>();
  const scores: RerankScore[] = [];
  for (const row of rows) {
    if (!Number.isInteger(row.index) || row.index < 0 || row.index >= n) {
      throw new Error(`[RAG Rerank] rerank index out of range: ${row.index}`);
    }
    if (seen.has(row.index)) {
      throw new Error(`[RAG Rerank] duplicate rerank index: ${row.index}`);
    }
    seen.add(row.index);
    if (!Number.isFinite(row.score)) {
      throw new Error(`[RAG Rerank] non-finite rerank score at index ${row.index}`);
    }
    scores.push({
      index: row.index,
      score: row.score,
      ...(row.spans !== undefined ? { spans: row.spans } : {}),
    });
  }
  if (seen.size !== n) {
    throw new Error(`[RAG Rerank] incomplete rerank response: missing indexes`);
  }
  return scores.sort((a, b) => a.index - b.index);
}