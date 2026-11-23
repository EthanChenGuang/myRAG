import { logger } from '@/lib/logger';
import { vectorSearch, type RawChunk, type RpcClient } from '../backend/supabase-rpc';
import { analyzeQuery, validateTemporalMatch, type TemporalQueryContext } from '../query/temporal-query-detector';
import type { TenantScope } from '../tenant/scope';
import type { Candidate } from '../types';

export interface LegacySearchInput {
  query: string;
  embedding: number[];
  queryContext: TemporalQueryContext;
  maxResults: number;
  fallbackToLowerThreshold: boolean;
  scope: TenantScope;
  client: RpcClient;
  signal: AbortSignal;
}

interface SearchEnv {
  scope: TenantScope;
  client: RpcClient;
  signal: AbortSignal;
}

export function legacyAnalyze(query: string): TemporalQueryContext {
  logger.db(`[Enhanced RAG] Analyzing query: "${query}"`);
  const queryContext = analyzeQuery(query);
  logger.db(`[Enhanced RAG] Query analysis: ${queryContext.reasoningText}`);
  logger.db(`[Enhanced RAG] Strategy: ${queryContext.searchStrategy}, Precision: ${queryContext.requiredPrecision}`);
  logger.db(`[Enhanced RAG] Suggested threshold: ${queryContext.suggestedThreshold}`);
  return queryContext;
}

export async function legacySearch(
  input: LegacySearchInput,
): Promise<{ results: Candidate[]; retrievalStrategy: string }> {
  const { embedding, queryContext, maxResults, fallbackToLowerThreshold } = input;
  const searchEnv: SearchEnv = { scope: input.scope, client: input.client, signal: input.signal };

  let results: Candidate[] = [];
  let retrievalStrategy = '';

  switch (queryContext.searchStrategy) {
    case 'exact_match':
      results = await exactMatchRetrieval(embedding, queryContext, maxResults, searchEnv);
      retrievalStrategy = 'Exact Match (Temporal/Financial Precision)';
      break;

    case 'multi_stage':
      results = await multiStageRetrieval(embedding, queryContext, maxResults, searchEnv);
      retrievalStrategy = 'Multi-Stage (Temporal + Financial)';
      break;

    case 'temporal_boost':
      results = await temporalBoostedRetrieval(embedding, queryContext, maxResults, searchEnv);
      retrievalStrategy = 'Temporal Boosted';
      break;

    default:
      results = await semanticOnlyRetrieval(embedding, queryContext, maxResults, searchEnv);
      retrievalStrategy = 'Semantic Only';
  }

  // We check if we have very few results (less than 3) to ensure we provide some context
  if ((results.length === 0 || (results.length < 3 && fallbackToLowerThreshold)) && queryContext.suggestedThreshold > 0.35) {
    logger.db(`[Enhanced RAG] Few or no results found (${results.length}), trying fallback with lower threshold`);
    const fallbackResults = await fallbackRetrieval(embedding, maxResults, searchEnv);

    const existingIds = new Set(results.map((r) => r.chunk_id));
    for (const res of fallbackResults) {
      if (!existingIds.has(res.chunk_id)) {
        results.push(res);
        existingIds.add(res.chunk_id);
      }
    }

    retrievalStrategy += ' + Fallback';
  }

  return { results, retrievalStrategy };
}

export function legacyRank(results: Candidate[], _queryContext: TemporalQueryContext): Candidate[] {
  results.sort((a, b) => b.final_score - a.final_score);

  if (results.length > 0) {
    logger.db(`[Enhanced RAG] Top 3 results:`);
    for (let i = 0; i < Math.min(3, results.length); i++) {
      const r = results[i];
      logger.db(`  ${i + 1}. Score: ${r.final_score.toFixed(3)} | ${r.match_reason}`);
      logger.db(`     Content: "${r.content.substring(0, 100)}..."`);
    }
  }

  return results;
}

async function exactMatchRetrieval(
  queryEmbedding: number[],
  context: TemporalQueryContext,
  maxResults: number,
  searchEnv: SearchEnv,
): Promise<Candidate[]> {
  logger.db(`[Enhanced RAG] Executing exact match retrieval`);

  const threshold = Math.max(context.suggestedThreshold, 0.7);

  const chunks = await vectorSearch(searchEnv.scope, queryEmbedding, Math.min(maxResults * 2, 50), threshold, searchEnv);

  if (!chunks || chunks.length === 0) {
    logger.db(`[Enhanced RAG] No chunks found with threshold ${threshold}`);
    return [];
  }

  const scoredResults = chunks
    .map((chunk) => processChunkResult(chunk, context))
    .filter((result) => {
      if (context.isTemporalQuery && context.requireTemporalMatch) {
        const validation = validateTemporalMatch(result.metadata, context);
        return validation.isValid && validation.score >= 0.8;
      }
      return true;
    })
    .sort((a, b) => b.final_score - a.final_score)
    .slice(0, maxResults);

  logger.db(`[Enhanced RAG] Exact match found ${scoredResults.length} qualifying chunks`);
  return scoredResults;
}

async function multiStageRetrieval(
  queryEmbedding: number[],
  context: TemporalQueryContext,
  maxResults: number,
  searchEnv: SearchEnv,
): Promise<Candidate[]> {
  logger.db(`[Enhanced RAG] Executing multi-stage retrieval`);

  const stage1Threshold = context.suggestedThreshold;
  const stage1Count = maxResults * 2;
  const stage1Chunks = await vectorSearch(searchEnv.scope, queryEmbedding, stage1Count, stage1Threshold, searchEnv);

  if (!stage1Chunks || stage1Chunks.length === 0) {
    logger.db(`[Enhanced RAG] Stage 1 (semantic) found no results`);
    return [];
  }

  const processedResults = stage1Chunks
    .map((chunk) => processChunkResult(chunk, context))
    .filter((result) => {
      if (context.isTemporalQuery) {
        const validation = validateTemporalMatch(result.metadata, context);
        return validation.isValid && validation.score >= 0.5;
      }
      return true;
    })
    .sort((a, b) => b.final_score - a.final_score);

  const finalResults = ensureResultDiversity(processedResults, maxResults);

  logger.db(`[Enhanced RAG] Multi-stage completed: ${stage1Chunks.length} → ${processedResults.length} → ${finalResults.length}`);
  return finalResults;
}

async function temporalBoostedRetrieval(
  queryEmbedding: number[],
  context: TemporalQueryContext,
  maxResults: number,
  searchEnv: SearchEnv,
): Promise<Candidate[]> {
  logger.db(`[Enhanced RAG] Executing temporal boosted retrieval`);

  const chunks = await vectorSearch(searchEnv.scope, queryEmbedding, maxResults * 2, context.suggestedThreshold, searchEnv);

  if (!chunks || chunks.length === 0) {
    return [];
  }

  const results = chunks
    .map((chunk) => processChunkResult(chunk, context))
    .sort((a, b) => b.final_score - a.final_score)
    .slice(0, maxResults);

  logger.db(`[Enhanced RAG] Temporal boost found ${results.length} chunks`);
  return results;
}

async function semanticOnlyRetrieval(
  queryEmbedding: number[],
  context: TemporalQueryContext,
  maxResults: number,
  searchEnv: SearchEnv,
): Promise<Candidate[]> {
  logger.db(`[Enhanced RAG] Executing semantic-only retrieval`);

  const chunks = await vectorSearch(searchEnv.scope, queryEmbedding, maxResults, context.suggestedThreshold, searchEnv);

  if (!chunks || chunks.length === 0) {
    return [];
  }

  const results = chunks.map((chunk) => processChunkResult(chunk, context));
  logger.db(`[Enhanced RAG] Semantic-only found ${results.length} chunks`);
  return results;
}

async function fallbackRetrieval(
  queryEmbedding: number[],
  maxResults: number,
  searchEnv: SearchEnv,
): Promise<Candidate[]> {
  logger.db(`[Enhanced RAG] Executing fallback retrieval with threshold 0.28`);

  const chunks = await vectorSearch(searchEnv.scope, queryEmbedding, maxResults, 0.28, searchEnv);

  if (!chunks || chunks.length === 0) {
    return [];
  }

  const fallbackContext: TemporalQueryContext = {
    isTemporalQuery: false,
    isFinancialQuery: false,
    isSpecificDataQuery: false,
    timeframe: null,
    financialMetrics: [],
    requiredPrecision: 'low',
    suggestedThreshold: 0.28,
    searchStrategy: 'semantic_only',
    requireTemporalMatch: false,
    reasoningText: 'Fallback retrieval',
  };

  const results = chunks.map((chunk) => processChunkResult(chunk, fallbackContext));
  logger.db(`[Enhanced RAG] Fallback found ${results.length} chunks`);
  return results;
}

function processChunkResult(chunk: RawChunk, context: TemporalQueryContext): Candidate {
  const metadata = chunk.metadata || {};

  let finalScore = chunk.similarity;
  const matchReasons = [`similarity: ${chunk.similarity.toFixed(3)}`];

  let temporalScore = 0;
  if (context.isTemporalQuery && context.timeframe) {
    const validation = validateTemporalMatch(metadata, context);
    temporalScore = validation.score;

    if (validation.score > 0.8) {
      finalScore += 0.2;
      matchReasons.push('exact temporal match');
    } else if (validation.score > 0.5) {
      finalScore += 0.1;
      matchReasons.push('partial temporal match');
    }
  }

  let financialScore = 0;
  if (context.isFinancialQuery) {
    const hasFinancialData = metadata.has_financial_data || false;
    const financialEntities = (metadata.financial_entities as unknown[] | undefined) || [];

    if (hasFinancialData && financialEntities.length > 0) {
      financialScore = 0.8;
      finalScore += 0.15;
      matchReasons.push('contains financial data');
    } else if (hasFinancialData) {
      financialScore = 0.5;
      finalScore += 0.05;
      matchReasons.push('financial context');
    }

    const matchingMetrics = context.financialMetrics.filter((metric) =>
      chunk.content.toLowerCase().includes(metric.toLowerCase()),
    );

    if (matchingMetrics.length > 0) {
      finalScore += matchingMetrics.length * 0.05;
      matchReasons.push(`matches: ${matchingMetrics.join(', ')}`);
    }
  }

  if (metadata.is_high_value_chunk) {
    finalScore += 0.05;
    matchReasons.push('high-value chunk');
  }

  return {
    chunk_id: chunk.chunk_id,
    document_id: chunk.document_id,
    content: chunk.content,
    similarity: chunk.similarity,
    metadata: metadata,
    temporal_score: temporalScore,
    financial_score: financialScore,
    final_score: Math.min(finalScore, 1.0),
    match_reason: matchReasons.join(', '),
  };
}

function ensureResultDiversity(results: Candidate[], maxResults: number): Candidate[] {
  const diverse: Candidate[] = [];
  const seenDocuments = new Set<string>();

  for (const result of results) {
    if (diverse.length >= maxResults) break;

    if (diverse.length < maxResults * 0.6) {
      diverse.push(result);
      seenDocuments.add(result.document_id);
    } else if (!seenDocuments.has(result.document_id) || diverse.length < maxResults * 0.8) {
      diverse.push(result);
      seenDocuments.add(result.document_id);
    }
  }

  return diverse;
}
