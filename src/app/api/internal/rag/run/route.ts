import crypto from 'node:crypto';
import type { ModelMessage } from 'ai';
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { validateRequest } from '@/lib/api-middleware';
import { classifyQuery } from '@/lib/query-classifier';
import {
  answerLanguageOptions,
  appendAnswerLanguage,
  type AnswerLanguageOptions,
  BINDING_DOC_TYPES,
  CORE_STAGES,
  countTokens,
  createCitationSession,
  createTraceCollector,
  awaitPreGenerationDelay,
  traceCacheState,
  type TraceCollector,
  detectLanguage,
  evalScope,
  cacheSourcesFromResult,
  finishTrace,
  groundednessEligibility,
  currentLexicalVersion,
  hashSystemPromptTemplate,
  isCacheHitResult,
  OPTIONAL_STAGES,
  parseRetrievalFilters,
  resolveScopesFilter,
  ScopeFilterError,
  readGenerationConfig,
  injectionTraceVersions,
  RERANK_TEXT_VERSION,
  runRetrieval,
  scopeKey,
  scoreAnswerGroundedness,
  storeCacheAnswerNow,
  topkRedundancy,
  type AnswerGroundedness,
  type CitationSession,
  type ClaudeTurnFacts,
  type RetrievalCacheContext,
  type RetrievalFilterInput,
  type RetrievalOptions,
  type RetrievalResult,
  type StageName,
  type StageOverrides,
} from '@/lib/rag';
import { RagRunRequestSchema, RagTraceSchema, type RagRunRequest, type RagTrace } from '@/lib/rag-eval/contracts.generated';
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
  if (input.table_lookup != null) out.tableLookup = { ...input.table_lookup };
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
  if (input.scopes != null) body.scopes = input.scopes;
  if (input.include_untagged === true) body.includeUntagged = true;
  if (input.versions != null) body.versions = input.versions;
  return body;
}

const REGISTERED_STAGES: ReadonlySet<string> = new Set<string>([...CORE_STAGES, ...OPTIONAL_STAGES]);

function isRegisteredStage(name: string): name is StageName {
  return REGISTERED_STAGES.has(name);
}

type BindingOverrides = Pick<RetrievalOptions, 'embeddingBindings' | 'domainControlLeg'>;
type BindingOverridesResult = { ok: true; value: BindingOverrides } | { ok: false; details: Array<{ path: string; message: string }> };

const BINDING_DOC_TYPE_SET: ReadonlySet<string> = new Set(BINDING_DOC_TYPES);

/** D-22: the generated schema keeps the map's value pattern but not its doc-type keys, so the keys are checked here. */
function toBindingOverrides(options: RagRunRequest['options']): BindingOverridesResult {
  const value: BindingOverrides = {};
  const bindings = options?.embedding_bindings;
  if (bindings) {
    const entries = Object.entries(bindings);
    const details = entries
      .filter(([docType]) => !BINDING_DOC_TYPE_SET.has(docType))
      .map(([docType]) => ({ path: `options.embedding_bindings.${docType.slice(0, 64)}`, message: 'Unknown doc type' }));
    if (entries.length > BINDING_DOC_TYPE_SET.size) {
      details.unshift({ path: 'options.embedding_bindings', message: `At most ${BINDING_DOC_TYPE_SET.size} entries` });
    }
    if (details.length > 0) return { ok: false, details };
    if (entries.length > 0) value.embeddingBindings = Object.fromEntries(entries) as NonNullable<BindingOverrides['embeddingBindings']>;
  }
  if (options?.domain_control_leg) value.domainControlLeg = options.domain_control_leg;
  return { ok: true, value };
}

type QueryLayerOverrides = NonNullable<StageOverrides['queryLayer']>;
type QueryTransformToggles = NonNullable<NonNullable<RagRunRequest['options']>['query_transforms']>;
type QueryTransformSwitchName = keyof NonNullable<QueryLayerOverrides['transforms']>;

const TRANSFORM_SWITCHES: ReadonlyArray<[keyof QueryTransformToggles, QueryTransformSwitchName]> = [
  ['condense', 'condense'],
  ['normalize_dates', 'normalizeDates'],
  ['translate', 'translate'],
  ['expand', 'expand'],
  ['hyde', 'hyde'],
  ['decompose', 'decompose'],
];

function withoutNulls<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== null && entry[1] !== undefined)) as Partial<T>;
}

/** D-38: the eval-only query-layer overrides. Built only here; the pipeline applies them for the eval profile only. */
function toQueryLayerOverrides(options: RagRunRequest['options']): QueryLayerOverrides | undefined {
  if (!options) return undefined;
  const out: QueryLayerOverrides = {};
  if (typeof options.query_layer === 'boolean') out.enabled = options.query_layer;
  if (options.query_framework) out.framework = options.query_framework;
  const transforms: NonNullable<QueryLayerOverrides['transforms']> = {};
  for (const [name, key] of TRANSFORM_SWITCHES) {
    const value = options.query_transforms?.[name];
    if (typeof value === 'boolean') transforms[key] = value;
  }
  if (Object.keys(transforms).length > 0) out.transforms = transforms;
  if (options.semantic_cache) out.semanticCache = options.semantic_cache;
  if (options.query_params) {
    const { query_budget_ms: budget, ...scalars } = options.query_params;
    const params: NonNullable<QueryLayerOverrides['queryParams']> = withoutNulls(scalars);
    const budgetParams = budget ? withoutNulls(budget) : {};
    if (Object.keys(budgetParams).length > 0) params.query_budget_ms = budgetParams;
    if (Object.keys(params).length > 0) out.queryParams = params;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toStageOverrides(options: RagRunRequest['options']): StageOverrides | undefined {
  const disabledStages = options?.disabled_stages?.flatMap((name) => (isRegisteredStage(name) ? [name] : []));
  const timeouts = Object.fromEntries(
    Object.entries(options?.stage_timeouts_ms ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
  const hasTimeouts = Object.keys(timeouts).length > 0;
  const retrievalOverrides = toRetrievalOverrides(options?.retrieval_overrides);
  const queryLayer = toQueryLayerOverrides(options);
  if (!disabledStages?.length && !hasTimeouts && !retrievalOverrides && !queryLayer) return undefined;
  return {
    ...(disabledStages?.length ? { disabledStages } : {}),
    ...(hasTimeouts ? { timeouts } : {}),
    ...(retrievalOverrides ? { retrievalOverrides } : {}),
    ...(queryLayer ? { queryLayer } : {}),
  };
}

type RefusalReason = 'no_relevant_context' | 'below_threshold' | 'below_similarity_floor' | 'injection_filtered';

function refusalReasonOf(result: RetrievalResult, refused: boolean): RefusalReason | null {
  if (!refused) return null;
  // D-09, A-3: the check dropped everything that would have reached the generator.
  if (result.status === 'empty' && result.reason === 'injection_filtered') return 'injection_filtered';
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
    retrieval_versions: { lexical: currentLexicalVersion(), rerank_text: RERANK_TEXT_VERSION },
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

/** D-25 on the eval trace: present only when an answer was generated. */
function timingTraceFields(collector: TraceCollector) {
  const timing = collector.timing();
  if (!timing) return {};
  return {
    ...(timing.ttft_ms !== undefined ? { ttft_ms: timing.ttft_ms } : {}),
    ...(timing.pre_generation_ms !== undefined ? { pre_generation_ms: timing.pre_generation_ms } : {}),
    cache: timing.cache,
  };
}

type TraceInjection = NonNullable<RagTrace['injection']>;

/**
 * D-11, D-14: what injection_check did, per chunk. A referenced section's verdict applies to each of its chunks. The document is the
 * filename the graph read under the request's scope, else the trace's own name for it, else the id.
 */
function injectionTraceOf(result: RetrievalResult, documentNames: ReadonlyMap<string, string>): TraceInjection | null {
  const summary = result.injection;
  if (!summary) return null;
  const checked: TraceInjection['checked'] = [];
  const flagged: TraceInjection['flagged'] = [];
  const seen = new Set<string>();
  const flaggedSeen = new Set<string>();
  for (const item of summary.items ?? []) {
    const document = item.documentName ?? documentNames.get(item.documentId) ?? item.documentId;
    for (const chunkId of item.chunkIds) {
      if (!chunkId) continue;
      if (!seen.has(chunkId)) {
        seen.add(chunkId);
        checked.push({ chunk_id: chunkId, document });
      }
      if (item.flagged && item.detectors.length > 0 && !flaggedSeen.has(chunkId)) {
        flaggedSeen.add(chunkId);
        flagged.push({ chunk_id: chunkId, document, detectors: [...item.detectors], rule_ids: [...item.ruleIds] });
      }
    }
  }
  return {
    mode: summary.mode,
    checked,
    flagged,
    dropped: [...summary.droppedChunkIds],
    downweighted: [...summary.downweightedChunkIds],
    detectors_unavailable: [...summary.detectorsUnavailable],
  };
}

/** An eval turn is a single question with no tools, MCP or attachments; reasoning is not requested. */
const EVAL_CLAUDE_FACTS: ClaudeTurnFacts = { mcp: false, multiStep: false, webSearch: false, reasoning: false, attachments: false };

const NO_CITATIONS: CitationRecord[] = [];

type TraceTransform = NonNullable<RagTrace['query_transforms']>[number];
type TraceTransformName = NonNullable<TraceTransform['transform']>;
type TraceTransformStatus = NonNullable<TraceTransform['status']>;

/** Trace order: the D-05 order of the layer, translate last. */
const TRACE_TRANSFORMS: ReadonlyArray<{ name: TraceTransformName; plan: string; variant: string | null }> = [
  { name: 'condense', plan: 'condense_history', variant: 'condensed' },
  { name: 'normalize_dates', plan: 'normalize_dates', variant: null },
  { name: 'expand', plan: 'expand', variant: 'expanded' },
  { name: 'hyde', plan: 'hyde', variant: 'hyde' },
  { name: 'decompose', plan: 'decompose', variant: 'sub_question' },
  { name: 'translate', plan: 'translate', variant: 'translated' },
];

const TRACE_STATUSES: ReadonlySet<string> = new Set<TraceTransformStatus>(['ok', 'skipped', 'disabled', 'degraded', 'error', 'timeout', 'aborted']);

function traceReason(value: string | null | undefined): string | null {
  return value ? value.slice(0, 64) : null;
}

/**
 * D-38: every transform the query layer considered, with its status and skip reason; the rewrites it searched come first
 * in plan order. A transform without a searched variant has kind 'none' (or 'date_range' for a normalized range). Empty
 * while the layer is off.
 */
function queryTransformsOf(result: RetrievalResult): RagTrace['query_transforms'] {
  const plan = result.queryPlan;
  if (!plan) return [];
  const records = new Map(result.stages.map((stage) => [stage.name as string, stage]));
  const skipped = new Map((plan.skipped ?? []).map((entry) => [entry.transform as string, entry.reason as string]));
  const variants = (plan.variants ?? []).filter((variant) => variant.kind !== 'original');
  const out: TraceTransform[] = [];
  const tail: TraceTransform[] = [];
  // Until the layer handles translate, the Phase 4 slot records it on every v2 request; it counts only when the gate asked for it.
  const gateTranslate = plan.gate.transforms.includes('translate');
  for (const transform of TRACE_TRANSFORMS) {
    const record = transform.name === 'translate' && !gateTranslate ? undefined : records.get(transform.name);
    const planReason = skipped.get(transform.plan);
    const recordStatus = record && TRACE_STATUSES.has(record.status) ? (record.status as TraceTransformStatus) : null;
    const status: TraceTransformStatus | null = recordStatus ?? (planReason ? 'skipped' : null);
    const produced = transform.variant ? variants.filter((variant) => variant.kind === transform.variant) : [];
    if (produced.length > 0) {
      for (const variant of produced) {
        out.push({ kind: variant.kind, text: variant.text, transform: transform.name, status: 'ok', reason: traceReason(planReason) });
      }
      continue;
    }
    if (!status) continue;
    const reason = traceReason(planReason ?? (status === 'ok' ? null : (record?.detail ?? record?.reason)));
    if (transform.name === 'normalize_dates' && plan.date_range && status === 'ok') {
      tail.push({ kind: 'date_range', text: `${plan.date_range.from_date}..${plan.date_range.to_date}`, transform: transform.name, status, reason });
      continue;
    }
    tail.push({ kind: 'none', text: '', transform: transform.name, status, reason });
  }
  return [...out, ...tail];
}

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
  answerLanguage?: AnswerLanguageOptions;
}): Promise<string | null> {
  const { session } = input;
  let streamError: unknown = null;
  try {
    const history: ModelMessage[] = session.stripHistory(
      input.conversation.map((turn) => ({ role: turn.role, content: turn.content })),
    ) as ModelMessage[];
    const stream = session.startClaude({
      system: appendAnswerLanguage(session.claudeSystemPrompt(resolveEvalPromptTemplate()), input.answerLanguage),
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

type TraceCacheState = NonNullable<RagTrace['cache']>;

/** D-38: the eval request asked for the semantic cache (the environment still has to select a backend). */
function cacheOverrideOn(options: RagRunRequest['options']): boolean {
  return options?.semantic_cache !== undefined && options.semantic_cache !== null && options.semantic_cache !== 'off';
}

/** The trace's cache outcome, from the semantic_cache stage record; absent when the stage did not run. */
function evalTraceCacheState(result: RetrievalResult): TraceCacheState | undefined {
  if (isCacheHitResult(result)) return 'hit';
  const record = result.stages.find((stage) => stage.name === 'semantic_cache');
  if (!record) return undefined;
  if (Object.keys(record.counts ?? {}).some((key) => key.startsWith('bypass_'))) return 'bypass';
  if (record.status === 'disabled') return undefined;
  return 'miss';
}

export async function POST(req: NextRequest) {
  const requestReceivedAt = Date.now();
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
  // Plan-check B2: a caller-supplied answer is never accepted on a production server, before any retrieval, check or store.
  if (options?.cache_seed_answer != null && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'cache_seed_answer_not_allowed' }, { status: 403 });
  }

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
    if (retrievalFilters?.scopes) {
      try {
        retrievalFilters = await resolveScopesFilter(retrievalFilters, { scope, signal: req.signal });
      } catch (error) {
        if (!(error instanceof ScopeFilterError)) throw error;
        return NextResponse.json({ success: false, error: error.code, details: error.details }, { status: error.status });
      }
    }
  }

  const bindingOverrides = toBindingOverrides(options);
  if (!bindingOverrides.ok) {
    return NextResponse.json({ success: false, error: 'Invalid request data', details: bindingOverrides.details }, { status: 400 });
  }

  const stageOverrides = toStageOverrides(options);
  const collector = createTraceCollector({ profile: 'eval', tenantKey: scopeKey(scope) });
  // D-16: the request conversation is the history; D-09: classified once at entry, and only while the query layer is on.
  const history = (conversation ?? []).map((turn) => ({ role: turn.role, content: turn.content }));
  const classification = env.RAG_QUERY_LAYER === 'true' ? classifyQuery(query) : undefined;

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

    // D-37/D-38: the key parts of an eval lookup; the pipeline derives the eval entry profile, so no entry reaches chat or embed.
    const cacheOverride = cacheOverrideOn(options);
    const cacheContext: RetrievalCacheContext | undefined = cacheOverride
      ? {
          generatorModel: generatorModel ?? resolveGeneratorModel(options?.generator_model),
          systemPromptHash: hashSystemPromptTemplate(`${resolveEvalPromptTemplate()}\u0000citations:${citationSession?.strategy ?? 'none'}`),
          webSearch: false,
          mcpTools: false,
          chatId: null,
        }
      : undefined;

    const result = await runRetrieval({
      scope,
      query,
      profile: 'eval',
      options: {
        // Unset: each pipeline applies RAG_FINAL_RESULT_COUNT itself (legacy) or keeps its own final top-k (v2).
        ...(options?.max_results != null ? { maxResults: options.max_results } : {}),
        isGPTModel,
        ragMode,
        webSearchEnabled: false,
        ...(options?.degrade ? { degrade: options.degrade } : {}),
        ...(options?.embedding_profile ? { embeddingProfile: options.embedding_profile } : {}),
        ...bindingOverrides.value,
      },
      signal: req.signal,
      trace: collector,
      ...(stageOverrides ? { stageOverrides } : {}),
      ...(retrievalFilters ? { retrievalFilters } : {}),
      ...(citationSession?.labeler ? { citationLabeler: citationSession.labeler } : {}),
      ...(history.length > 0 ? { history } : {}),
      ...(classification ? { classification } : {}),
      ...(cacheContext ? { cacheContext } : {}),
    });

    collector.setCacheState(traceCacheState(result));
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
      const cacheHit = isCacheHitResult(result) ? result.cacheHit : undefined;
      const refused = cacheHit ? cacheHit.answer.is_refusal : result.refusalCandidate || result.refusal?.decision === 'refuse';
      if (cacheHit) {
        if (includeAnswer) answer = cacheHit.answer.answer_text;
      } else if (generatorModel !== null && !refused) {
        // D-25: only a turn that generates records timing, so a retrieval-only run traces as before
        collector.markRequestStart(requestReceivedAt);
        await awaitPreGenerationDelay();
        collector.markGenerationStart();
        const generationStart = collector.now();
        citationSession?.attach(result);
        const answerLanguage = answerLanguageOptions(result);
        try {
          if (citationSession?.strategy === 'claude-citations') {
            answer = await generateClaudeAnswer({
              session: citationSession,
              query,
              conversation: conversation ?? [],
              signal: req.signal,
              ...(answerLanguage ? { answerLanguage } : {}),
            });
          }
          if (answer === null) {
            answer = await generateEvalAnswer({
              query,
              conversation,
              context: result.context,
              ragMode,
              generatorModel,
              ...(citationSession ? { decorateSystemPrompt: (prompt: string) => citationSession.decorateSystemPrompt(prompt) } : {}),
              ...(answerLanguage ? { answerLanguage } : {}),
            });
            citationSession?.ingestFullText(answer);
          }
        } catch (error: unknown) {
          const detail = errorDetail(error);
          console.error('[RAG Eval] generation failed:', detail);
          return NextResponse.json({ error: `generation failed: ${detail}` }, { status: 500 });
        }
        // The eval answer is generated whole, so its first text is the full answer
        if (answer !== null && answer.length > 0) collector.markFirstTextDelta();
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

      if (cacheOverride && !cacheHit && result.cacheTicket && !refused) {
        const answerText = answer ?? options?.cache_seed_answer ?? null;
        if (answerText !== null) {
          const stored = await storeCacheAnswerNow({
            scope,
            ticket: result.cacheTicket,
            traceId: collector.traceId,
            facts: { chatId: null, sourceImages: result.sourceImages.length > 0, retrievalStatus: result.status, answerText, isRefusal: false },
            citations: citationFields?.citations ?? NO_CITATIONS,
            sources: cacheSourcesFromResult(result),
            groundedness: groundedness ? Promise.resolve(groundedness) : null,
          });
          console.log('[RAG Eval] semantic cache store:', { outcome: stored });
        }
      }
      const cacheState = cacheOverride ? evalTraceCacheState(result) : undefined;

      const retrievalStrategy = result.stages.find((stage) => stage.name === 'search')?.detail ?? 'unknown';
      const queryContext = result.queryContext;
      const stageCounts = stageCountsOf(result.stages);
      const v2Result = result.retrievalConfigHash !== undefined;
      const injection = injectionTraceOf(result, documentNames);
      const effectiveConfig = buildEffectiveConfig({ security: injectionTraceVersions() });
      effectiveConfig.generator_model = generatorModel;
      const redundancy = topkRedundancy(result.kept);
      const trace = {
        schema_version: 1 as const,
        item_id: itemId ?? null,
        query,
        query_transforms: queryTransformsOf(result),
        query_plan: result.queryPlan ?? null,
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
        kept: result.kept.map(({ dupClusterId, alsoIn: _alsoIn, ...chunk }) => ({
          ...chunk,
          ...(dupClusterId ? { dup_cluster_id: dupClusterId } : {}),
        })),
        ...(redundancy !== null ? { topk_redundancy: redundancy } : {}),
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
        ...(injection ? { injection } : {}),
        ...(cacheState ? { cache: cacheState } : {}),
        answer,
        citations: citationFields?.citations ?? NO_CITATIONS,
        ...(citationFields
          ? { citation_strategy: citationFields.citation_strategy, invalid_citations: citationFields.invalid_citations }
          : {}),
        ...(groundedness ? { groundedness } : {}),
        ...(answer !== null ? timingTraceFields(collector) : {}),
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
