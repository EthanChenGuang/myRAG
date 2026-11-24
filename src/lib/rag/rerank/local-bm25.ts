import { lexicalTokens, queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { completeScores } from './scores';
import type { Reranker, RerankOptions } from './types';

const K1 = 1.2;
const B = 0.75;

function documentFrequency(docTokens: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    const seen = new Set<string>();
    for (const term of tokens) {
      if (seen.has(term)) continue;
      seen.add(term);
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return df;
}

function rawBm25ForDoc(
  queryTerms: string[],
  docTerms: string[],
  avgDocLength: number,
  totalDocs: number,
  docFrequencies: Map<string, number>,
): number {
  const docLength = docTerms.length;
  const termFreq = new Map<string, number>();
  for (const term of docTerms) {
    termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
  }

  let score = 0;
  for (const term of queryTerms) {
    const tf = termFreq.get(term) ?? 0;
    if (tf === 0) continue;
    const df = docFrequencies.get(term) ?? 1;
    const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5));
    const normalizedTf = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (docLength / avgDocLength)));
    score += idf * normalizedTf;
  }
  return score;
}

/** BM25 over a candidate pool; scores normalized by the pool maximum to [0, 1]. */
export function bm25Scores(queryTokensPerDoc: string[][], docTokens: string[][]): number[] {
  const n = docTokens.length;
  if (n === 0) return [];
  const totalDocs = n;
  const df = documentFrequency(docTokens);
  const totalLength = docTokens.reduce((sum, terms) => sum + terms.length, 0);
  const avgDocLength = totalLength / n || 1;

  const raw = queryTokensPerDoc.map((queryTerms, index) =>
    rawBm25ForDoc(queryTerms, docTokens[index] ?? [], avgDocLength, totalDocs, df),
  );
  const max = Math.max(...raw, 0);
  if (max === 0) return raw.map(() => 0);
  return raw.map((s) => s / max);
}

export function createLocalBm25Reranker(): Reranker {
  return {
    id: 'local_bm25',
    model: 'bm25-v2',
    scoreSemantics: 'relative',
    async rerank(query, docs, opts: RerankOptions) {
      if (opts.signal.aborted) {
        throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      const defaultQueryTokens = queryLexicalTokens(query);
      const queryTokensPerDoc = docs.map((_, index) => {
        const variant = opts.queryByDoc?.[index];
        return variant !== undefined && variant !== '' ? queryLexicalTokens(variant) : defaultQueryTokens;
      });
      const docTokens = docs.map((doc) => lexicalTokens(doc));
      const normalized = bm25Scores(queryTokensPerDoc, docTokens);
      const rows = normalized.map((score, index) => ({ index, score }));
      return { scores: completeScores(docs.length, rows) };
    },
  };
}