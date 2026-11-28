import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/embed-rate-limit';
import { createUIMessageStream, createUIMessageStreamResponse, streamText, type ModelMessage } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod/v3';
import { createLinkUsageInstructions } from '@/lib/url-extractor';
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
  knowledgeBaseUnavailableLanguage,
  knowledgeBaseUnavailableMessage,
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

function knowledgeBaseUnavailableResponse(request: NextRequest, collector?: TraceCollector) {
  const errorText = knowledgeBaseUnavailableMessage(preferredLanguage(request));
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: 'error', errorText });
    },
  });
  return createUIMessageStreamResponse({ stream: timeFirstText(stream, collector ?? null), headers: CORS_HEADERS });
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

${createLinkUsageInstructions()}

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
      return knowledgeBaseUnavailableResponse(request);
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

    let context = '';
    let smallTalkTurn = false;
    let answerLanguage: AnswerLanguageOptions | undefined;

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
        },
        signal: request.signal,
        trace: collector,
        ...(retrievalFilters ? { retrievalFilters } : {}),
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
          result.logOutcome.answerLanguage = knowledgeBaseUnavailableLanguage(preferredLanguage(request));
        }
        finishPendingTrace();
        return knowledgeBaseUnavailableResponse(request, collector);
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
      smallTalkTurn = isSmallTalkResult(result);
      context = smallTalkTurn ? '' : result.context;
      answerLanguage = smallTalkTurn ? undefined : answerLanguageOptions(result);
    } else {
      console.log('[Document Search] Embed request has no query text, skipping retrieval');
    }

    const systemPrompt = embedTemplate();

    // Use enhanced RAG prompt for strict RAG-only behavior (same as main chat)
    console.log('[EMBED RAG] Injecting context into system prompt...');
    console.log('[EMBED RAG] Context length:', context.length);
    console.log('[EMBED RAG] System prompt contains {{context}}:', systemPrompt.includes('{{context}}'));

    // Use the same logic as main chat: if context exists, use enhanced prompt
    // This enforces strict RAG-only behavior preventing answers outside knowledge base
    const finalSystemPrompt = smallTalkTurn
      ? createEnhancedRAGPrompt(systemPrompt, '', 'bypass')
      : context.length > 0
        ? createEnhancedRAGPrompt(systemPrompt, context, 'strict', answerLanguage)
        : systemPrompt.replace('{{context}}', context);

    console.log('[EMBED RAG] Final system prompt preview (first 300 chars):', finalSystemPrompt.substring(0, 300));
    console.log('[EMBED RAG] Using enhanced RAG prompt:', context.length > 0);

    const messagesForModel: ModelMessage[] = [
      { role: 'system', content: finalSystemPrompt },
      ...messages.map((message): ModelMessage => ({ role: message.role, content: message.content })),
    ];

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
      await awaitPreGenerationDelay();
      timingCollector?.markGenerationStart();
      const result = await streamText({
        model: modelProvider,
        messages: messagesForModel,
        temperature: 0.1, // Use same temperature as main chat
        maxOutputTokens: 2000,
        // Don't include tools for embed API to keep it simple
        onFinish: (event) => {
          pendingTrace?.collector.setReviewContent({ answer: event.text ?? '' });
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
