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
    /** Phase 5.2.1 D-76: the calculation offer for this turn; absent when the app does not offer it. */
    calc?: VoiceCalcOffer;
}

export interface VoiceCalcSource {
    alias: string;
    chunk_id: string;
}

export interface VoiceCalcOffer {
    offered: true;
    check: boolean;
    sources: VoiceCalcSource[];
    tool_schema: Record<string, unknown>;
}

export interface VoiceCalcResult {
    status: string;
    value?: string | null;
    [key: string]: unknown;
}

export interface VoiceCalcTrace {
    origin: 'tool';
    request: Record<string, unknown>;
    result: VoiceCalcResult | null;
    anchor_offset: number | null;
}

export interface VoiceCalcCheck {
    checks: Array<Record<string, unknown>>;
    notices: unknown[];
    replacement: { start: number; end: number; text: string } | null;
}

export interface VoiceTiming {
    ttft_ms: number;
    pre_generation_ms: number;
}

export interface RAGClientOptions {
    timingTimeoutMs?: number;
    contextLength?: number | null;
}

/** The voice-rag body accepts modelContextLength from 1,024 to 10,000,000 tokens; anything else counts as unset. */
export const CONTEXT_LENGTH_MIN = 1024;
export const CONTEXT_LENGTH_MAX = 10_000_000;

export function parseContextLength(value: string | undefined): number | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!/^[0-9]+$/.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) && n >= CONTEXT_LENGTH_MIN && n <= CONTEXT_LENGTH_MAX ? n : null;
}

const ALIAS_RE = /^S[1-9][0-9]{0,2}$/;
const CALC_TIMEOUT_MS = 10000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCalcOffer(value: unknown): VoiceCalcOffer | null {
    if (!isPlainObject(value) || value.offered !== true || typeof value.check !== 'boolean' || !isPlainObject(value.tool_schema)) return null;
    if (!Array.isArray(value.sources)) return null;
    const sources: VoiceCalcSource[] = [];
    for (const source of value.sources) {
        if (!isPlainObject(source) || typeof source.alias !== 'string' || !ALIAS_RE.test(source.alias) || typeof source.chunk_id !== 'string') return null;
        sources.push({ alias: source.alias, chunk_id: source.chunk_id });
    }
    return { offered: true, check: value.check, sources, tool_schema: value.tool_schema };
}

function calcUrl(apiUrl: string): string {
    return apiUrl.replace(/\/voice-rag(?=$|[?#])/, '/voice-calc');
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
    private calcFailures = 0;
    private contextLength: number | null;

    constructor(apiUrl: string, apiKey: string, options: RAGClientOptions = {}) {
        this.apiUrl = apiUrl;
        this.apiKey = apiKey;
        this.timingTimeoutMs = options.timingTimeoutMs && options.timingTimeoutMs > 0 ? options.timingTimeoutMs : DEFAULT_TIMING_TIMEOUT_MS;
        if (options.contextLength !== undefined) {
            this.contextLength = options.contextLength;
        } else {
            const raw = process.env.VOICE_AGENT_CONTEXT_LENGTH;
            this.contextLength = parseContextLength(raw);
            if (this.contextLength === null && raw !== undefined && raw.trim() !== '') {
                console.warn('[RAG] VOICE_AGENT_CONTEXT_LENGTH ignored: expected an integer from 1024 to 10000000');
            }
        }
    }

    /** D-87: the agent model's window when VOICE_AGENT_CONTEXT_LENGTH is set, else null. */
    getContextLength(): number | null {
        return this.contextLength;
    }

    private headers(scopeToken?: string): Record<string, string> {
        const headers: Record<string, string> = {
            'x-api-key': this.apiKey,
            'Content-Type': 'application/json'
        };
        if (scopeToken) {
            headers['x-rag-scope-token'] = scopeToken;
        }
        return headers;
    }

    private async postCalc(action: 'execute' | 'check', body: Record<string, unknown>, scopeToken?: string): Promise<Record<string, unknown> | null> {
        try {
            const response = await axios.post(calcUrl(this.apiUrl), { action, ...body }, { headers: this.headers(scopeToken), timeout: CALC_TIMEOUT_MS });
            return isPlainObject(response.data) ? response.data : null;
        } catch (error) {
            this.calcFailures++;
            const status = axios.isAxiosError(error) ? error.response?.status ?? null : null;
            console.debug('[RAG] Voice calc call failed', { action, status, failures: this.calcFailures });
            return null;
        }
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

    calcFailureCount(): number {
        return this.calcFailures;
    }

    /** D-76: evaluates one calculate call on the server; null on any failure (counted, logged without text). */
    async executeCalc(request: Record<string, unknown>, question: string, sources: VoiceCalcSource[], scopeToken?: string): Promise<VoiceCalcResult | null> {
        const data = await this.postCalc('execute', { question, request, sources }, scopeToken);
        if (data === null) return null;
        const result = data.result;
        if (isPlainObject(result) && typeof result.status === 'string') return result as VoiceCalcResult;
        this.calcFailures++;
        console.debug('[RAG] Voice calc answer malformed', { action: 'execute', failures: this.calcFailures });
        return null;
    }

    /** D-76: recomputes the turn's traces against its text; null when the check is off or the call failed. */
    async checkCalc(answerText: string, traces: VoiceCalcTrace[], question: string, sources: VoiceCalcSource[], scopeToken?: string): Promise<VoiceCalcCheck | null> {
        const data = await this.postCalc('check', { question, answer_text: answerText, traces, sources }, scopeToken);
        if (data === null || data.check === null) return null;
        const check = data.check;
        if (isPlainObject(check) && Array.isArray(check.checks)) {
            const replacement = isPlainObject(check.replacement) ? (check.replacement as VoiceCalcCheck['replacement']) : null;
            return { checks: check.checks as VoiceCalcCheck['checks'], notices: Array.isArray(check.notices) ? check.notices : [], replacement };
        }
        this.calcFailures++;
        console.debug('[RAG] Voice calc answer malformed', { action: 'check', failures: this.calcFailures });
        return null;
    }

    async query(userQuery: string, scopeToken?: string, userId?: string, history?: HistoryTurn[], historyTokens?: number): Promise<RAGQueryResult> {
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
            if (this.contextLength !== null) {
                body.modelContextLength = this.contextLength;
                body.historyTokens = typeof historyTokens === 'number' && Number.isSafeInteger(historyTokens) && historyTokens > 0
                    ? Math.min(historyTokens, CONTEXT_LENGTH_MAX)
                    : 0;
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
            const calc = parseCalcOffer(response.data.calc);
            const serverContext: unknown = response.data.context;
            const contextText = typeof serverContext === 'string' && serverContext.trim() !== ''
                ? serverContext
                : results.map((r, i) => `${calc ? `[S${i + 1}] ` : ''}[Context from document ${r.document_id}]: ${r.content}`).join('\n\n');

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
                ...traceIdOf(response.data),
                ...(calc ? { calc } : {})
            };

        } catch (error) {
            const reason = classifyFailure(error);
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            console.error('[RAG] Error querying internal API:', { reason, status, message: error instanceof Error ? error.message : String(error) });
            return { ok: false, reason };
        }
    }
}
