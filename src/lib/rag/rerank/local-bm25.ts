import { lexicalTokens, queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { rerankerSupportedLanguages } from './languages';
import { completeScores } from './scores';
import type { LocalStatsGroup, LocalStatsProvider, Reranker, RerankOptions, RerankScore } from './types';

const K1 = 1.2;
const B = 0.75;

export const LOCAL_BM25_POOL_MODEL = 'bm25-v2';
/** 04.4-21 D-56: reported only when tenant statistics served, so a refusal cell calibrated for bm25-v2 never applies to it. */
export const LOCAL_BM25_TENANT_MODEL = 'bm25-v3-tenant';

// lexicalTokens is pure for a text without options, and the same chunks are reranked again and again, so their tokens are memoized
// (bounded, oldest entry evicted first). Callers never mutate the arrays.
const DOC_TOKEN_CACHE_LIMIT = 2048;
const docTokenCache = new Map<string, string[]>();

function docTokensOf(doc: string): string[] {
  const cached = docTokenCache.get(doc);
  if (cached) return cached;
  const tokens = lexicalTokens(doc);
  if (docTokenCache.size >= DOC_TOKEN_CACHE_LIMIT) {
    const oldest = docTokenCache.keys().next().value;
    if (oldest !== undefined) docTokenCache.delete(oldest);
  }
  docTokenCache.set(doc, tokens);
  return tokens;
}

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

function normalizedByMax(raw: number[]): number[] {
  const max = Math.max(...raw, 0);
  if (max === 0) return raw.map(() => 0);
  return raw.map((s) => s / max);
}

const UTF8 = new TextEncoder();

/** The term forms rag_lexical_rerank_stats answers (the filter of rag_bm25_search_chunks); any other form makes the pool serve. */
function servableTerm(term: string): boolean {
  return term !== '' && UTF8.encode(term).length <= 255 && !/['\\\s]/.test(term);
}

/**
 * 04.4-21 D-56: BM25 with each document's tenant statistics (chunk count, average length, df clamped to [1, N]); the raw score of a
 * (query, document) pair depends on no other candidate, and the pool maximum only normalizes (order-preserving).
 */
export function bm25ScoresWithStats(queryTokensPerDoc: string[][], docTokens: string[][], statsPerDoc: LocalStatsGroup[]): number[] {
  if (docTokens.length === 0) return [];
  const raw = queryTokensPerDoc.map((queryTerms, index) => {
    const stats = statsPerDoc[index] as LocalStatsGroup;
    const n = stats.chunkCount;
    const avgDocLength = stats.totalLength / n || 1;
    const df = new Map<string, number>();
    for (const term of queryTerms) df.set(term, Math.min(Math.max(stats.df.get(term) ?? 0, 1), n));
    return rawBm25ForDoc(queryTerms, docTokens[index] ?? [], avgDocLength, n, df);
  });
  return normalizedByMax(raw);
}

/** The tenant statistics of every document, or null when any document, group or term cannot be served (the pool serves then). */
async function tenantStatsPerDoc(
  provider: LocalStatsProvider,
  queryTokensPerDoc: string[][],
  docCount: number,
  signal: AbortSignal,
): Promise<LocalStatsGroup[] | null> {
  if (provider.groupByDoc.length !== docCount) return null;
  const groups = new Set<string>();
  for (const group of provider.groupByDoc) {
    if (group === null) return null;
    groups.add(group);
  }
  const terms = new Set<string>();
  for (const tokens of queryTokensPerDoc) for (const term of tokens) terms.add(term);
  if (terms.size === 0) return null;
  for (const term of terms) if (!servableTerm(term)) return null;
  let read: ReadonlyMap<string, LocalStatsGroup> | null;
  try {
    read = await provider.read([...terms], [...groups], signal);
  } catch {
    read = null;
  }
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  if (read === null) return null;
  const perDoc: LocalStatsGroup[] = [];
  for (const group of provider.groupByDoc) {
    const stats = read.get(group as string);
    if (!stats || !(stats.chunkCount > 0) || !(stats.totalLength > 0)) return null;
    perDoc.push(stats);
  }
  return perDoc;
}

export function createLocalBm25Reranker(): Reranker {
  return {
    id: 'local_bm25',
    model: LOCAL_BM25_POOL_MODEL,
    scoreSemantics: 'relative',
    supportedLanguages: rerankerSupportedLanguages('local_bm25'),
    async rerank(query, docs, opts: RerankOptions) {
      if (opts.signal.aborted) {
        throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      const defaultQueryTokens = queryLexicalTokens(query);
      const variantTokens = new Map<string, string[]>();
      const queryTokensPerDoc = docs.map((_, index) => {
        const variant = opts.queryByDoc?.[index];
        if (variant === undefined || variant === '') return defaultQueryTokens;
        let tokens = variantTokens.get(variant);
        if (!tokens) {
          tokens = queryLexicalTokens(variant);
          variantTokens.set(variant, tokens);
        }
        return tokens;
      });
      const docTokens = docs.map(docTokensOf);
      const toScores = (normalized: number[]): RerankScore[] => completeScores(docs.length, normalized.map((score, index) => ({ index, score })));
      if (!opts.localStats) return { scores: toScores(bm25Scores(queryTokensPerDoc, docTokens)) };
      const statsPerDoc = docs.length === 0 ? null : await tenantStatsPerDoc(opts.localStats, queryTokensPerDoc, docs.length, opts.signal);
      if (statsPerDoc === null) return { scores: toScores(bm25Scores(queryTokensPerDoc, docTokens)), localStats: 'pool' };
      return {
        scores: toScores(bm25ScoresWithStats(queryTokensPerDoc, docTokens, statsPerDoc)),
        localStats: 'tenant',
        model: LOCAL_BM25_TENANT_MODEL,
      };
    },
  };
}