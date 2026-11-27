import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { env } from '@/lib/env';
import {
    createAnswerTurn,
    evaluateCalc,
    loadVoiceCalcSources,
    MAX_VOICE_CALC_SOURCES,
    readAnswerConfig,
    resolveVoiceScope,
    runCalcChecks,
} from '@/lib/rag';
import { CalcRequestSchema, CalcTraceSchema } from '@/lib/rag-eval/contracts.generated';
import { internalApiKeyMatches } from '@/lib/internal-api-key';

export const runtime = 'nodejs';

const sourceSchema = z.object({
    alias: z.string().regex(/^S[1-9][0-9]{0,2}$/),
    chunk_id: z.string().uuid(),
}).strict();

const sourcesSchema = z
    .array(sourceSchema)
    .max(MAX_VOICE_CALC_SOURCES)
    .refine((sources) => new Set(sources.map((s) => s.alias)).size === sources.length, { message: 'duplicate alias' });

const question = z.string().min(1).max(4000);

const bodySchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('execute'), question, request: CalcRequestSchema, sources: sourcesSchema }).strict(),
    z.object({
        action: z.literal('check'),
        question,
        answer_text: z.string().min(1).max(8000),
        traces: z.array(CalcTraceSchema).max(5),
        sources: sourcesSchema,
    }).strict(),
]);

/** D-09: the question's language among the enabled languages; '' lets the registry fall back to the primary language. */
function questionLanguage(text: string): string {
    const turn = createAnswerTurn({ config: readAnswerConfig(), question: text, history: [], uiLanguage: null, channel: 'voice', ragMode: 'strict' });
    return turn.answerLanguage ?? '';
}

/**
 * Internal API Endpoint for the voice agent's calculation (Phase 5.2.1 D-76)
 *
 * execute evaluates the agent's calculate call; check recomputes the agent's traces against the answer text. Block text is
 * always read here, by chunk id, inside the caller's scope. Protected by MYRAG_INTERNAL_API_KEY plus the signed scope token.
 */
export async function POST(req: NextRequest) {
    try {
        if (!env.MYRAG_INTERNAL_API_KEY) {
            console.error('[Voice Calc] MYRAG_INTERNAL_API_KEY not configured on server');
            return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
        }
        if (!internalApiKeyMatches(req.headers.get('x-api-key'), env.MYRAG_INTERNAL_API_KEY)) {
            console.warn('[Voice Calc] Unauthorized access attempt');
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
            const path = (parsed.error.issues[0]?.path ?? []).join('.');
            return NextResponse.json({ error: 'invalid_body', path }, { status: 400 });
        }
        const body = parsed.data;

        const scope = await resolveVoiceScope({ headers: req.headers, signal: req.signal });
        if (!scope.ok) {
            return NextResponse.json({ error: scope.status === 503 ? 'Voice scope unavailable' : 'Unauthorized', reason: scope.reason }, { status: scope.status });
        }

        const config = readAnswerConfig();
        if (!config.calcTool) return NextResponse.json({ error: 'calc_tool_disabled' }, { status: 404 });
        if (body.action === 'check' && !config.calcCheck) return NextResponse.json({ check: null });

        let texts: Map<string, string>;
        try {
            texts = await loadVoiceCalcSources(scope.scope, body.sources, { signal: req.signal });
        } catch {
            console.error('[Voice Calc] source read failed', { action: body.action, sources: body.sources.length });
            return NextResponse.json({ error: 'knowledge_base_unavailable' }, { status: 503 });
        }

        if (body.action === 'execute') {
            const result = evaluateCalc(body.request, { aliases: new Set(texts.keys()) });
            console.log('[Voice Calc]', { action: 'execute', status: result.status, reason: result.reject_reason, sources: body.sources.length, loaded: texts.size });
            return NextResponse.json({ result });
        }

        const outcome = runCalcChecks({
            traces: body.traces,
            offered: true,
            rawText: body.answer_text,
            blocks: [...texts].map(([alias, text]) => ({ alias, text })),
            question: body.question,
            answerLanguage: questionLanguage(body.question),
        });
        console.log('[Voice Calc]', {
            action: 'check',
            traces: body.traces.length,
            sources: body.sources.length,
            loaded: texts.size,
            statuses: outcome.checks.map((c) => c.status),
            corrected: outcome.replacement ? 1 : 0,
        });
        return NextResponse.json({ check: { checks: outcome.checks, notices: outcome.notices, replacement: outcome.replacement ?? null } });
    } catch (error: unknown) {
        console.error('[Voice Calc] Error:', error instanceof Error ? error.name : 'unknown');
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
