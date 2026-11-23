import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { supabase } from '@/lib/supabase';
import { validateRequest } from '@/lib/api-middleware';
import { enhancedRetrieveChunks } from '@/lib/enhanced-rag-retrieval';
import { RagRunRequestSchema, RagTraceSchema } from '@/lib/rag-eval/contracts.generated';
import { checkEvalAccess, checkEvalScope } from '@/lib/rag-eval/auth';
import { applyLegacyPostFilter, type LegacyDocumentRow } from '@/lib/rag-eval/legacy-post-filter';
import { buildEffectiveConfig, configHash } from '@/lib/rag-eval/trace';
import { generateEvalAnswer, isGPTGeneratorModel, resolveGeneratorModel } from '@/lib/rag-eval/answer';

export const runtime = 'nodejs';

type Metadata = Record<string, unknown>;

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
  const scope = checkEvalScope({ deploymentMode, organizationId, userId, allowedScopes: env.RAG_EVAL_ALLOWED_SCOPES });
  if (!scope.ok) {
    console.warn('[RAG Eval] scope refused:', { deploymentMode, hasOrganization: !!organizationId, hasUser: !!userId });
    return NextResponse.json({ error: scope.error }, { status: scope.status });
  }

  try {
    const configuredCount = (env as unknown as Record<string, string | undefined>).RAG_FINAL_RESULT_COUNT;

    const retrievalStart = Date.now();
    const enhancedResult = await enhancedRetrieveChunks(query, {
      maxResults: options?.max_results ?? parseInt(configuredCount || '25'),
      enableTemporalBoost: true,
      enableFinancialBoost: true,
      requireTemporalMatch: false,
      fallbackToLowerThreshold: true,
      organizationId,
      userId,
    });
    const retrievalMs = Date.now() - retrievalStart;

    const postFilterStart = Date.now();
    const candidates = enhancedResult.chunks;
    const documents = new Map<string, LegacyDocumentRow>();
    const chunkMetadata = new Map<string, Metadata | null>();
    const documentLookups = new Set<string>();

    for (const chunk of candidates) {
      if (!documentLookups.has(chunk.document_id)) {
        documentLookups.add(chunk.document_id);
        const { data: docRow, error: docError } = await supabase
          .from('documents')
          .select('id, filename, created_at, content, metadata')
          .eq('id', chunk.document_id)
          .single();
        if (!docError && docRow) {
          documents.set(chunk.document_id, docRow as LegacyDocumentRow);
        }
      }
      if (!documents.has(chunk.document_id)) continue;

      const { data: chunkRow } = await supabase.from('document_chunks').select('metadata').eq('id', chunk.chunk_id).single();
      chunkMetadata.set(chunk.chunk_id, (chunkRow?.metadata as Metadata | null | undefined) ?? null);
    }

    const generatorModel = includeAnswer ? resolveGeneratorModel(options?.generator_model) : null;
    const isGPTModel = generatorModel !== null && isGPTGeneratorModel(generatorModel);

    const filtered = applyLegacyPostFilter({
      queryText: query,
      candidates,
      documents,
      chunkMetadata,
      chunkUrlMetadata: chunkMetadata,
      isGPTModel,
      ragMode,
      webSearchEnabled: false,
    });
    const postFilterMs = Date.now() - postFilterStart;

    const stageLatency: Record<string, number> = { retrieval: retrievalMs, post_filter: postFilterMs };
    let answer: string | null = null;
    if (generatorModel !== null && !filtered.refused) {
      const generationStart = Date.now();
      try {
        answer = await generateEvalAnswer({ query, conversation, context: filtered.context, ragMode, generatorModel });
      } catch (error: unknown) {
        const name = error instanceof Error ? error.name : 'Error';
        const status = (error as { statusCode?: unknown } | null)?.statusCode;
        const detail = typeof status === 'number' ? `${name} (HTTP ${status})` : name;
        console.error('[RAG Eval] generation failed:', detail);
        return NextResponse.json({ error: `generation failed: ${detail}` }, { status: 500 });
      }
      stageLatency.generation = Date.now() - generationStart;
    }

    const effectiveConfig = buildEffectiveConfig();
    effectiveConfig.generator_model = generatorModel;
    const trace = {
      schema_version: 1 as const,
      item_id: itemId ?? null,
      query,
      query_transforms: [],
      query_context: {
        is_financial_query: enhancedResult.queryContext.isFinancialQuery,
        is_temporal_query: enhancedResult.queryContext.isTemporalQuery,
        required_precision: enhancedResult.queryContext.requiredPrecision,
        search_strategy: enhancedResult.queryContext.searchStrategy,
        suggested_threshold: enhancedResult.queryContext.suggestedThreshold,
      },
      retrieval_strategy: enhancedResult.retrievalStrategy,
      candidates: candidates.map((chunk, index) => ({
        chunk_id: chunk.chunk_id,
        document_id: chunk.document_id,
        document_name: documents.get(chunk.document_id)?.filename ?? null,
        content: chunk.content,
        similarity: chunk.similarity,
        final_score: chunk.final_score ?? null,
        match_reason: chunk.match_reason ?? null,
        has_image: !!(chunk.metadata?.image_url || chunkMetadata.get(chunk.chunk_id)?.image_url),
        rank: index + 1,
      })),
      kept: filtered.kept,
      used_documents: filtered.usedDocuments,
      context: filtered.context,
      refused: filtered.refused,
      refusal_reason: filtered.refusalReason,
      answer,
      citations: [],
      stage_latency_ms: stageLatency,
      effective_config: effectiveConfig,
      config_hash: configHash(effectiveConfig),
    };

    const checked = RagTraceSchema.safeParse(trace);
    if (!checked.success) {
      console.error('[RAG Eval] trace contract violation:', checked.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
      return NextResponse.json({ error: 'trace contract violation' }, { status: 500 });
    }

    console.log('[RAG Eval] trace built:', { candidates: candidates.length, kept: filtered.kept.length, refused: filtered.refused });
    return NextResponse.json(checked.data);
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    console.error('[RAG Eval] retrieval failed:', { name, message });
    return NextResponse.json({ error: `retrieval failed: ${name}` }, { status: 500 });
  }
}
