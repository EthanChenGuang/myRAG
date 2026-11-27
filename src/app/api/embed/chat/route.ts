import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/embed-rate-limit';
import { createUIMessageStream, createUIMessageStreamResponse, streamText, type ModelMessage } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod/v3';
import { appendHistoryNotEvidence, historyNotEvidenceEnabled } from '@/lib/chat/history-not-evidence';
import { classifyQuery } from '@/lib/query-classifier';
import {
  buildHistoryWindow,
  cacheSourcesFromResult,
  createEnhancedRAGPrompt,
  hashSystemPromptTemplate,
  isCacheHitResult,
  isSemanticCacheActive,
  scheduleCacheStore,
  streamCachedAnswer,
  answerLanguageOptions,
  type AnswerLanguageOptions,
  createTraceCollector,
  awaitPreGenerationDelay,
  traceCacheState,
  withFirstTextDelta,
  detectLanguage,
  effectiveLogMode,
  finishTrace,
  isQueryLayerEnabled,
  isSmallTalkResult,
  isV2Pipeline,
  createAnswerTurn,
  kbUnavailableLanguage,
  kbUnavailableText,
  readAnswerConfig,
  type AnswerTurn,
  type OutputGuardTurnSources,
  linkUsageInstructions,
  mintEmbedFeedbackToken,
  parseRetrievalFilters,
  resolveScopesFilter,
  ScopeFilterError,
  readFeedbackLoopConfig,
  resolveEmbedScope,
  runRetrieval,
  scopeKey,
  type LogContext,
  type RetrievalFilterInput,
  type RetrievalResult,
  type TraceCollector,
  createCitationLabeler,
  createCalcCheckSink,
  createCalcTraceHolder,
  mayOfferCalc,
  scheduleCalcReviewEnqueue,
  shouldOfferCalcTool,
  type CalcCheckSink,
  answerReserveTokens,
  assertQuestionLast,
  currentDocumentTokenTarget,
  decideOutputCap,
  finalizePromptBudget,
  modelContextLength,
  modelFamily,
  OPENROUTER_COMPRESSION_OFF,
  planPromptBudget,
  PROMPT_BUDGET_EXCEEDED,
  promptTooLongText,
  type BudgetMessage,
  type PromptBudgetPlan,
} from '@/lib/rag';

// Use Node.js runtime instead of Edge
export const runtime = 'nodejs';

// Initialize OpenRouter provider
const openrouterProvider = createOpenRouter({
  apiKey: env.OPENROUTER_API_KEY || '', // Ensure it's not undefined
  baseURL: 'https://openrouter.ai/api/v1',
});

// Log provider initialization to verify it was created correctly
console.log('EMBED API: OpenRouter provider initialized:',
  !!openrouterProvider,
  'with API key starting with:',
  env.OPENROUTER_API_KEY ? `${env.OPENROUTER_API_KEY.substring(0, 7)}...` : 'none'
);

// Request validation schema
const embedChatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string()
  })),
  model: z.string().optional()
});

// D-11: read only while the query layer is on, so the body is handled exactly as before with it off
const embedTimeZoneSchema = z.string().max(64).optional();

const FALLBACK_EMBED_MODEL = 'openai/gpt-4o-mini';
const EMBED_MAX_OUTPUT_TOKENS = 2000;

function defaultEmbedModel(): string {
  return process.env.NEXT_PUBLIC_EMBED_MODEL || env.NEXT_PUBLIC_EMBED_MODEL || FALLBACK_EMBED_MODEL;
}

function allowedEmbedModels(): Set<string> {
  const allowed = new Set<string>([defaultEmbedModel()]);
  try {
    const configured: unknown = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS || '[]');
    if (Array.isArray(configured)) {
      for (const entry of configured) {
        const id = (entry as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && id) allowed.add(id);
      }
    }
  } catch {
    console.warn('[Embed API] NEXT_PUBLIC_OPENROUTER_MODELS is not valid JSON, only the default embed model is allowed');
  }
  return allowed;
}

function resolveEmbedModel(requested: string | undefined): string {
  if (requested && allowedEmbedModels().has(requested)) return requested;
  return defaultEmbedModel();
}

// Helper function to create a proper AI message for errors (same as main chat API)
function createErrorResponse(message: string) {
  // Format the error as a proper token stream similar to what the client expects
  return new Response(
    `3:"${message}"

0:

`,
    {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    }
  );
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function preferredLanguage(request: NextRequest): string {
  const header = request.headers.get('accept-language') || '';
  const primary = header.split(',')[0]?.split(';')[0]?.trim().split('-')[0]?.toLowerCase();
  return primary || 'en';
}

/** Phase 5.2 D-07, D-09: one answer turn per embed request; the Accept-Language is the UI language step. Retrieval mode stays balanced (D-92). */
function embedAnswerTurn(body: unknown, request: NextRequest): AnswerTurn {
  const parsed = embedChatSchema.safeParse(body);
  const history = parsed.success ? parsed.data.messages.filter((message) => message.role !== 'system') : [];
  const question = [...history].reverse().find((message) => message.role === 'user')?.content ?? '';
  return createAnswerTurn({
    config: readAnswerConfig(),
    question,
    history,
    uiLanguage: preferredLanguage(request),
    channel: 'embed',
    ragMode: 'balanced',
  });
}

function knowledgeBaseUnavailableResponse(request: NextRequest, answerTurn: AnswerTurn, collector?: TraceCollector) {
  // D-10: today's text with RAG_REGISTRY_TEXTS off, the registry text in the answer language with it on
  const errorText = kbUnavailableText(answerTurn, preferredLanguage(request));
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: 'error', errorText });
    },
  });
  return createUIMessageStreamResponse({ stream: timeFirstText(stream, collector ?? null), headers: CORS_HEADERS });
}

/** Phase 5.2.1 D-84: the structured prompt_budget_exceeded error, in-band in embed's existing error rendering; never a partial prompt. */
function promptBudgetExceededResponse(request: NextRequest, answerTurn: AnswerTurn, collector?: TraceCollector | null) {
  const errorText = promptTooLongText(answerTurn.answerLanguage, preferredLanguage(request));
  console.warn('[Prompt Budget]', { code: PROMPT_BUDGET_EXCEEDED, channel: 'embed' });
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: 'error', errorText });
    },
  });
  return createUIMessageStreamResponse({ stream: timeFirstText(stream, collector ?? null), headers: CORS_HEADERS });
}

/** D-86: the prompt-budget summary as a span on the request trace, token counts and flags only. */
function recordPromptBudgetSpan(
  collector: TraceCollector,
  trace: PromptBudgetPlan['trace'],
  action: string,
  startedAt: number,
): void {
  collector.record({
    name: 'prompt_budget',
    status: trace.status === 'ok' ? 'ok' : 'error',
    startedAt,
    endedAt: collector.now(),
    counts: {
      ...trace.parts,
      estimated_raw_total: trace.estimated_raw_total,
      dropped_history_turns: trace.dropped_history_turns,
      dropped_documents: trace.dropped_documents,
    },
    attributes: {
      window: trace.window,
      window_source: trace.window_source,
      near_limit: trace.near_limit,
      overflow_mode: trace.overflow_mode,
      action,
    },
  });
}

/** D-25: observes the first answer text delta for the turn's collector; without one the stream is returned as is. */
function timeFirstText<T extends { type: string }>(stream: ReadableStream<T>, collector: TraceCollector | null): ReadableStream<T> {
  return collector ? withFirstTextDelta(stream, () => collector.markFirstTextDelta()) : stream;
}

/** The embed system prompt template before {{context}} substitution. */
function embedSystemPromptTemplate(): string {
  // Use the same system prompt format as the main chat API
  // Get the RAG system prompt from environment (same as main chat)
  let systemPrompt = `You are a helpful AI assistant with access to a knowledge base. When answering questions:

1. If the context contains relevant information, use it to provide accurate and specific answers
2. If information is not available in the context, say so clearly and suggest alternative approaches
3. Always cite your sources when referencing specific documents
4. Provide balanced, objective information rather than opinions
5. For technical topics, include practical steps or examples when appropriate

${linkUsageInstructions()}

Context:
{{context}}`;

  // Use the custom RAG system prompt if available
  if (env.RAG_SYSTEM_PROMPT) {
    try {
      // Safe decode function to handle multiple layers of URL encoding
      let ragPrompt = env.RAG_SYSTEM_PROMPT;
      let previous = '';
      let iterations = 0;
      const maxIterations = 10; // Prevent infinite loops

      // Recursively decode until no more encoding detected
      while (ragPrompt !== previous && ragPrompt.includes('%') && iterations < maxIterations) {
        previous = ragPrompt;
        try {
          ragPrompt = decodeURIComponent(ragPrompt);
          iterations++;
        } catch (e) {
          console.warn('Decoding iteration failed:', e);
          break;
        }
      }

      if (iterations > 0) {
        console.log(`[Embed API] Successfully decoded system prompt after ${iterations} iterations`);
      }

      systemPrompt = ragPrompt;
    } catch (e) {
      console.log('EMBED API: Could not decode RAG_SYSTEM_PROMPT, using default');
    }
  }
  return systemPrompt;
}

export async function POST(request: NextRequest) {
  const requestReceivedAt = Date.now();
  let pendingTrace: { collector: TraceCollector; result: RetrievalResult } | null = null;
  // Set only while RAG_RETRIEVAL_LOG is on; off leaves finishTrace's arguments as they were
  let logContext: LogContext | null = null;
  let logQuery: string | undefined;
  let feedbackTraceId: string | null = null;
  let embedTemplateValue: string | null = null;
  const embedTemplate = () => (embedTemplateValue ??= embedSystemPromptTemplate());
  // Set only when the semantic_cache stage handed out a ticket; the answer is stored after the response (06-36)
  let cacheStore: { result: RetrievalResult; traceId: string } | null = null;
  const finishPendingTrace = () => {
    if (!pendingTrace) return;
    const pending = pendingTrace;
    pendingTrace = null;
    if (logContext) {
      finishTrace(pending.collector, pending.result, { logContext, ...(logQuery !== undefined ? { logQuery } : {}) });
    } else {
      finishTrace(pending.collector, pending.result);
    }
  };

  console.log('EMBED API: POST request received');
  console.log('EMBED API: Environment check:', {
    EMBED_ENABLED: env.NEXT_PUBLIC_EMBED_ENABLED,
    OPENROUTER_KEY_PRESENT: !!env.OPENROUTER_API_KEY,
    OPENROUTER_KEY_LENGTH: env.OPENROUTER_API_KEY?.length || 0
  });

  try {
    // Check if embed is enabled (also allow in demo mode)
    const isDemoMode = env.NEXT_PUBLIC_DEMO_MODE === 'true';
    if (env.NEXT_PUBLIC_EMBED_ENABLED !== 'true' && !isDemoMode) {
      console.log('EMBED API: Embed functionality is disabled');
      return createErrorResponse('Embed functionality is disabled');
    }

    // Domain validation
    const allowedDomains = env.NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS;
    if (allowedDomains !== '*') {
      const domains = allowedDomains.split(',').map((d: string) => d.trim());
      const requestOrigin = request.headers.get('origin');

      if (requestOrigin) {
        const isAllowed = domains.some((domain: string) => {
          if (domain.startsWith('*.')) {
            const baseDomain = domain.substring(2);
            return requestOrigin.endsWith(baseDomain);
          }
          return requestOrigin.includes(domain);
        });

        if (!isAllowed) {
          return createErrorResponse('Domain not allowed');
        }
      }
    }

    // Rate limiting
    const rateLimitId = getRateLimitIdentifier(request);
    const rateLimit = checkRateLimit(rateLimitId);

    if (!rateLimit.allowed) {
      return new NextResponse('Rate limit exceeded', {
        status: 429,
        headers: {
          'X-RateLimit-Limit': env.EMBED_RATE_LIMIT,
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': new Date(rateLimit.resetTime).toISOString(),
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // The workspace check reads the raw body because schema parsing strips unknown keys
    const body = await request.json();
    console.log('EMBED API: Request body:', { messagesCount: body?.messages?.length, model: body?.model });
    const answerTurn = embedAnswerTurn(body, request);

    // Only the v2 pipeline reads this field; under legacy the body is handled exactly as before
    let retrievalFilters: RetrievalFilterInput | undefined;
    if (isV2Pipeline()) {
      const filtersParsed = parseRetrievalFilters(body?.retrievalFilters);
      if (!filtersParsed.ok) {
        return NextResponse.json(
          { success: false, error: 'Invalid request data', details: filtersParsed.details },
          { status: 400, headers: CORS_HEADERS }
        );
      }
      retrievalFilters = filtersParsed.filters;
    }

    const queryLayerOn = isQueryLayerEnabled();
    let clientTimeZone: string | undefined;
    if (queryLayerOn) {
      const timeZoneParsed = embedTimeZoneSchema.safeParse(body?.timeZone);
      if (!timeZoneParsed.success) {
        return NextResponse.json(
          {
            success: false,
            error: 'Invalid request data',
            details: timeZoneParsed.error.errors.map((issue) => ({ path: 'timeZone', message: issue.message })),
          },
          { status: 400, headers: CORS_HEADERS }
        );
      }
      clientTimeZone = timeZoneParsed.data;
    }

    const embedScope = await resolveEmbedScope({
      rawBody: body,
      configuredTenant: env.RAG_EMBED_TENANT,
      signal: request.signal,
    });
    if (!embedScope.ok && embedScope.status === 403) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: CORS_HEADERS });
    }
    if (!embedScope.ok) {
      console.error('[Document Search] Embed knowledge base unavailable:', { status: embedScope.status, reason: embedScope.reason });
      return knowledgeBaseUnavailableResponse(request, answerTurn);
    }

    const streamHeaders = (): Record<string, string> => ({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff',
      'X-RateLimit-Limit': env.EMBED_RATE_LIMIT,
      'X-RateLimit-Remaining': rateLimit.remaining.toString(),
      'X-RateLimit-Reset': new Date(rateLimit.resetTime).toISOString(),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    const embedFeedbackToken = async (): Promise<string | null> => {
      if (!feedbackTraceId || !readFeedbackLoopConfig().embedFeedbackEnabled) return null;
      const tenantKey = scopeKey(embedScope.scope);
      if ((await effectiveLogMode(tenantKey)) === 'off') return null;
      return mintEmbedFeedbackToken({ traceId: feedbackTraceId, tenantKey });
    };

    // D-39: a scopes filter narrows only the configured embed tenant, and only with values of its vocabulary
    if (retrievalFilters?.scopes) {
      try {
        retrievalFilters = await resolveScopesFilter(retrievalFilters, { scope: embedScope.scope, signal: request.signal });
      } catch (error) {
        if (!(error instanceof ScopeFilterError)) throw error;
        return NextResponse.json(
          { success: false, error: error.code, details: error.details },
          { status: error.status, headers: CORS_HEADERS }
        );
      }
    }

    const parsed = embedChatSchema.parse(body);
    const messages = parsed.messages.filter(message => message.role !== 'system');
    const model = resolveEmbedModel(parsed.model);

    const userMessages = messages.filter(m => m.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1];
    const queryText = lastUserMessage?.content || '';

    // Phase 5.2.1 D-65, D-66, D-72: embed offers no tools; a turn that may get the calculation labels its blocks for the trailing block
    const calcMayBeOffered =
      answerTurn.config.calcTool && queryText.trim().length > 0 && mayOfferCalc(queryText, answerTurn.answerLanguage);
    const calcLabeler = calcMayBeOffered ? createCitationLabeler() : undefined;

    // Phase 5.2.1 D-79, D-80, D-82: one plan before retrieval; embed always truncates (D-85: refine is chat only)
    const budgetOn = answerTurn.config.promptBudget && queryText.trim().length > 0;
    const budgetStartedAt = Date.now();
    const budgetHistory: BudgetMessage[] = budgetOn
      ? messages.slice(0, messages.lastIndexOf(lastUserMessage)).map((message) => ({ role: message.role, content: message.content }))
      : [];
    const budgetSystem = budgetOn ? createEnhancedRAGPrompt(embedTemplate(), '', 'strict') : '';
    const planBudget = (answerReserve: number, documentTarget: number): PromptBudgetPlan =>
      planPromptBudget({
        window: modelContextLength(model),
        family: modelFamily(model),
        parts: {
          system: budgetSystem,
          rules: answerTurn.composeSystemPrompt('', {
            mode: 'balanced',
            webSearchOffered: false,
            ...(calcMayBeOffered ? { calculation: { mode: 'trailing_block' as const } } : {}),
          }),
          tools: '',
          question: queryText,
        },
        history: budgetHistory,
        answerReserve,
        documentTarget,
        ...(answerTurn.answerLanguage ? { answerLanguage: answerTurn.answerLanguage } : {}),
        overflowMode: 'truncate',
      });
    // D-31, D-80: the reserve the Phase 5.2 cap gives on a knowledge turn; it is checked again once the cap is decided
    const plannedReserve =
      budgetOn && answerTurn.config.maxOutputTokens.kind !== 'off'
        ? answerReserveTokens({
            decision: decideOutputCap({
              config: answerTurn.config,
              mode: 'balanced',
              knowledgeContext: true,
              userMaxTokens: false,
              reasoning: false,
              approvalContinuation: false,
              channel: 'embed',
            }),
            modelLimit: EMBED_MAX_OUTPUT_TOKENS,
          })
        : EMBED_MAX_OUTPUT_TOKENS;
    let budgetPlan: PromptBudgetPlan | null = budgetOn ? planBudget(plannedReserve, currentDocumentTokenTarget()) : null;
    if (budgetPlan?.status === 'exceeded') return promptBudgetExceededResponse(request, answerTurn);

    let context = '';
    let smallTalkTurn = false;
    let answerLanguage: AnswerLanguageOptions | undefined;
    let retrievalResult: RetrievalResult | null = null;

    if (queryText.trim().length > 0) {
      const isGPTModel = model.includes('gpt-4') || model.includes('o1') || model.includes('chatgpt');
      // D-09/D-16: one classification and a bounded history from the body, only while the query layer is on
      const queryLayerInputs = queryLayerOn
        ? {
            history: buildHistoryWindow(messages),
            classification: classifyQuery(queryText),
            ...(clientTimeZone ? { timeZone: clientTimeZone } : {}),
          }
        : {};
      // CACHE-01: passed only while the semantic cache can run; the pipeline derives the embed entry profile
      const cacheContext = isSemanticCacheActive()
        ? {
            generatorModel: model || 'openai/gpt-4o-mini',
            systemPromptHash: hashSystemPromptTemplate(embedTemplate()),
            webSearch: false,
            mcpTools: false,
            chatId: null,
          }
        : undefined;
      const collector = createTraceCollector({ profile: 'embed', tenantKey: scopeKey(embedScope.scope) });
      const result = await runRetrieval({
        scope: embedScope.scope,
        query: queryText,
        profile: 'embed',
        channel: 'embed',
        options: {
          maxResults: parseInt(env.RAG_FINAL_RESULT_COUNT || '25'),
          fallbackToLowerThreshold: true,
          isGPTModel,
          ragMode: 'balanced',
          webSearchEnabled: false,
          ...(budgetPlan ? { documentTokenBudget: budgetPlan.documentBudget } : {}),
        },
        signal: request.signal,
        trace: collector,
        ...(retrievalFilters ? { retrievalFilters } : {}),
        ...(calcLabeler ? { citationLabeler: calcLabeler } : {}),
        ...queryLayerInputs,
        ...(cacheContext ? { cacheContext } : {}),
      });
      collector.setReviewContent({ query: queryText, context: result.context, model });
      pendingTrace = { collector, result };
      collector.markRequestStart(requestReceivedAt);
      collector.setCacheState(traceCacheState(result));
      feedbackTraceId = collector.traceId;
      if (readFeedbackLoopConfig().retrievalLog !== 'off') {
        logContext = {
          channel: 'embed',
          userId: embedScope.scope.userId,
          organizationId: embedScope.scope.organizationId,
          ragMode: 'balanced',
        };
        logQuery = queryText;
      }

      console.log('[Document Search] Embed retrieval finished:', {
        status: result.status,
        reason: result.reason,
        candidates: result.candidates.length,
        documents: result.usedDocuments.length,
      });

      if (result.status === 'error' || (result.status === 'degraded' && result.usedDocuments.length === 0)) {
        console.error('[Document Search] Embed knowledge base unavailable:', { status: result.status, reason: result.reason });
        if (logContext && result.logOutcome) {
          result.logOutcome.value = 'kb_unavailable';
          result.logOutcome.answerLanguage = kbUnavailableLanguage(answerTurn, preferredLanguage(request));
        }
        finishPendingTrace();
        return knowledgeBaseUnavailableResponse(request, answerTurn, collector);
      }

      // D-32: a hit streams the cached answer with no generation call
      if (isCacheHitResult(result) && result.cacheHit) {
        const cacheHit = result.cacheHit;
        collector.setReviewContent({ answer: cacheHit.answer.answer_text });
        const logOutcome = logContext ? result.logOutcome : undefined;
        if (logOutcome) {
          logOutcome.value = cacheHit.answer.is_refusal ? 'refused_no_context' : 'answered';
          logOutcome.answerLanguage = cacheHit.answer.answer_language;
        }
        const feedbackToken = await embedFeedbackToken();
        finishPendingTrace();
        const stream = createUIMessageStream({
          execute: async ({ writer }) => {
            streamCachedAnswer(cacheHit, { writer, startMetadata: feedbackToken ? { feedbackToken } : {} });
          },
        });
        return createUIMessageStreamResponse({ stream: timeFirstText(stream, collector), headers: streamHeaders() });
      }
      if (result.cacheTicket) cacheStore = { result, traceId: collector.traceId };

      // D-10: small talk under the query layer skipped retrieval and is answered without knowledge-base context
      retrievalResult = result;
      smallTalkTurn = isSmallTalkResult(result);
      context = smallTalkTurn ? '' : result.context;
      answerLanguage = smallTalkTurn ? undefined : answerLanguageOptions(result);
    } else {
      console.log('[Document Search] Embed request has no query text, skipping retrieval');
    }

    const systemPrompt = embedTemplate();

    // D-70, D-72: offered on a knowledge turn whose question or blocks carry the signal; always the trailing block on embed
    let calcOffered = false;
    if (calcMayBeOffered && !smallTalkTurn && context.length > 0 && retrievalResult) {
      const decision = shouldOfferCalcTool({
        question: queryText,
        blockTexts: (retrievalResult.blocks ?? []).filter((block) => !block.isImage).map((block) => block.text),
        language: answerTurn.answerLanguage,
      });
      if (decision.offer) {
        calcOffered = true;
        console.log('[Calc]', { offered: true, mode: 'trailing_block', channel: 'embed', reason: decision.reason });
      }
    }
    const calcHolder = calcOffered ? createCalcTraceHolder() : null;
    // D-73: RAG_CALC_CHECK checks the answer at the end of a stream that offered the calculation
    const calcCheckSink: CalcCheckSink | null = calcOffered && answerTurn.config.calcCheck ? createCalcCheckSink() : null;
    const calcEvidenceBlocks = calcCheckSink ? (retrievalResult?.blocks ?? []).filter((block) => !block.isImage && block.alias) : [];

    // Phase 5.2 D-30: decided once before the composer; embed sends no own limit, no reasoning and no tool approval
    if (answerTurn.config.maxOutputTokens.kind !== 'off') {
      answerTurn.decideOutputCap({
        knowledgeContext:
          !smallTalkTurn &&
          context.length > 0 &&
          (retrievalResult?.status === 'ok' || retrievalResult?.status === 'degraded') &&
          (retrievalResult?.blocks ?? []).some((block) => !block.isImage),
        userMaxTokens: false,
        reasoning: false,
        approvalContinuation: false,
      });
    }

    // Use enhanced RAG prompt for strict RAG-only behavior (same as main chat)
    console.log('[EMBED RAG] Injecting context into system prompt...');
    console.log('[EMBED RAG] Context length:', context.length);
    console.log('[EMBED RAG] System prompt contains {{context}}:', systemPrompt.includes('{{context}}'));

    // Use the same logic as main chat: if context exists, use enhanced prompt
    // This enforces strict RAG-only behavior preventing answers outside knowledge base
    // D-86: the composed answer-rule block, measured on its own by the prompt budget
    let builtRules = '';
    const composeWithRules = (prompt: string): string => {
      const composed = answerTurn.composeSystemPrompt(prompt, {
        mode: 'balanced',
        webSearchOffered: false,
        ...(calcOffered ? { calculation: { mode: 'trailing_block' as const } } : {}),
      });
      if (composed.startsWith(prompt)) builtRules = composed.slice(prompt.length);
      return composed;
    };
    const finalSystemPrompt = smallTalkTurn
      ? createEnhancedRAGPrompt(systemPrompt, '', 'bypass')
      : context.length > 0
        ? appendHistoryNotEvidence(
            // Phase 5.2 D-07, D-92: the strict wrapper stays; the answer rules follow the balanced retrieval mode
            composeWithRules(createEnhancedRAGPrompt(systemPrompt, context, 'strict', answerLanguage)),
            historyNotEvidenceEnabled(env.RAG_HISTORY_NOT_EVIDENCE),
          )
        : systemPrompt.replace('{{context}}', context);

    console.log('[EMBED RAG] Final system prompt preview (first 300 chars):', finalSystemPrompt.substring(0, 300));
    console.log('[EMBED RAG] Using enhanced RAG prompt:', context.length > 0);

    let messagesForModel: ModelMessage[] = [
      { role: 'system', content: finalSystemPrompt },
      ...messages.map((message): ModelMessage => ({ role: message.role, content: message.content })),
    ];

    if (budgetPlan) {
      const collector = pendingTrace?.collector ?? null;
      // D-80: a cap that did not apply after retrieval leaves the fixed limit, so the plan is made again with it
      const reserve = answerTurn.maxOutputTokens(EMBED_MAX_OUTPUT_TOKENS);
      if (reserve > plannedReserve) {
        budgetPlan = planBudget(reserve, 0);
        if (budgetPlan.status === 'exceeded') {
          if (collector) recordPromptBudgetSpan(collector, budgetPlan.trace, 'exceeded', budgetStartedAt);
          finishPendingTrace();
          return promptBudgetExceededResponse(request, answerTurn, collector);
        }
      }
      const buildMessages = (kept: readonly BudgetMessage[]): ModelMessage[] => [
        { role: 'system', content: finalSystemPrompt },
        ...kept.map((message): ModelMessage => ({ role: message.role as 'user' | 'assistant', content: message.content as string })),
        { role: 'user', content: queryText },
      ];
      const documents = smallTalkTurn ? '' : context;
      let builtSystem = documents ? finalSystemPrompt.replace(documents, () => '') : finalSystemPrompt;
      if (builtRules) builtSystem = builtSystem.replace(builtRules, () => '');
      const finalized = finalizePromptBudget(budgetPlan, {
        builtParts: { system: builtSystem, rules: builtRules, documents },
        droppedDocuments: retrievalResult?.packing?.droppedDocuments ?? 0,
      });
      if (collector) recordPromptBudgetSpan(collector, finalized.trace, finalized.action, budgetStartedAt);
      if (finalized.status === 'exceeded') {
        finishPendingTrace();
        return promptBudgetExceededResponse(request, answerTurn, collector);
      }
      // D-82: kept turns oldest-first trimmed, the question last
      messagesForModel = buildMessages(finalized.keptHistory);
      assertQuestionLast(messagesForModel as BudgetMessage[], queryText);
    }

    // Stream the response using OpenRouter (SAME AS MAIN CHAT API)
    console.log('EMBED API: Calling streamText with model:', model);
    console.log('EMBED API: Messages for model:', messagesForModel.length);
    console.log('EMBED API: OpenRouter provider check:', !!openrouterProvider);
    console.log('EMBED API: API key check:', !!env.OPENROUTER_API_KEY);

    // Use a more reliable model name (same as main chat uses)
    const safeModelId = model || 'openai/gpt-4o-mini';
    console.log('EMBED API: Using safe model ID:', safeModelId);

    // Get the provider function for the model (same as main chat)
    const modelProvider = openrouterProvider(safeModelId);

    if (!modelProvider) {
      finishPendingTrace();
      console.error('EMBED API: Failed to get model provider from OpenRouter');
      return createErrorResponse("I'm having trouble connecting to the AI service. The model provider could not be initialized.");
    }

    console.log('EMBED API: Model provider initialized successfully');

    try {
      const timingCollector = pendingTrace?.collector ?? null;
      // Phase 5.2 D-35, D-37, D-40: the guard's allow evidence; the tenant comes from the resolved embed scope only
      const guardSources: OutputGuardTurnSources = {
        blocks: () => (smallTalkTurn || !retrievalResult ? [] : retrievalResult.blocks ?? []),
        serverUrls: () =>
          retrievalResult
            ? [
                ...retrievalResult.usedDocuments.flatMap((doc) => [doc.external_url, doc.image_url]),
                ...retrievalResult.sourceImages.map((image) => image.url),
              ].filter((url): url is string => typeof url === 'string' && url !== '')
            : [],
        contextFlagged: () => retrievalResult?.injection?.flagged === true,
        tenantKey: () => scopeKey(embedScope.scope),
        trace: () => timingCollector,
      };
      // Empty with every Phase 5.2 switch off, so no transform is passed (as today)
      const answerTransforms = answerTurn.transforms([], {
        guard: guardSources,
        // D-72: embed renders no citations, so the block markers the calculation needs are removed from the visible text
        ...(calcHolder ? { calcBlock: { onTrace: calcHolder.recordBlock, stripMarkers: true } } : {}),
        ...(calcHolder && calcCheckSink
          ? {
              calcCheck: {
                holder: calcHolder,
                blocks: calcEvidenceBlocks.map((block) => ({ alias: block.alias ?? '', text: block.text })),
                question: queryText,
                offered: true,
                sink: calcCheckSink,
              },
            }
          : {}),
      });
      await awaitPreGenerationDelay();
      timingCollector?.markGenerationStart();
      const result = await streamText({
        model: modelProvider,
        messages: messagesForModel,
        temperature: 0.1, // Use same temperature as main chat
        // D-30: min(2000, cap) when the cap applies; 2000 otherwise
        maxOutputTokens: answerTurn.maxOutputTokens(EMBED_MAX_OUTPUT_TOKENS),
        // D-84, RESEARCH Pitfall B3: no provider-side truncation while the budget is on
        ...(budgetPlan ? { providerOptions: { openrouter: { plugins: [{ ...OPENROUTER_COMPRESSION_OFF }] } } } : {}),
        ...(answerTransforms.length > 0 ? { experimental_transform: answerTransforms } : {}),
        // Don't include tools for embed API to keep it simple
        onFinish: (event) => {
          pendingTrace?.collector.setReviewContent({ answer: event.text ?? '' });
          const calcRun = calcCheckSink?.result() ?? null;
          if (calcRun && pendingTrace) {
            // D-75, D-61: the calculation check as its own span, status counts and duration only
            const traceCollector = pendingTrace.collector;
            const endedAt = traceCollector.now();
            const counts: Record<string, number> = { calc_checks: calcRun.checks.length };
            for (const check of calcRun.checks) counts[`calc_${check.status}`] = (counts[`calc_${check.status}`] ?? 0) + 1;
            traceCollector.record({
              name: 'calc_check',
              status: calcRun.checks.some((check) => check.reason === 'check_error') ? 'error' : 'ok',
              startedAt: endedAt - calcRun.durationMs,
              endedAt,
              counts,
              attributes: { duration_ms: calcRun.durationMs },
            });
          }
          if (calcRun && calcRun.reviewReasons.length > 0) {
            // D-55: embed has no answer record, so its calculation reasons go to the review queue directly
            scheduleCalcReviewEnqueue({
              tenantKey: scopeKey(embedScope.scope),
              reasons: calcRun.reviewReasons,
              sourceChunkIds: [...new Set(calcEvidenceBlocks.flatMap((block) => block.chunkIds))],
              documentIds: [...new Set(calcEvidenceBlocks.map((block) => block.documentId))],
              traceId: pendingTrace?.collector.traceId ?? null,
              ghost: false,
            });
          }
          const logOutcome = logContext ? pendingTrace?.result.logOutcome : undefined;
          if (logOutcome) logOutcome.answerLanguage = detectLanguage(event.text ?? '');
          finishPendingTrace();
          if (cacheStore && event.finishReason !== 'error') {
            // A-3: embed is check-only unless RAG_SEMANTIC_CACHE_EMBED_STORE is on; the store applies that rule after the response
            scheduleCacheStore({
              scope: embedScope.scope,
              ticket: cacheStore.result.cacheTicket,
              traceId: cacheStore.traceId,
              facts: {
                chatId: null,
                sourceImages: cacheStore.result.sourceImages.length > 0,
                retrievalStatus: cacheStore.result.status,
                answerText: event.text ?? '',
                isRefusal: false,
              },
              sources: cacheSourcesFromResult(cacheStore.result),
            });
          }
        },
        onAbort: () => finishPendingTrace(),
        onError: () => finishPendingTrace(),
      });

      console.log('EMBED API: streamText call successful, streaming to client');
      const answeredOutcome = logContext ? pendingTrace?.result.logOutcome : undefined;
      if (answeredOutcome && answeredOutcome.value === 'unknown') answeredOutcome.value = 'answered';

      // D-11: only with the embed rating enabled and a logged row to rate; otherwise the stream is unchanged
      const feedbackToken = await embedFeedbackToken();

      // Return the AI SDK stream directly (SAME AS MAIN CHAT API)
      // Same composition as result.toUIMessageStreamResponse, with the first text delta observed
      return createUIMessageStreamResponse({
        stream: timeFirstText(
          result.toUIMessageStream(
            feedbackToken ? { messageMetadata: ({ part }) => (part.type === 'start' ? { feedbackToken } : undefined) } : {},
          ),
          timingCollector,
        ),
        headers: streamHeaders(),
      });

    } catch (streamError) {
      finishPendingTrace();
      console.error('=== EMBED API: STREAM ERROR ===');
      console.error('EMBED API: streamText failed:', streamError);
      console.error('EMBED API: streamText error message:', (streamError as Error).message);
      console.error('EMBED API: streamText error type:', (streamError as Error).constructor.name);
      console.error('EMBED API: streamText error stack:', (streamError as Error).stack);

      // Return a more detailed error response for debugging
      const errorDetails = {
        error: (streamError as Error).message,
        type: (streamError as Error).constructor.name,
        hasApiKey: !!env.OPENROUTER_API_KEY,
        keyLength: env.OPENROUTER_API_KEY?.length || 0,
        apiKeyPrefix: env.OPENROUTER_API_KEY ? env.OPENROUTER_API_KEY.substring(0, 10) + '...' : 'none',
        model: model,
        safeModelId: safeModelId
      };

      console.error('EMBED API: Detailed error info:', errorDetails);

      // Return the actual error message for debugging
      const errorMessage = `OpenRouter Error: ${(streamError as Error).message}. Check server console for details.`;
      return createErrorResponse(errorMessage);
    }

  } catch (error) {
    finishPendingTrace();
    console.error('=== EMBED API: MAIN CATCH BLOCK ===');
    console.error('EMBED API: Error occurred:', error);
    console.error('EMBED API: Error type:', error?.constructor?.name);
    console.error('EMBED API: Error message:', (error as Error)?.message);
    console.error('EMBED API: Error stack:', (error as Error)?.stack);

    if (error instanceof z.ZodError) {
      console.log('EMBED API: Zod validation error:', error.errors);
      return createErrorResponse('Validation error - check your message format');
    }

    // Return detailed error in a user-friendly format
    const errorMessage = `I'm having trouble processing your request. Please try again later.`;
    return createErrorResponse(errorMessage);
  }
}

export async function OPTIONS(request: NextRequest) {
  console.log('EMBED API: OPTIONS request received');

  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Vary': 'Origin'
    },
  });
} 
