import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase';
import { validateRequest } from '@/lib/api-middleware';
import {
  createTraceCollector,
  evalScope,
  fetchAssemblyRows,
  finishTrace,
  runRetrieval,
  scopeKey,
  type AssemblyRows,
  type Candidate,
} from '@/lib/rag';
import { RagRunRequestSchema, RagTraceSchema } from '@/lib/rag-eval/contracts.generated';
import { checkEvalAccess } from '@/lib/rag-eval/auth';
import { buildEffectiveConfig, configHash } from '@/lib/rag-eval/trace';
import { generateEvalAnswer, isGPTGeneratorModel, resolveGeneratorModel } from '@/lib/rag-eval/answer';

export const runtime = 'nodejs';

const EMPTY_ROWS: AssemblyRows = { documents: new Map(), chunkMetadata: new Map() };

async function loadCandidateRows(candidates: Candidate[], signal: AbortSignal): Promise<AssemblyRows> {
  if (candidates.length === 0) return EMPTY_ROWS;
  const adminClient = getSupabaseAdmin();
  if (!adminClient) return EMPTY_ROWS;
  try {
    return await fetchAssemblyRows(candidates, { adminClient, signal });
  } catch (error: unknown) {
    console.error('[RAG Eval] candidate row lookup failed:', error instanceof Error ? error.name : 'Error');
    return EMPTY_ROWS;
  }
}

export async function POST(req: NextRequest) {
  const access = checkEvalAccess(req.headers, {
    nodeEnv: process.env.NODE_ENV,
    endpointEnabled: env.RAG_EVAL_ENDPOINT_ENABLED,
    secret: env.RAG_EVAL_SECRET,
  });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const parsed = await validateRequest(req, RagRunRequestSchema);
  if (!parsed.success) {
    return parsed.response;
  }
  const { query, conversation, options, rag_mode: ragMode, item_id: itemId, include_answer: includeAnswer } = parsed.data;

  const deploymentMode = env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
  const organizationId = deploymentMode === 'multi-tenant' ? (options?.organization_id ?? null) : null;
  const userId = options?.user_id ?? null;
  const scoped = evalScope({ deploymentMode, organizationId, userId, allowedScopes: env.RAG_EVAL_ALLOWED_SCOPES });
  if (!scoped.ok) {
    console.warn('[RAG Eval] scope refused:', { deploymentMode, hasOrganization: !!organizationId, hasUser: !!userId });
    return NextResponse.json({ error: scoped.error }, { status: scoped.status });
  }
  const { scope } = scoped;

  const collector = createTraceCollector({ profile: 'eval', tenantKey: scopeKey(scope) });

  try {
    const generatorModel = includeAnswer ? resolveGeneratorModel(options?.generator_model) : null;
    const isGPTModel = generatorModel !== null && isGPTGeneratorModel(generatorModel);

    const result = await runRetrieval({
      scope,
      query,
      profile: 'eval',
      options: {
        maxResults: options?.max_results ?? parseInt(env.RAG_FINAL_RESULT_COUNT || '25'),
        isGPTModel,
        ragMode,
        webSearchEnabled: false,
      },
      signal: req.signal,
      trace: collector,
    });

    try {
      if (result.status === 'error') {
        console.error('[RAG Eval] retrieval failed:', { reason: result.reason });
        return NextResponse.json({ error: 'retrieval failed', reason: result.reason }, { status: 500 });
      }
      const assembled = result.stages.find((stage) => stage.name === 'assemble');
      if (result.queryContext === null || (assembled && assembled.status !== 'ok' && assembled.status !== 'disabled')) {
        console.error('[RAG Eval] retrieval incomplete:', { status: result.status, reason: result.reason });
        return NextResponse.json({ error: 'retrieval failed', reason: result.reason }, { status: 500 });
      }

      const candidates = result.candidates;
      const rows = await loadCandidateRows(candidates, req.signal);

      let answer: string | null = null;
      const refused = result.refusalCandidate;
      if (generatorModel !== null && !refused) {
        const generationStart = collector.now();
        try {
          answer = await generateEvalAnswer({ query, conversation, context: result.context, ragMode, generatorModel });
        } catch (error: unknown) {
          const name = error instanceof Error ? error.name : 'Error';
          const status = (error as { statusCode?: unknown } | null)?.statusCode;
          const detail = typeof status === 'number' ? `${name} (HTTP ${status})` : name;
          console.error('[RAG Eval] generation failed:', detail);
          return NextResponse.json({ error: `generation failed: ${detail}` }, { status: 500 });
        }
        collector.record({ name: 'generation', status: 'ok', startedAt: generationStart, endedAt: collector.now() });
      }

      const retrievalStrategy = result.stages.find((stage) => stage.name === 'search')?.detail ?? 'unknown';
      const queryContext = result.queryContext;
      const effectiveConfig = buildEffectiveConfig();
      effectiveConfig.generator_model = generatorModel;
      const trace = {
        schema_version: 1 as const,
        item_id: itemId ?? null,
        query,
        query_transforms: [],
        query_context: {
          is_financial_query: queryContext.isFinancialQuery,
          is_temporal_query: queryContext.isTemporalQuery,
          required_precision: queryContext.requiredPrecision,
          search_strategy: queryContext.searchStrategy,
          suggested_threshold: queryContext.suggestedThreshold,
        },
        retrieval_strategy: retrievalStrategy,
        candidates: candidates.map((chunk, index) => ({
          chunk_id: chunk.chunk_id,
          document_id: chunk.document_id,
          document_name: rows.documents.get(chunk.document_id)?.filename ?? null,
          content: chunk.content,
          similarity: chunk.similarity,
          final_score: chunk.final_score ?? null,
          match_reason: chunk.match_reason ?? null,
          has_image: !!(chunk.metadata?.image_url || rows.chunkMetadata.get(chunk.chunk_id)?.image_url),
          rank: index + 1,
        })),
        kept: result.kept,
        used_documents: result.usedDocuments.map((doc) => ({
          document_id: doc.id,
          name: doc.name,
          similarity: doc.similarity ?? null,
          image_url: doc.image_url ?? null,
        })),
        context: result.context,
        refused,
        refusal_reason: refused ? ('no_relevant_context' as const) : null,
        answer,
        citations: [],
        stage_latency_ms: collector.toStageLatency(),
        stage_status: collector.toStageStatus(),
        effective_config: effectiveConfig,
        config_hash: configHash(effectiveConfig),
      };

      const checked = RagTraceSchema.safeParse(trace);
      if (!checked.success) {
        console.error('[RAG Eval] trace contract violation:', checked.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
        return NextResponse.json({ error: 'trace contract violation' }, { status: 500 });
      }

      console.log('[RAG Eval] trace built:', { candidates: candidates.length, kept: result.kept.length, refused });
      return NextResponse.json(checked.data);
    } finally {
      finishTrace(collector, result);
    }
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    console.error('[RAG Eval] retrieval failed:', { name, message });
    return NextResponse.json({ error: `retrieval failed: ${name}` }, { status: 500 });
  }
}
