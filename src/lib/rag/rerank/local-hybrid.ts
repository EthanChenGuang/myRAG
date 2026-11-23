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

export function hybridRerank(_query: string, _chunks: ChunkWithScore[], _options: RerankOptions = {}): ChunkWithScore[] {
  return [];
}
