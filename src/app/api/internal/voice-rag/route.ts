import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { env } from '@/lib/env';
import { deriveVoiceKeywords, resolveVoiceScope, runRetrieval } from '@/lib/rag';

export const runtime = 'nodejs';

const bodySchema = z.object({
    query: z.string().min(1).max(4000),
    matchCount: z.number().int().min(1).max(20).optional(),
});

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

        if (apiKey !== env.MYRAG_INTERNAL_API_KEY) {
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
            return NextResponse.json(
                { error: field === 'matchCount' ? 'Invalid matchCount' : 'Missing or invalid query' },
                { status: 400 }
            );
        }
        const { query, matchCount = 5 } = parsed.data;

        const scope = await resolveVoiceScope({ headers: req.headers, signal: req.signal });
        if (!scope.ok) {
            return NextResponse.json({ error: scope.status === 503 ? 'Voice scope unavailable' : 'Unauthorized', reason: scope.reason }, { status: scope.status });
        }

        const result = await runRetrieval({
            scope: scope.scope,
            query,
            profile: 'voice',
            options: { maxResults: matchCount },
            signal: req.signal,
        });

        const voice = result.voice;
        if (result.status === 'error' || (result.status === 'degraded' && (!voice || voice.results.length === 0))) {
            console.error('[Document Search] Voice retrieval unavailable', { status: result.status, reason: result.reason, traceId: result.traceId });
            return NextResponse.json({ error: 'knowledge_base_unavailable', reason: result.reason }, { status: 503 });
        }

        if (!voice || voice.results.length === 0) {
            return NextResponse.json({ results: [] });
        }

        const keywords = deriveVoiceKeywords(query);
        return NextResponse.json({
            results: voice.results,
            source_images: voice.source_images,
            debug_info: (process.env.NODE_ENV === 'development' || query.includes('debug')) ? {
                cleanQuery: keywords.cleanQuery,
                keywords: keywords.keywords,
                searchKeywords: keywords.searchKeywords
            } : undefined
        });

    } catch (error: unknown) {
        console.error('[Internal RAG] Error:', error);
        return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
    }
}
