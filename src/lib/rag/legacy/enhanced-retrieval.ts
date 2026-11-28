import { logger } from '@/lib/logger';
import { searchByEmbedding, type RawChunk, type RpcClient } from '../backend/supabase-rpc';
import { analyzeQuery, validateTemporalMatch, type TemporalQueryContext } from '../query/temporal-query-detector';
import type { TenantScope } from '../tenant/scope';
import type { Candidate } from '../types';

const LEGACY_EXACT_FLOOR = 0.7;
const LEGACY_FALLBACK_THRESHOLD = 0.28;

/**
 * The similarity levels the search stage uses. The analyzer's precision tiers and the exact-match floor are tuned to the legacy model, so
 * a profile's retrieval_threshold anchors them: the tier is multiplied by retrieval_threshold / 0.7 and the exact-match floor becomes
 * retrieval_threshold. fallback_threshold replaces the 0.28 fallback. The legacy values give scale 1 and today's constants.
 */
export interface SearchThresholds {
  scale: number;
  exactFloor: number;
  fallback: number;
}

export const LEGACY_SEARCH_THRESHOLDS: SearchThresholds = Object.freeze({
  scale: 1,
  exactFloor: LEGACY_EXACT_FLOOR,
  fallback: LEGACY_FALLBACK_THRESHOLD,
});

export interface CalibratedProfile {
  id: string;
  scoreCalibration: Record<string, number>;
}

export type SearchProfile = CalibratedProfile & { dims: number; storage: string };

const warnedCalibration = new Set<string>();

function calibrationValue(calibration: Record<string, number>, key: string): number | null {
  const value = calibration[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : null;
}

/** No profile (switch off) gives the legacy constants; a missing or invalid key falls back to the legacy value with one warning. */
export function searchThresholdsFor(profile: CalibratedProfile | null | undefined): SearchThresholds {
  if (!profile) return LEGACY_SEARCH_THRESHOLDS;
  const retrieval = calibrationValue(profile.scoreCalibration, 'retrieval_threshold');
  const fallback = calibrationValue(profile.scoreCalibration, 'fallback_threshold');
  if ((retrieval === null || fallback === null) && !warnedCalibration.has(profile.id)) {
    warnedCalibration.add(profile.id);
    console.warn(
      `[Embedding Profile] CALIBRATION MISSING ${JSON.stringify({ profile: profile.id, retrieval_threshold: retrieval !== null, fallback_threshold: fallback !== null })}`,
    );
  }
  const exactFloor = retrieval ?? LEGACY_EXACT_FLOOR;
  return {
    scale: exactFloor === LEGACY_EXACT_FLOOR ? 1 : exactFloor / LEGACY_EXACT_FLOOR,
    exactFloor,
    fallback: fallback ?? LEGACY_FALLBACK_THRESHOLD,
  };
}

/** Moves a legacy-scale constant onto the profile's scale; identity for the legacy profile. */
export function scaleThreshold(thresholds: SearchThresholds, legacyValue: number): number {
  return thresholds.scale === 1 ? legacyValue : legacyValue * thresholds.scale;
}

export function resetCalibrationWarningsForTests(): void {
  warnedCalibration.clear();
}

export interface LegacySearchInput {
  query: string;
  embedding: number[];
  profile?: SearchProfile | null;
  queryContext: TemporalQueryContext;
  maxResults: number;
  fallbackToLowerThreshold: boolean;
  scope: TenantScope;
  client: RpcClient;
  signal: AbortSignal;
  /** When false, match_chunks_by_profile allows non-active profiles (eval comparison only). */
  profileRequireActive?: boolean;
}

interface SearchEnv {
  scope: TenantScope;
  client: RpcClient;
  signal: AbortSignal;
  profile: SearchProfile | null;
  thresholds: SearchThresholds;
  profileRequireActive: boolean;
}

function evalRpcThreshold(threshold: number, profileRequireActive: boolean): number {
  if (profileRequireActive) return threshold;
  const override = process.env.RAG_EVAL_RETRIEVAL_MIN_SIMILARITY;
  if (override === undefined || override.trim() === '') return threshold;
  const parsed = Number(override);
  return Number.isFinite(parsed) ? parsed : threshold;
}

/** One vector search: rows strictly above rpcThreshold, best similarity first, at most matchCount. */
export interface LegacyPoolPass {
  threshold: number;
  rpcThreshold: number;
  matchCount: number;
}

/** The searches legacySearch runs for a query; the v2 legacy_rule floor replays them over its dense candidates. */
export interface LegacyPoolRule {
  strategy: TemporalQueryContext['searchStrategy'];
  maxResults: number;
  primary: LegacyPoolPass;
  /** Null when the analyser threshold is at or below 0.35: legacy never falls back then. */
  fallback: LegacyPoolPass | null;
  /** The fallback runs when the first pass kept fewer results than this. */
  fallbackBelow: number;
}

export function legacyPoolRule(input: {
  queryContext: TemporalQueryContext;
  thresholds: SearchThresholds;
  maxResults: number;
  fallbackToLowerThreshold: boolean;
  profileRequireActive: boolean;
}): LegacyPoolRule {
  const { queryContext, thresholds, maxResults, fallbackToLowerThreshold, profileRequireActive } = input;
  const pass = (threshold: number, matchCount: number): LegacyPoolPass => ({
    threshold,
    rpcThreshold: evalRpcThreshold(threshold, profileRequireActive),
    matchCount,
  });
  const scaled = scaleThreshold(thresholds, queryContext.suggestedThreshold);
  let primary: LegacyPoolPass;
  switch (queryContext.searchStrategy) {
    case 'exact_match':
      primary = pass(Math.max(scaled, thresholds.exactFloor), Math.min(maxResults * 2, 50));
      break;
    case 'multi_stage':
    case 'temporal_boost':
      primary = pass(scaled, maxResults * 2);
      break;
    default:
      primary = pass(scaled, maxResults);
  }
  return {
    strategy: queryContext.searchStrategy,
    maxResults,
    primary,
    fallback: queryContext.suggestedThreshold > 0.35 ? pass(thresholds.fallback, maxResults) : null,
    fallbackBelow: fallbackToLowerThreshold ? 3 : 1,
  };
}

/** The legacy voice search: one dense pass at a low threshold, five times the answer count, no analyser and no fallback. */
export const LEGACY_VOICE_DEFAULT_MATCH_COUNT = 5;
const LEGACY_VOICE_SEARCH_MULTIPLIER = 5;
const LEGACY_VOICE_SEARCH_THRESHOLD = 0.15;

export function legacyVoicePoolRule(thresholds: SearchThresholds, matchCount: number): LegacyPoolRule {
  const threshold = scaleThreshold(thresholds, LEGACY_VOICE_SEARCH_THRESHOLD);
  const count = matchCount * LEGACY_VOICE_SEARCH_MULTIPLIER;
  return {
    strategy: 'semantic_only',
    maxResults: count,
    primary: { threshold, rpcThreshold: threshold, matchCount: count },
    fallback: null,
    fallbackBelow: 0,
  };
}

const STRATEGY_NAMES: Record<TemporalQueryContext['searchStrategy'], string> = {
  exact_match: 'Exact Match (Temporal/Financial Precision)',
  multi_stage: 'Multi-Stage (Temporal + Financial)',
  temporal_boost: 'Temporal Boosted',
  semantic_only: 'Semantic Only',
};

/** What the strategy keeps of the first search: scoring, the temporal filters, the final count. */
export function legacyFirstPass(rule: LegacyPoolRule, context: TemporalQueryContext, chunks: RawChunk[]): Candidate[] {
  const { maxResults } = rule;
  if (!chunks || chunks.length === 0) {
    if (rule.strategy === 'exact_match') logger.db(`[Enhanced RAG] No chunks found with threshold ${rule.primary.threshold}`);
    if (rule.strategy === 'multi_stage') logger.db(`[Enhanced RAG] Stage 1 (semantic) found no results`);
    return [];
  }
  switch (rule.strategy) {
    case 'exact_match': {
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
    case 'multi_stage': {
      const processedResults = chunks
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
      logger.db(`[Enhanced RAG] Multi-stage completed: ${chunks.length} → ${processedResults.length} → ${finalResults.length}`);
      return finalResults;
    }
    case 'temporal_boost': {
      const results = chunks
        .map((chunk) => processChunkResult(chunk, context))
        .sort((a, b) => b.final_score - a.final_score)
        .slice(0, maxResults);
      logger.db(`[Enhanced RAG] Temporal boost found ${results.length} chunks`);
      return results;
    }
    default: {
      const results = chunks.map((chunk) => processChunkResult(chunk, context));
      logger.db(`[Enhanced RAG] Semantic-only found ${results.length} chunks`);
      return results;
    }
  }
}

export function legacyNeedsFallback(rule: LegacyPoolRule, firstPassCount: number): boolean {
  return rule.fallback !== null && firstPassCount < rule.fallbackBelow;
}

/** Appends the fallback rows the first pass did not already hold, scored without the analyser's boosts. */
export function legacyMergeFallback(results: Candidate[], fallbackChunks: RawChunk[]): Candidate[] {
  const fallbackContext: TemporalQueryContext = {
    isTemporalQuery: false,
    isFinancialQuery: false,
    isSpecificDataQuery: false,
    timeframe: null,
    financialMetrics: [],
    requiredPrecision: 'low',
    suggestedThreshold: LEGACY_FALLBACK_THRESHOLD,
    searchStrategy: 'semantic_only',
    requireTemporalMatch: false,
    reasoningText: 'Fallback retrieval',
  };
  const fallbackResults = (fallbackChunks || []).map((chunk) => processChunkResult(chunk, fallbackContext));
  logger.db(`[Enhanced RAG] Fallback found ${fallbackResults.length} chunks`);
  const merged = [...results];
  const existingIds = new Set(merged.map((r) => r.chunk_id));
  for (const res of fallbackResults) {
    if (!existingIds.has(res.chunk_id)) {
      merged.push(res);
      existingIds.add(res.chunk_id);
    }
  }
  return merged;
}

/** The rows one pass of the vector RPC returns from a candidate list: strictly above the threshold, best first, capped. */
function passOver(rows: readonly RawChunk[], pass: LegacyPoolPass): RawChunk[] {
  return rows
    .filter((row) => Number.isFinite(row.similarity) && row.similarity > pass.rpcThreshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, pass.matchCount);
}

/** The pool legacySearch would return if the vector RPC held exactly these rows. */
export function legacyPoolFromRows(rule: LegacyPoolRule, context: TemporalQueryContext, rows: readonly RawChunk[]): Candidate[] {
  const results = legacyFirstPass(rule, context, passOver(rows, rule.primary));
  if (!legacyNeedsFallback(rule, results.length) || rule.fallback === null) return results;
  return legacyMergeFallback(results, passOver(rows, rule.fallback));
}

function search(env: SearchEnv, vector: number[], pass: LegacyPoolPass): Promise<RawChunk[]> {
  return searchByEmbedding(env.scope, { vector, profile: env.profile }, pass.matchCount, pass.rpcThreshold, {
    client: env.client,
    signal: env.signal,
    requireActive: env.profileRequireActive,
  });
}

export function legacyAnalyze(query: string): TemporalQueryContext {
  logger.db(`[Enhanced RAG] Analyzing query: "${query}"`);
  const queryContext = analyzeQuery(query);
  logger.db(`[Enhanced RAG] Query analysis: ${queryContext.reasoningText}`);
  logger.db(`[Enhanced RAG] Strategy: ${queryContext.searchStrategy}, Precision: ${queryContext.requiredPrecision}`);
  logger.db(`[Enhanced RAG] Suggested threshold: ${queryContext.suggestedThreshold}`);
  return queryContext;
}

const STRATEGY_LOGS: Record<TemporalQueryContext['searchStrategy'], string> = {
  exact_match: 'exact match retrieval',
  multi_stage: 'multi-stage retrieval',
  temporal_boost: 'temporal boosted retrieval',
  semantic_only: 'semantic-only retrieval',
};

export async function legacySearch(
  input: LegacySearchInput,
): Promise<{ results: Candidate[]; retrievalStrategy: string }> {
  const { embedding, queryContext, maxResults, fallbackToLowerThreshold } = input;
  const profile = input.profile ?? null;
  const profileRequireActive = input.profileRequireActive !== false;
  const thresholds = searchThresholdsFor(profile);
  const searchEnv: SearchEnv = {
    scope: input.scope,
    client: input.client,
    signal: input.signal,
    profile,
    thresholds,
    profileRequireActive,
  };
  const rule = legacyPoolRule({ queryContext, thresholds, maxResults, fallbackToLowerThreshold, profileRequireActive });

  logger.db(`[Enhanced RAG] Executing ${STRATEGY_LOGS[rule.strategy]}`);
  let results = legacyFirstPass(rule, queryContext, await search(searchEnv, embedding, rule.primary));
  let retrievalStrategy = STRATEGY_NAMES[rule.strategy];

  // We check if we have very few results (less than 3) to ensure we provide some context
  if (legacyNeedsFallback(rule, results.length) && rule.fallback !== null) {
    logger.db(`[Enhanced RAG] Few or no results found (${results.length}), trying fallback with lower threshold`);
    logger.db(`[Enhanced RAG] Executing fallback retrieval with threshold ${rule.fallback.threshold}`);
    results = legacyMergeFallback(results, await search(searchEnv, embedding, rule.fallback));
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
