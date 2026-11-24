import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { validateRequest } from '@/lib/api-middleware';
import {
  createTraceCollector,
  evalScope,
  finishTrace,
  runRetrieval,
  scopeKey,
  type StageOverrides,
} from '@/lib/rag';
import { RagRunRequestSchema, RagTraceSchema, type RagRunRequest } from '@/lib/rag-eval/contracts.generated';
import { checkEvalAccess } from '@/lib/rag-eval/auth';
import { buildEffectiveConfig, configHash } from '@/lib/rag-eval/trace';
import { generateEvalAnswer, isGPTGeneratorModel, resolveGeneratorModel } from '@/lib/rag-eval/answer';

export const runtime = 'nodejs';

function toStageOverrides(options: RagRunRequest['options']): StageOverrides | undefined {
  const disabledStages = options?.disabled_stages ?? undefined;
  const timeouts = Object.fromEntries(
    Object.entries(options?.stage_timeouts_ms ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
  const hasTimeouts = Object.keys(timeouts).length > 0;
  if (!disabledStages?.length && !hasTimeouts) return undefined;
  return {
    ...(disabledStages?.length ? { disabledStages } : {}),
    ...(hasTimeouts ? { timeouts } : {}),
  };
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

  const stageOverrides = toStageOverrides(options);
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
        ...(options?.degrade ? { degrade: options.degrade } : {}),
        ...(options?.embedding_profile ? { embeddingProfile: options.embedding_profile } : {}),
      },
      signal: req.signal,
      trace: collector,
      ...(stageOverrides ? { stageOverrides } : {}),
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
      const documentNames = new Map<string, string>();
      for (const doc of result.usedDocuments) documentNames.set(doc.id, doc.filename || doc.name);
      for (const chunk of result.kept) documentNames.set(chunk.document_id, chunk.document_name);

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
          document_name: documentNames.get(chunk.document_id) ?? null,
          content: chunk.content,
          similarity: chunk.similarity,
          final_score: chunk.final_score ?? null,
          match_reason: chunk.match_reason ?? null,
          has_image: !!chunk.metadata?.image_url,
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
      finishTrace(collector, result, { query });
    }
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    console.error('[RAG Eval] retrieval failed:', { name, message });
    return NextResponse.json({ error: `retrieval failed: ${name}` }, { status: 500 });
  }
}
