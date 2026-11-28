import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { env } from '@/lib/env';
import { isTraceId, postLangfuseScores, resolveVoiceScope } from '@/lib/rag';
import { internalApiKeyMatches } from '@/lib/internal-api-key';

export const runtime = 'nodejs';

const MAX_TIMING_MS = 120_000;

const millis = z.number().int().min(0).max(MAX_TIMING_MS);

const bodySchema = z
    .object({
        traceId: z.string().refine(isTraceId),
        ttft_ms: millis,
        pre_generation_ms: millis,
    })
    .strict()
    .refine((body) => body.pre_generation_ms <= body.ttft_ms);

/**
 * Internal API Endpoint for voice timing (D-39)
 *
 * The voice agent streams the answer itself, so it measures its own time to first text delta
 * and posts it here; the numbers land as Langfuse scores on the retrieval trace.
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
            return NextResponse.json({ error: 'Invalid timing body' }, { status: 400 });
        }
        const { traceId, ttft_ms, pre_generation_ms } = parsed.data;

        const scope = await resolveVoiceScope({ headers: req.headers, signal: req.signal });
        if (!scope.ok) {
            return NextResponse.json({ error: scope.status === 503 ? 'Voice scope unavailable' : 'Unauthorized', reason: scope.reason }, { status: scope.status });
        }

        const posted = await postLangfuseScores([
            { traceId, name: 'ttft_ms', value: ttft_ms, dataType: 'NUMERIC' },
            { traceId, name: 'pre_generation_ms', value: pre_generation_ms, dataType: 'NUMERIC' },
        ]);
        console.log('[Internal RAG] voice timing', { traceId, ttft_ms, pre_generation_ms, scores: posted.status });

        return NextResponse.json({ accepted: true }, { status: 202 });
    } catch (error: unknown) {
        console.error('[Internal RAG] Timing error:', error instanceof Error ? error.name : 'unknown');
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
