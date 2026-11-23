import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { RetrievalBackendError } from './backend/supabase-rpc';
import { getRagDeps } from './deps';
import { legacyAnalyze, legacyRank, legacySearch } from './legacy/enhanced-retrieval';
import { assertTenantScope } from './tenant/scope';
import type { Candidate, RetrievalResult, RunRetrievalInput, StageRecord } from './types';

class StageFailure extends Error {
  constructor(
    readonly stage: string,
    readonly reason: string,
  ) {
    super(`[RAG Pipeline] stage ${stage} failed: ${reason}`);
    this.name = 'StageFailure';
  }
}

function emptyResult(traceId: string, status: RetrievalResult['status'], reason: string, stages: StageRecord[]): RetrievalResult {
  return {
    status,
    reason,
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    stages,
    traceId,
    queryContext: null,
  };
}

export async function runRetrieval(input: RunRetrievalInput): Promise<RetrievalResult> {
  const deps = getRagDeps();
  const traceId = deps.randomId();
  const stages: StageRecord[] = [];

  if (input.scope === null) {
    return emptyResult(traceId, 'empty', 'no_tenant', stages);
  }
  assertTenantScope(input.scope);
  const scope = input.scope;
  const { signal } = input;

  const maxResults = input.options?.maxResults ?? parseInt(env.RAG_FINAL_RESULT_COUNT || '25');
  const fallbackToLowerThreshold = input.options?.fallbackToLowerThreshold ?? true;

  let queryContext: RetrievalResult['queryContext'] = null;
  let candidates: Candidate[] = [];

  const stage = async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
    signal.throwIfAborted();
    const startedAt = deps.now();
    try {
      const value = await run();
      stages.push({ name, status: 'ok', durationMs: deps.now() - startedAt });
      return value;
    } catch (error) {
      stages.push({ name, status: 'error', durationMs: deps.now() - startedAt });
      throw error;
    }
  };

  try {
    queryContext = await stage('analyze', () => legacyAnalyze(input.query));
    const analysed = queryContext;

    const embedding = await stage('embed', async () => {
      try {
        return await deps.embedder(input.query, { signal });
      } catch (error) {
        signal.throwIfAborted();
        throw new StageFailure('embed', error instanceof Error ? error.name : 'embed_failed');
      }
    });

    const searched = await stage('search', () =>
      legacySearch({
        query: input.query,
        embedding,
        queryContext: analysed,
        maxResults,
        fallbackToLowerThreshold,
        scope,
        client: deps.anonClient(),
        signal,
      }),
    );

    candidates = await stage('legacy_rank', () => legacyRank(searched.results, analysed));
    const last = stages[stages.length - 1];
    last.detail = searched.retrievalStrategy;
  } catch (error) {
    if (signal.aborted) {
      return { ...emptyResult(traceId, 'error', 'aborted', stages), queryContext };
    }
    if (error instanceof RetrievalBackendError) {
      logger.error('RAG Pipeline', 'Backend error', { rpc: error.rpc, code: error.code });
      return { ...emptyResult(traceId, 'error', 'backend_error', stages), queryContext };
    }
    if (error instanceof StageFailure) {
      logger.error('RAG Pipeline', 'Stage failure', { stage: error.stage, reason: error.reason });
      return { ...emptyResult(traceId, 'error', `${error.stage}_failed`, stages), queryContext };
    }
    throw error;
  }

  if (candidates.length === 0) {
    return { ...emptyResult(traceId, 'empty', 'no_candidates', stages), queryContext };
  }

  return { ...emptyResult(traceId, 'ok', 'ok', stages), candidates, queryContext };
}
