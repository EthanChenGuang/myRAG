import crypto from 'node:crypto';
import type { ModelMessage } from 'ai';
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { validateRequest } from '@/lib/api-middleware';
import {
  CORE_STAGES,
  countTokens,
  createCitationSession,
  createTraceCollector,
  detectLanguage,
  evalScope,
  finishTrace,
  groundednessEligibility,
  LEXICAL_VERSION,
  OPTIONAL_STAGES,
  parseRetrievalFilters,
  readGenerationConfig,
  injectionTraceVersions,
  RERANK_TEXT_VERSION,
  runRetrieval,
  scopeKey,
  scoreAnswerGroundedness,
  type AnswerGroundedness,
  type CitationSession,
  type ClaudeTurnFacts,
  type RetrievalFilterInput,
  type RetrievalResult,
  type StageName,
  type StageOverrides,
} from '@/lib/rag';
import { RagRunRequestSchema, RagTraceSchema, type RagRunRequest } from '@/lib/rag-eval/contracts.generated';
import { checkEvalAccess } from '@/lib/rag-eval/auth';
import { buildEffectiveConfig, configHash } from '@/lib/rag-eval/trace';
import {
  evalGroundednessRequest,
  generateEvalAnswer,
  isGPTGeneratorModel,
  resolveEvalPromptTemplate,
  resolveGeneratorModel,
  type EvalConversationTurn,
} from '@/lib/rag-eval/answer';
import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';

export const runtime = 'nodejs';

type RetrievalOverridesInput = NonNullable<RagRunRequest['options']>['retrieval_overrides'];
type RetrievalFiltersInput = NonNullable<RagRunRequest['options']>['retrieval_filters'];
type RetrievalOverrides = NonNullable<StageOverrides['retrievalOverrides']>;

function toRetrievalOverrides(input: RetrievalOverridesInput | undefined): RetrievalOverrides | undefined {
  if (!input) return undefined;
  const out: RetrievalOverrides = {};
  if (input.candidate_pool_size != null) out.candidatePoolSize = input.candidate_pool_size;
  if (input.rerank_input_cap != null) out.rerankInputCap = input.rerank_input_cap;
  if (input.final_top_k != null) out.finalTopK = input.final_top_k;
  if (input.rrf_k != null) out.rrfK = input.rrf_k;
  if (input.leg_weights != null) {
    out.legWeights = { dense: input.leg_weights.dense, lexical: input.leg_weights.lexical, exactId: input.leg_weights.exact_id };
  }
  if (input.rerank_model != null) out.rerankModel = input.rerank_model;
  if (input.chunking_profile_by_doc_type && Object.keys(input.chunking_profile_by_doc_type).length > 0) {
    out.chunkingProfileByDocType = { ...input.chunking_profile_by_doc_type };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toFilterBody(input: NonNullable<RetrievalFiltersInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.date_range != null) body.dateRange = { from: input.date_range.from, to: input.date_range.to };
  if (input.sources != null) body.sources = input.sources;
  if (input.document_ids != null) body.documentIds = input.document_ids;
  if (input.doc_types != null) body.docTypes = input.doc_types;
  if (input.languages != null) body.languages = input.languages;
  if (input.invoice != null) {
    body.invoice = {
      supplier: input.invoice.supplier,
      amountMin: input.invoice.amount_min,
      amountMax: input.invoice.amount_max,
      currency: input.invoice.currency,
    };
  }
  return body;
}

const REGISTERED_STAGES: ReadonlySet<string> = new Set<string>([...CORE_STAGES, ...OPTIONAL_STAGES]);

function isRegisteredStage(name: string): name is StageName {
  return REGISTERED_STAGES.has(name);
}

function toStageOverrides(options: RagRunRequest['options']): StageOverrides | undefined {
  const disabledStages = options?.disabled_stages?.flatMap((name) => (isRegisteredStage(name) ? [name] : []));
  const timeouts = Object.fromEntries(
    Object.entries(options?.stage_timeouts_ms ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
  const hasTimeouts = Object.keys(timeouts).length > 0;
  const retrievalOverrides = toRetrievalOverrides(options?.retrieval_overrides);
  if (!disabledStages?.length && !hasTimeouts && !retrievalOverrides) return undefined;
  return {
    ...(disabledStages?.length ? { disabledStages } : {}),
    ...(hasTimeouts ? { timeouts } : {}),
    ...(retrievalOverrides ? { retrievalOverrides } : {}),
  };
}

type RefusalReason = 'no_relevant_context' | 'below_threshold' | 'below_similarity_floor';

function refusalReasonOf(result: RetrievalResult, refused: boolean): RefusalReason | null {
  if (!refused) return null;
  const record = result.refusal;
  if (record?.decision === 'refuse') {
    const reason: string = record.reason;
    if (reason === 'below_threshold') return 'below_threshold';
    if (reason === 'below_similarity_floor') return 'below_similarity_floor';
    if (record.basis === 'rerank_threshold') return 'below_threshold';
    if (record.basis === 'similarity_floor') return 'below_similarity_floor';
  }
  return 'no_relevant_context';
}

function stageCountsOf(stages: RetrievalResult['stages']): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const stage of stages) {
    if (stage.counts && Object.keys(stage.counts).length > 0) out[stage.name] = { ...stage.counts };
  }
  return out;
}

function v2TraceFields(result: RetrievalResult) {
  const record = result.refusal;
  return {
    retrieval_config_hash: result.retrievalConfigHash ?? null,
    context_tokens: countTokens(result.context),
    query_language: result.queryLanguage ?? null,
    retrieval_versions: { lexical: LEXICAL_VERSION, rerank_text: RERANK_TEXT_VERSION },
    refusal: record
      ? {
          decision: record.decision,
          basis: record.basis,
          reason: record.reason,
          top_score: record.topScore,
          threshold: record.threshold,
          cell_key: record.cellKey,
        }
      : null,
  };
}


/** An eval turn is a single question with no tools, MCP or attachments; reasoning is not requested. */
const EVAL_CLAUDE_FACTS: ClaudeTurnFacts = { mcp: false, multiStep: false, webSearch: false, reasoning: false, attachments: false };

const NO_CITATIONS: CitationRecord[] = [];

interface CitationTraceFields {
  citations: CitationRecord[];
  citation_strategy: NonNullable<CitationSession['strategy']>;
  invalid_citations: number;
}

function citationTraceFields(session: CitationSession | null): CitationTraceFields | null {
  if (!session?.strategy) return null;
  const records = session.fullRecords();
  if (!records) return null;
  return { citations: records.citations, citation_strategy: session.strategy, invalid_citations: records.invalidCitations };
}

function errorDetail(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? `${name} (HTTP ${status})` : name;
}

/** D-09 and D-10 in the eval: the direct Claude call; a failure before any text falls back to chunk-alias once. */
async function generateClaudeAnswer(input: {
  session: CitationSession;
  query: string;
  conversation: EvalConversationTurn[];
  signal: AbortSignal;
}): Promise<string | null> {
  const { session } = input;
  let streamError: unknown = null;
  try {
    const history: ModelMessage[] = session.stripHistory(
      input.conversation.map((turn) => ({ role: turn.role, content: turn.content })),
    ) as ModelMessage[];
    const stream = session.startClaude({
      system: session.claudeSystemPrompt(resolveEvalPromptTemplate()),
      history,
      question: input.query,
      reasoning: false,
      abortSignal: input.signal,
      onError(error) {
        streamError = error;
      },
    });
    const text = await stream.result.text;
    if (text.length > 0) return text;
  } catch (error: unknown) {
    streamError = error;
  }
  console.warn('[RAG Eval] Claude citations call failed, falling back to chunk-alias:', streamError ? errorDetail(streamError) : 'empty');
  session.fallback('error');
  return null;
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

  let retrievalFilters: RetrievalFilterInput | undefined;
  if (options?.retrieval_filters) {
    const filtersParsed = parseRetrievalFilters(toFilterBody(options.retrieval_filters));
    if (!filtersParsed.ok) {
      return NextResponse.json({ success: false, error: 'Invalid request data', details: filtersParsed.details }, { status: 400 });
    }
    retrievalFilters = filtersParsed.filters;
  }

  const stageOverrides = toStageOverrides(options);
  const collector = createTraceCollector({ profile: 'eval', tenantKey: scopeKey(scope) });

  try {
    const generatorModel = includeAnswer ? resolveGeneratorModel(options?.generator_model) : null;
    const isGPTModel = generatorModel !== null && isGPTGeneratorModel(generatorModel);
    // D-05: an eval run has the citations capability only when it asks for it, and only when an answer is generated.
    const generationConfig = readGenerationConfig();
    const citationSession =
      generatorModel !== null && options?.citations === true
        ? createCitationSession({
            capabilities: { citations: true },
            ragMode,
            modelId: generatorModel,
            language: detectLanguage(query) ?? 'en',
            config: { ...generationConfig, citations: true },
            facts: EVAL_CLAUDE_FACTS,
          })
        : null;

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
      ...(retrievalFilters ? { retrievalFilters } : {}),
      ...(citationSession?.labeler ? { citationLabeler: citationSession.labeler } : {}),
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
      const refused = result.refusalCandidate || result.refusal?.decision === 'refuse';
      if (generatorModel !== null && !refused) {
        const generationStart = collector.now();
        citationSession?.attach(result);
        try {
          if (citationSession?.strategy === 'claude-citations') {
            answer = await generateClaudeAnswer({ session: citationSession, query, conversation: conversation ?? [], signal: req.signal });
          }
          if (answer === null) {
            answer = await generateEvalAnswer({
              query,
              conversation,
              context: result.context,
              ragMode,
              generatorModel,
              ...(citationSession ? { decorateSystemPrompt: (prompt: string) => citationSession.decorateSystemPrompt(prompt) } : {}),
            });
            citationSession?.ingestFullText(answer);
          }
        } catch (error: unknown) {
          const detail = errorDetail(error);
          console.error('[RAG Eval] generation failed:', detail);
          return NextResponse.json({ error: `generation failed: ${detail}` }, { status: 500 });
        }
        collector.record({ name: 'generation', status: 'ok', startedAt: generationStart, endedAt: collector.now() });
      }
      const citationFields = citationTraceFields(citationSession);

      let groundedness: AnswerGroundedness | null = null;
      if (generatorModel !== null && options?.groundedness === true) {
        // D-14 on the eval route: the run's ragMode and retrieval result decide; the premise is the blocks sent to the model.
        const premiseBlocks = (result.blocks ?? [])
          .filter((block) => !block.isImage)
          .map((block) => ({ alias: block.alias ?? '', text: block.text }));
        const eligibility = groundednessEligibility({
          enabled: true,
          webChatWithCitations: true,
          ragMode,
          retrievalStatus: result.status,
          blockCount: premiseBlocks.length,
          isRefusal: refused || answer === null,
          ghostChat: false,
          toolOutputUsed: false,
        });
        const request = evalGroundednessRequest();
        groundedness = await scoreAnswerGroundedness(
          {
            answerId: crypto.randomUUID(),
            answerText: answer ?? '',
            blocks: premiseBlocks,
            citedAliases: (citationFields?.citations ?? NO_CITATIONS).map((record) => record.alias),
            webSearchTexts: [],
            eligibility,
            multiTenant: deploymentMode === 'multi-tenant',
            config: generationConfig,
          },
          request ? { request } : {},
        );
      }

      const retrievalStrategy = result.stages.find((stage) => stage.name === 'search')?.detail ?? 'unknown';
      const queryContext = result.queryContext;
      const stageCounts = stageCountsOf(result.stages);
      const v2Result = result.retrievalConfigHash !== undefined;
      const effectiveConfig = buildEffectiveConfig({ security: injectionTraceVersions() });
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
          ...(chunk.rerank_score !== undefined ? { rerank_score: chunk.rerank_score } : {}),
          ...(chunk.fused_score !== undefined ? { fused_score: chunk.fused_score } : {}),
          ...(chunk.legs !== undefined ? { legs: chunk.legs } : {}),
          ...(chunk.language !== undefined ? { language: chunk.language } : {}),
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
        refusal_reason: refusalReasonOf(result, refused),
        ...(v2Result ? v2TraceFields(result) : {}),
        ...(Object.keys(stageCounts).length > 0 ? { stage_counts: stageCounts } : {}),
        answer,
        citations: citationFields?.citations ?? NO_CITATIONS,
        ...(citationFields
          ? { citation_strategy: citationFields.citation_strategy, invalid_citations: citationFields.invalid_citations }
          : {}),
        ...(groundedness ? { groundedness } : {}),
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
