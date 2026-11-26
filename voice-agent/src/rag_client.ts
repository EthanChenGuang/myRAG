import axios from 'axios';
import { createHash } from 'node:crypto';

export interface RAGResult {
    content: string;
    similarity: number;
    document_id: string;
    metadata?: any;
}

// Source image data from Image RAG
export interface SourceImage {
    url: string;
    name: string;
    type: string;
}

export interface RAGResponse {
    context: string;
    sources: Array<{
        id: string;
        name: string;
        similarity: number;
    }>;
    source_images: SourceImage[];
    /** Retrieval trace id of the app answer; absent from older apps. */
    traceId?: string;
}

export interface VoiceTiming {
    ttft_ms: number;
    pre_generation_ms: number;
}

export interface RAGClientOptions {
    timingTimeoutMs?: number;
}

export interface HistoryTurn {
    role: 'user' | 'assistant';
    content: string;
    binding: string;
}

export const HISTORY_MAX_TURNS = 6;
export const HISTORY_MAX_CHARS = 1000;
const SERVER_QUERY_REWRITE_HEADER = 'x-rag-server-query-rewrite';
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const DEFAULT_TIMING_TIMEOUT_MS = 2000;

function traceIdOf(data: unknown): { traceId: string } | Record<string, never> {
    const value = data && typeof data === 'object' ? (data as Record<string, unknown>).traceId : undefined;
    return typeof value === 'string' && TRACE_ID_RE.test(value) ? { traceId: value } : {};
}

function timingUrl(apiUrl: string): string {
    return apiUrl.replace(/\/voice-rag(?=$|[?#])/, '/voice-timing');
}

export function scopeTokenBinding(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('base64url').slice(0, 22);
}

function cutContent(content: string): string {
    if (content.length <= HISTORY_MAX_CHARS) return content;
    let cut = content.slice(0, HISTORY_MAX_CHARS);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    return cut;
}

function boundHistory(history: HistoryTurn[]): HistoryTurn[] {
    return history
        .filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.length > 0 && typeof t.binding === 'string')
        .slice(-HISTORY_MAX_TURNS)
        .map((t) => ({ role: t.role, content: cutContent(t.content), binding: t.binding }));
}

export type RAGFailureReason = 'unauthorized' | 'unavailable' | 'error';

export type RAGQueryResult = ({ ok: true; serverQueryRewrite: boolean } & RAGResponse) | { ok: false; reason: RAGFailureReason };

function classifyFailure(error: unknown): RAGFailureReason {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 503) return 'unavailable';
    return 'error';
}

export class RAGClient {
    private apiUrl: string;
    private apiKey: string;
    private timingTimeoutMs: number;
    private timingFailures = 0;

    constructor(apiUrl: string, apiKey: string, options: RAGClientOptions = {}) {
        this.apiUrl = apiUrl;
        this.apiKey = apiKey;
        this.timingTimeoutMs = options.timingTimeoutMs && options.timingTimeoutMs > 0 ? options.timingTimeoutMs : DEFAULT_TIMING_TIMEOUT_MS;
    }

    /** Fire-and-forget: posts the voice text timing for a retrieval trace (D-39). Never throws. */
    async reportTiming(traceId: string, timing: VoiceTiming, scopeToken?: string): Promise<void> {
        try {
            const headers: Record<string, string> = {
                'x-api-key': this.apiKey,
                'Content-Type': 'application/json'
            };
            if (scopeToken) {
                headers['x-rag-scope-token'] = scopeToken;
            }
            await axios.post(
                timingUrl(this.apiUrl),
                { traceId, ttft_ms: timing.ttft_ms, pre_generation_ms: timing.pre_generation_ms },
                { headers, timeout: this.timingTimeoutMs }
            );
        } catch (error) {
            this.timingFailures++;
            const status = axios.isAxiosError(error) ? error.response?.status ?? null : null;
            console.debug('[RAG] Voice timing post failed', { status, failures: this.timingFailures });
        }
    }

    async query(userQuery: string, scopeToken?: string, userId?: string, history?: HistoryTurn[]): Promise<RAGQueryResult> {
        try {
            console.log(`[RAG] Querying internal API: "${userQuery}"`);

            const headers: Record<string, string> = {
                'x-api-key': this.apiKey,
                'Content-Type': 'application/json'
            };
            if (scopeToken) {
                headers['x-rag-scope-token'] = scopeToken;
            }

            const body: Record<string, unknown> = {
                query: userQuery,
                userId: userId,
                matchCount: 5
            };
            if (history !== undefined) {
                body.history = boundHistory(history);
            }

            const response = await axios.post(this.apiUrl, body, { headers });
            const serverQueryRewrite = response.headers?.[SERVER_QUERY_REWRITE_HEADER] === '1';

            const results: RAGResult[] = response.data.results || [];

            if (results.length === 0) {
                console.log('[RAG] No relevant context found.');
                // DEBUG: Print what we DID get
                console.log(`[RAG] Response keys: ${Object.keys(response.data).join(', ')}`);
                console.log(`[RAG] API URL used: ${this.apiUrl}`);
                return { ok: true, context: '', sources: [], source_images: [], serverQueryRewrite, ...traceIdOf(response.data) };
            }

            // DEBUG: Inspect raw response for images
            console.log(`[RAG] Raw response keys: ${Object.keys(response.data).join(', ')}`);
            if (response.data.source_images) {
                console.log(`[RAG] Raw source_images length: ${response.data.source_images.length}`);
            } else {
                console.log('[RAG] Raw source_images is MISSING or undefined in response.data');
            }

            // Extract source images from API response (Image RAG support)
            const sourceImages: SourceImage[] = response.data.source_images || [];
            if (sourceImages.length > 0) {
                console.log(`[RAG] 🖼️ Retrieved ${sourceImages.length} source images`);
            }

            // Format context for LLM
            console.log(`[RAG] Found ${results.length} context chunks.`);
            const serverContext: unknown = response.data.context;
            const contextText = typeof serverContext === 'string' && serverContext.trim() !== ''
                ? serverContext
                : results.map(r => `[Context from document ${r.document_id}]: ${r.content}`).join('\n\n');

            // Format sources for UI
            const sources = results.map(r => {
                // Ensure document_id exists
                const docId = r.document_id || 'unknown';
                const shortId = docId.length >= 8 ? docId.substring(0, 8) : docId;

                return {
                    id: docId,
                    name: r.metadata?.filename || r.metadata?.name || `Document ${shortId}`,
                    similarity: r.similarity
                };
            });

            // Deduplicate sources by ID
            const uniqueSources = Array.from(new Map(sources.map(s => [s.id, s])).values());

            return {
                ok: true,
                context: contextText,
                sources: uniqueSources,
                source_images: sourceImages,
                serverQueryRewrite,
                ...traceIdOf(response.data)
            };

        } catch (error) {
            const reason = classifyFailure(error);
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            console.error('[RAG] Error querying internal API:', { reason, status, message: error instanceof Error ? error.message : String(error) });
            return { ok: false, reason };
        }
    }
}
