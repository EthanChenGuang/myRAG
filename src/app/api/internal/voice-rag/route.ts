import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { env } from '@/lib/env';
import {
    CALC_REQUEST_JSON_SCHEMA,
    createAnswerTurn,
    createTraceCollector,
    deriveVoiceKeywords,
    finishTrace,
    fixedText,
    labelledUntaggedVoiceContext,
    labelTaggedVoiceContext,
    planPromptBudget,
    promptBudgetConfig,
    readAnswerConfig,
    readFeedbackLoopConfig,
    readSecurityConfig,
    resolveVoiceScope,
    bodyNamesAccessGroups,
    resolveAccessScope,
    runRetrieval,
    scopeKey,
    shouldOfferCalcTool,
    untaggedVoiceContext,
    voiceCalcSources,
    voiceServerCondenses,
    VOICE_SCOPE_HEADER,
    type AnswerConfig,
    type HistoryTurn,
    type RetrievalResult,
} from '@/lib/rag';
import { classifyQuery } from '@/lib/query-classifier';
import { internalApiKeyMatches } from '@/lib/internal-api-key';

export const runtime = 'nodejs';

const MAX_HISTORY_TURNS = 6;
const SERVER_REWRITE_HEADER = 'x-rag-server-query-rewrite';

const historyTurnSchema = z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(1000),
    binding: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

const bodySchema = z.object({
    query: z.string().min(1).max(4000),
    matchCount: z.number().int().min(1).max(20).optional(),
    history: z.array(historyTurnSchema).max(MAX_HISTORY_TURNS).optional(),
    // Phase 5.2.1 D-87: the agent's model window and its own (already trimmed) history size; read only with RAG_PROMPT_BUDGET.
    modelContextLength: z.number().int().min(1024).max(10_000_000).optional(),
    historyTokens: z.number().int().min(0).max(10_000_000).optional(),
});

const BODY_FIELD_ERRORS: Record<string, string> = {
    matchCount: 'Invalid matchCount',
    history: 'Invalid history',
    modelContextLength: 'Invalid modelContextLength',
    historyTokens: 'Invalid historyTokens',
};

/** The session binding of a history turn: the first 22 characters of base64url SHA-256 over the raw scope token. */
function historyBinding(rawToken: string): string {
    return createHash('sha256').update(rawToken, 'utf8').digest('base64url').slice(0, 22);
}

function voiceAnswerTurn(config: AnswerConfig, query: string, history: HistoryTurn[] | undefined) {
    return createAnswerTurn({
        config,
        question: query,
        history: history ?? [],
        uiLanguage: null,
        channel: 'voice',
        ragMode: 'strict',
    });
}

/**
 * Phase 5.2 D-07: the composed voice block (relevance, partial answer, version, output policy; the spoken phrase in place of the
 * sentinel), or '' when no part applies. It is the composer output for an empty prompt, so it starts with a blank line.
 */
function voiceAnswerBlock(turn: ReturnType<typeof voiceAnswerTurn>, contextTagging: boolean): string {
    return turn.composeSystemPrompt('', { mode: 'strict', webSearchOffered: false, contextTagging });
}

interface VoiceCalcOffer {
    offered: true;
    check: boolean;
    sources: ReturnType<typeof voiceCalcSources>;
    tool_schema: unknown;
}

/** Phase 5.2.1 D-70, D-76: the calculation offer for this turn's results, or null (switch off or no offer signal). */
function voiceCalcOffer(
    config: AnswerConfig,
    query: string,
    results: ReadonlyArray<{ chunk_id: string; content: string }>,
    language: string | null,
): VoiceCalcOffer | null {
    if (!config.calcTool) return null;
    const decision = shouldOfferCalcTool({ question: query, blockTexts: results.map((r) => r.content), language });
    if (!decision.offer) return null;
    return { offered: true, check: config.calcCheck, sources: voiceCalcSources(results), tool_schema: CALC_REQUEST_JSON_SCHEMA };
}

interface VoiceBudget {
    status: 'ok' | 'exceeded';
    documentBudget: number;
    counts: Record<string, number>;
}

/**
 * Phase 5.2.1 D-87: the voice document budget. With the agent's window the planner sizes it from the window minus the voice
 * system reserve, the agent-reported history, the question, the voice answer reserve and the margin, capped at the voice
 * budget; without a window it is the fixed voice budget from config/rag/prompt-budget.json.
 */
function voiceBudget(query: string, modelContextLength: number | undefined, historyTokens: number | undefined): VoiceBudget {
    const config = promptBudgetConfig();
    if (modelContextLength === undefined) {
        return { status: 'ok', documentBudget: config.voice_document_budget, counts: { documents: config.voice_document_budget, fixed: 1 } };
    }
    const plan = planPromptBudget({
        window: modelContextLength,
        family: null,
        parts: { system: '', rules: '', tools: '', question: query },
        history: [],
        reservedTokens: { system: config.voice_system_reserve, history: historyTokens ?? 0 },
        answerReserve: config.voice_answer_reserve,
        documentTarget: config.voice_document_budget,
        config,
    });
    const { parts } = plan.trace;
    return {
        status: plan.status,
        documentBudget: plan.documentBudget,
        counts: {
            window: plan.trace.window,
            documents: plan.documentBudget,
            system: parts.system,
            history: parts.history,
            question: parts.question,
            reserve: parts.reserve,
            near_limit: plan.trace.near_limit ? 1 : 0,
            fixed: 0,
        },
    };
}

function fellBack(result: RetrievalResult): boolean {
    return result.stages.some((stage) => stage.name === 'pipeline_fallback');
}

/**
 * Internal API Endpoint for Voice Agent RAG
 *
 * Allows the standalone Node.js Voice Agent to query the Vector DB securely.
 * Protected by MYRAG_INTERNAL_API_KEY plus a server-signed scope token (x-rag-scope-token).
 */
export async function POST(req: NextRequest) {
    try {
        const apiKey = req.headers.get('x-api-key');

        if (!env.MYRAG_INTERNAL_API_KEY) {
            console.error('[Internal RAG] MYRAG_INTERNAL_API_KEY not configured on server');
            return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
        }

        if (!internalApiKeyMatches(apiKey, env.MYRAG_INTERNAL_API_KEY)) {
            console.warn('[Internal RAG] Unauthorized access attempt');
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        let rawBody: unknown;
        try {
            rawBody = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
        }

        // D-06: groups never come from the body; a claim is ignored and logged once per request
        if (bodyNamesAccessGroups(rawBody)) console.warn('[RAG Access] body_group_claim_ignored', { route: 'voice_rag' });

        const parsed = bodySchema.safeParse(rawBody);
        if (!parsed.success) {
            const field = parsed.error.issues[0]?.path[0];
            const error = (typeof field === 'string' ? BODY_FIELD_ERRORS[field] : undefined) ?? 'Missing or invalid query';
            return NextResponse.json({ error }, { status: 400 });
        }
        const { query, matchCount = 5 } = parsed.data;

        const scope = await resolveVoiceScope({ headers: req.headers, signal: req.signal });
        if (!scope.ok) {
            return NextResponse.json({ error: scope.status === 503 ? 'Voice scope unavailable' : 'Unauthorized', reason: scope.reason }, { status: scope.status });
        }

        // D-06, D-08: memberships are read now from the token's actor, never from the token or the body. A refusal keeps the scope
        // unresolved, so retrieval fails closed with status error and the knowledge_base_unavailable answer below applies (D-10).
        const access = await resolveAccessScope({
            scope: scope.scope,
            identity: scope.actorUserId ? { kind: 'user', userId: scope.actorUserId } : { kind: 'anonymous' },
            signal: req.signal,
        });
        const ragScope = access.ok ? access.scope : scope.scope;

        // The answer is produced in the voice agent, so the row carries no answer language (D-03a)
        const logged = readFeedbackLoopConfig().retrievalLog !== 'off';

        // Turns recorded under another scope token (another session, or before a token refresh) never reach the query layer.
        let history: HistoryTurn[] | undefined;
        let trace: ReturnType<typeof createTraceCollector> | undefined;
        if (parsed.data.history) {
            const own = historyBinding(req.headers.get(VOICE_SCOPE_HEADER) ?? '');
            history = parsed.data.history.filter((turn) => turn.binding === own).map(({ role, content }) => ({ role, content }));
            const dropped = parsed.data.history.length - history.length;
            if (dropped > 0) console.warn('[Internal RAG] Dropped history turns bound to another session', { count: dropped });
            trace = createTraceCollector({ profile: 'voice', tenantKey: scopeKey(scope.scope) });
            const at = trace.now();
            trace.record({ name: 'voice_history', status: 'ok', startedAt: at, endedAt: at, counts: { history_kept: history.length, history_dropped: dropped } });
        }

        const answerConfig = readAnswerConfig();
        let answerTurn: ReturnType<typeof voiceAnswerTurn> | undefined;
        const turnOf = () => (answerTurn ??= voiceAnswerTurn(answerConfig, query, history));

        let budget: VoiceBudget | undefined;
        if (answerConfig.promptBudget) {
            budget = voiceBudget(query, parsed.data.modelContextLength, parsed.data.historyTokens);
            if (budget.status === 'exceeded') {
                console.warn('[Internal RAG] Voice prompt budget exceeded', { window: budget.counts.window });
                return NextResponse.json(
                    { error: 'prompt_budget_exceeded', message: fixedText('notices.prompt_too_long', turnOf().answerLanguage ?? '') },
                    { status: 413 },
                );
            }
            trace ??= createTraceCollector({ profile: 'voice', tenantKey: scopeKey(scope.scope) });
        }

        const classification = env.RAG_QUERY_LAYER === 'true' ? classifyQuery(query) : undefined;
        const result = await runRetrieval({
            scope: ragScope,
            query,
            profile: 'voice',
            options: { maxResults: matchCount, ...(budget ? { documentTokenBudget: budget.documentBudget } : {}) },
            signal: req.signal,
            ...(logged
                ? { logContext: { channel: 'voice', userId: scope.scope.userId, organizationId: scope.scope.organizationId } as const }
                : {}),
            ...(history ? { history } : {}),
            ...(classification ? { classification } : {}),
            ...(trace ? { trace } : {}),
        });
        if (trace && budget) {
            const at = trace.now();
            const counts = { ...budget.counts, dropped_documents: result.packing?.droppedDocuments ?? 0 };
            trace.record({ name: 'prompt_budget', status: 'ok', startedAt: at, endedAt: at, counts });
        }
        if (trace) finishTrace(trace, result, { query });
        const headers: Record<string, string> = voiceServerCondenses() && !fellBack(result) ? { [SERVER_REWRITE_HEADER]: '1' } : {};

        const voice = result.voice;
        if (result.status === 'error' || (result.status === 'degraded' && (!voice || voice.results.length === 0))) {
            if (logged && result.logOutcome) result.logOutcome.value = 'kb_unavailable';
            console.error('[Document Search] Voice retrieval unavailable', { status: result.status, reason: result.reason, traceId: result.traceId });
            return NextResponse.json({ error: 'knowledge_base_unavailable', reason: result.reason }, { status: 503, headers });
        }

        if (!voice || voice.results.length === 0) {
            return NextResponse.json({ results: [], traceId: result.traceId }, { headers });
        }

        if (logged && result.logOutcome) result.logOutcome.value = 'answered';
        const keywords = deriveVoiceKeywords(query);
        const contextTagging = readSecurityConfig().contextTagging;
        const taggedContext = contextTagging && typeof voice.context === 'string' && voice.context.trim() !== '' ? voice.context : null;
        const turn = turnOf();
        const calc = voiceCalcOffer(answerConfig, query, voice.results, turn.answerLanguage);
        // The block follows the Phase 5.1 reminder; with tagging off it follows the agent's own context format. '' changes nothing.
        // With the calculation offered each block carries its alias label, the same aliases the agent gives its results (D-76).
        const answerBlock = voiceAnswerBlock(turn, contextTagging);
        const tagged = taggedContext !== null && calc ? labelTaggedVoiceContext(taggedContext) : taggedContext;
        const untagged = () => (calc ? labelledUntaggedVoiceContext(voice.results) : untaggedVoiceContext(voice.results));
        const context = answerBlock !== '' ? `${tagged ?? untagged()}${answerBlock}` : tagged;
        return NextResponse.json({
            results: voice.results,
            source_images: voice.source_images,
            traceId: result.traceId,
            debug_info: process.env.NODE_ENV === 'development' ? {
                cleanQuery: keywords.cleanQuery,
                keywords: keywords.keywords,
                searchKeywords: keywords.searchKeywords
            } : undefined,
            ...(context !== null ? { context } : {}),
            ...(calc ? { calc } : {}),
        }, { headers });

    } catch (error: unknown) {
        console.error('[Internal RAG] Error:', error instanceof Error ? error.message : 'unknown');
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
