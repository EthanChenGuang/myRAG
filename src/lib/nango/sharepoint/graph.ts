import { getNango } from '../client';

/**
 * Microsoft Graph GET through `nango.proxy` (Phase 6.3, D-21, D-40). Only a path and query ever reach the proxy, whose
 * base URL is https://graph.microsoft.com; a stored or returned link on any other host is refused (T-06.3-18).
 * 429 and 503 wait for Retry-After before the next request (Pitfall 16).
 */
export const GRAPH_HOST = 'graph.microsoft.com';
const GRAPH_PATH_PREFIX = '/v1.0/';
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_SINGLE_WAIT_MS = 60_000;
const DEFAULT_MAX_TOTAL_WAIT_MS = 120_000;
const MAX_ATTEMPTS = 6;

export interface GraphResponse {
    status: number;
    data: unknown;
    headers: Record<string, string | undefined>;
}

export type GraphTransport = (request: { endpoint: string; signal?: AbortSignal }) => Promise<GraphResponse>;

export class GraphLinkRefusedError extends Error {
    constructor() {
        super('graph_link_refused');
        this.name = 'GraphLinkRefusedError';
    }
}

export class GraphHttpError extends Error {
    constructor(readonly status: number) {
        super(`graph_http_${status}`);
        this.name = 'GraphHttpError';
    }
}

/** A throttling wait would pass the caller's deadline; the request was not repeated. */
export class GraphDeadlineError extends Error {
    constructor() {
        super('graph_deadline');
        this.name = 'GraphDeadlineError';
    }
}

function assertGraphPath(pathAndQuery: string): string {
    if (
        !pathAndQuery.startsWith(GRAPH_PATH_PREFIX) ||
        pathAndQuery.includes('\\') ||
        /(^|\/)\.\.?(\/|$|\?)/.test(pathAndQuery.split('?')[0]) ||
        /[\s\u0000-\u001f]/.test(pathAndQuery)
    ) {
        throw new GraphLinkRefusedError();
    }
    return pathAndQuery;
}

/** Path plus query of an absolute https://graph.microsoft.com link; anything else is refused. */
export function pathAndQueryOf(link: string): string {
    let url: URL;
    try {
        url = new URL(link);
    } catch {
        throw new GraphLinkRefusedError();
    }
    if (url.protocol !== 'https:' || url.hostname !== GRAPH_HOST || url.port !== '' || url.username !== '' || url.password !== '') {
        throw new GraphLinkRefusedError();
    }
    return assertGraphPath(`${url.pathname}${url.search}`);
}

/** A stored cursor (a Graph path and query) or an absolute Graph link, as a proxy endpoint. */
export function graphEndpointOf(cursorOrLink: string): string {
    if (cursorOrLink.startsWith('/') && !cursorOrLink.startsWith('//')) return assertGraphPath(cursorOrLink);
    return pathAndQueryOf(cursorOrLink);
}

function headerValue(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
    if (!headers) return undefined;
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted && value !== undefined) return String(value);
    }
    return undefined;
}

/** Retry-After in milliseconds (delta-seconds or an HTTP date); a missing or unreadable value waits one second. */
export function retryAfterMs(value: string | undefined, nowMs: number = Date.now()): number {
    if (value === undefined || value.trim() === '') return DEFAULT_RETRY_AFTER_MS;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
    return DEFAULT_RETRY_AFTER_MS;
}

function abortError(): Error {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export interface GraphGetOptions {
    signal?: AbortSignal;
    /** Epoch milliseconds; a throttling wait that would end after it throws GraphDeadlineError instead. */
    deadline?: number;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    maxTotalWaitMs?: number;
}

export async function graphGet(transport: GraphTransport, endpoint: string, options: GraphGetOptions = {}): Promise<GraphResponse> {
    const safeEndpoint = graphEndpointOf(endpoint);
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    const maxTotalWait = options.maxTotalWaitMs ?? DEFAULT_MAX_TOTAL_WAIT_MS;
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
        if (options.signal?.aborted) throw abortError();
        const response = await transport({ endpoint: safeEndpoint, signal: options.signal });
        if (response.status >= 200 && response.status < 300) return response;
        if ((response.status === 429 || response.status === 503) && attempt < MAX_ATTEMPTS) {
            const wait = Math.min(retryAfterMs(headerValue(response.headers, 'retry-after'), now()), MAX_SINGLE_WAIT_MS);
            if (options.deadline !== undefined && now() + wait > options.deadline) throw new GraphDeadlineError();
            if (waited + wait > maxTotalWait) throw new GraphHttpError(response.status);
            waited += wait;
            await sleep(wait, options.signal);
            continue;
        }
        throw new GraphHttpError(response.status);
    }
}

interface ProxyErrorShape {
    response?: { status?: number; data?: unknown; headers?: Record<string, unknown> };
}

function plainHeaders(headers: Record<string, unknown> | undefined): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    if (!headers) return out;
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || value === null) continue;
        out[key.toLowerCase()] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
    }
    return out;
}

/**
 * The production transport: one `nango.proxy` GET per call, no retries inside the proxy (graphGet owns Retry-After).
 * A non-2xx upstream answer surfaces as the proxy error's response status (A3) and is returned, not thrown.
 */
export function nangoGraphTransport(providerConfigKey: string, connectionId: string): GraphTransport {
    return async ({ endpoint }) => {
        const nango = getNango();
        try {
            const response = await nango.proxy({ providerConfigKey, connectionId, method: 'GET', endpoint });
            return {
                status: response.status,
                data: response.data,
                headers: plainHeaders(response.headers as Record<string, unknown> | undefined),
            };
        } catch (error) {
            const status = (error as ProxyErrorShape)?.response?.status;
            if (typeof status === 'number') {
                const upstream = (error as ProxyErrorShape).response!;
                return { status, data: upstream.data ?? null, headers: plainHeaders(upstream.headers) };
            }
            throw error;
        }
    };
}
