export interface ChunkWithScore {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
  rerankScore?: number;
  metadata?: Record<string, any>;
}

export interface RerankOptions {
  topK?: number;
  includeScores?: boolean;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function calculateBM25Score(
  query: string,
  document: string,
  avgDocLength: number,
  totalDocs: number,
  docFrequencies: Map<string, number>,
): number {
  const k1 = 1.2;
  const b = 0.75;

  const queryTerms = tokenize(query);
  const docTerms = tokenize(document);
  const docLength = docTerms.length;

  const termFreq = new Map<string, number>();
  docTerms.forEach((term) => {
    termFreq.set(term, (termFreq.get(term) || 0) + 1);
  });

  let score = 0;
  queryTerms.forEach((term) => {
    const tf = termFreq.get(term) || 0;
    if (tf === 0) return;

    const df = docFrequencies.get(term) || 1;
    const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5));
    const normalizedTF = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));

    score += idf * normalizedTF;
  });

  return score;
}

function calculateDocumentStats(chunks: ChunkWithScore[]): { avgDocLength: number; docFrequencies: Map<string, number> } {
  let totalLength = 0;
  const docFrequencies = new Map<string, number>();
  const processedTerms = new Set<string>();

  chunks.forEach((chunk) => {
    const terms = tokenize(chunk.content);
    totalLength += terms.length;

    processedTerms.clear();
    terms.forEach((term) => {
      if (!processedTerms.has(term)) {
        docFrequencies.set(term, (docFrequencies.get(term) || 0) + 1);
        processedTerms.add(term);
      }
    });
  });

  return { avgDocLength: totalLength / chunks.length, docFrequencies };
}

function bm25Rerank(query: string, chunks: ChunkWithScore[], options: RerankOptions = {}): ChunkWithScore[] {
  const { topK = 5, includeScores = true } = options;

  if (chunks.length === 0) return [];
  if (chunks.length <= topK) return chunks;

  const { avgDocLength, docFrequencies } = calculateDocumentStats(chunks);
  const totalDocs = chunks.length;

  const rankedChunks: ChunkWithScore[] = chunks.map((chunk) => ({
    ...chunk,
    rerankScore: calculateBM25Score(query, chunk.content, avgDocLength, totalDocs, docFrequencies),
  }));

  rankedChunks.sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));

  const topChunks = rankedChunks.slice(0, topK);
  if (!includeScores) {
    topChunks.forEach((chunk) => delete chunk.rerankScore);
  }

  return topChunks;
}

function keywordBoostRerank(query: string, chunks: ChunkWithScore[], options: RerankOptions = {}): ChunkWithScore[] {
  const { topK = 5, includeScores = true } = options;

  if (chunks.length <= topK) return chunks;

  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);

  const phrases: string[] = [];
  for (let n = Math.min(3, queryWords.length); n >= 1; n--) {
    for (let i = 0; i <= queryWords.length - n; i++) {
      phrases.push(queryWords.slice(i, i + n).join(' '));
    }
  }

  const rankedChunks: ChunkWithScore[] = chunks.map((chunk) => {
    const contentLower = chunk.content.toLowerCase();
    let keywordScore = 0;
    let matchCount = 0;

    phrases.forEach((phrase) => {
      const weight = phrase.split(' ').length;
      const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      const matches = (contentLower.match(regex) || []).length;

      if (matches > 0) {
        matchCount += matches;
        keywordScore += matches * weight * weight;
      }
    });

    const normalizedScore = Math.min(keywordScore / (phrases.length * 2), 1);
    const combinedScore = chunk.similarity * 0.6 + normalizedScore * 0.4;

    return {
      ...chunk,
      rerankScore: combinedScore,
      metadata: {
        ...chunk.metadata,
        keywordMatches: matchCount,
      },
    };
  });

  rankedChunks.sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));

  const topChunks = rankedChunks.slice(0, topK);
  if (!includeScores) {
    topChunks.forEach((chunk) => delete chunk.rerankScore);
  }

  return topChunks;
}

export function hybridRerank(query: string, chunks: ChunkWithScore[], options: RerankOptions = {}): ChunkWithScore[] {
  const { topK = 5, includeScores = true } = options;

  if (chunks.length <= topK) return chunks;

  const bm25Results = bm25Rerank(query, chunks, { topK: chunks.length, includeScores: true });
  const keywordResults = keywordBoostRerank(query, chunks, { topK: chunks.length, includeScores: true });

  const bm25Scores = new Map(bm25Results.map((c) => [c.chunk_id, c.rerankScore || 0]));
  const keywordScores = new Map(keywordResults.map((c) => [c.chunk_id, c.rerankScore || 0]));

  const maxBM25 = Math.max(...Array.from(bm25Scores.values()));
  const maxKeyword = Math.max(...Array.from(keywordScores.values()));

  const hybridResults: ChunkWithScore[] = chunks.map((chunk) => {
    const bm25Score = (bm25Scores.get(chunk.chunk_id) || 0) / (maxBM25 || 1);
    const keywordScore = (keywordScores.get(chunk.chunk_id) || 0) / (maxKeyword || 1);
    const semanticScore = chunk.similarity;

    const semanticWeight = parseFloat(process.env.ENHANCED_RAG_SEMANTIC_WEIGHT || '0.8');
    const keywordWeight = parseFloat(process.env.ENHANCED_RAG_KEYWORD_WEIGHT || '0.2');

    const hybridScore = semanticScore * semanticWeight + bm25Score * (keywordWeight * 0.6) + keywordScore * (keywordWeight * 0.4);

    return {
      ...chunk,
      rerankScore: hybridScore,
      metadata: {
        ...chunk.metadata,
        scoreBreakdown: {
          semantic: semanticScore,
          bm25: bm25Score,
          keyword: keywordScore,
          weights: { semantic: semanticWeight, keyword: keywordWeight },
        },
      },
    };
  });

  hybridResults.sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));

  const topChunks = hybridResults.slice(0, topK);
  if (!includeScores) {
    topChunks.forEach((chunk) => {
      delete chunk.rerankScore;
      delete chunk.metadata?.scoreBreakdown;
    });
  }

  return topChunks;
}
