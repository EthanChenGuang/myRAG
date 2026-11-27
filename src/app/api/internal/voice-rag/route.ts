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
    labelledUntaggedVoiceContext,
    labelTaggedVoiceContext,
    readAnswerConfig,
    readFeedbackLoopConfig,
    readSecurityConfig,
    resolveVoiceScope,
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
});

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

        const parsed = bodySchema.safeParse(rawBody);
        if (!parsed.success) {
            const field = parsed.error.issues[0]?.path[0];
            const error = field === 'matchCount' ? 'Invalid matchCount' : field === 'history' ? 'Invalid history' : 'Missing or invalid query';
            return NextResponse.json({ error }, { status: 400 });
        }
        const { query, matchCount = 5 } = parsed.data;

        const scope = await resolveVoiceScope({ headers: req.headers, signal: req.signal });
        if (!scope.ok) {
            return NextResponse.json({ error: scope.status === 503 ? 'Voice scope unavailable' : 'Unauthorized', reason: scope.reason }, { status: scope.status });
        }

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

        const classification = env.RAG_QUERY_LAYER === 'true' ? classifyQuery(query) : undefined;
        const result = await runRetrieval({
            scope: scope.scope,
            query,
            profile: 'voice',
            options: { maxResults: matchCount },
            signal: req.signal,
            ...(logged
                ? { logContext: { channel: 'voice', userId: scope.scope.userId, organizationId: scope.scope.organizationId } as const }
                : {}),
            ...(history ? { history } : {}),
            ...(classification ? { classification } : {}),
            ...(trace ? { trace } : {}),
        });
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
        const answerConfig = readAnswerConfig();
        const turn = voiceAnswerTurn(answerConfig, query, history);
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
