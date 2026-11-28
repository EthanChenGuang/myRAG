import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { GraphResponse, GraphTransport } from '@/lib/nango/sharepoint/graph';

/**
 * A local stand-in for the Microsoft Graph drive delta endpoint (D-25). It serves hand-written synthetic recordings
 * from tests/fixtures/graph keyed by path plus query, on 127.0.0.1 only. Recorded calls keep the path, query, time and
 * which notable headers were present, never a header value.
 */
export interface FakeGraphResponse {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
}

export interface FakeGraphCall {
    method: string;
    pathAndQuery: string;
    at: number;
    hasAuthorization: boolean;
    hasDeltaExcludeParent: boolean;
    hasPrefer: boolean;
}

export interface FakeGraph {
    url: string;
    calls: FakeGraphCall[];
    /** Adds the responses of a recording file under tests/fixtures/graph (later loads win per key). */
    load(recording: string): void;
    /** Answers the next request for this path and query with these responses, in order, before the recording. */
    respondOnce(pathAndQuery: string, ...responses: FakeGraphResponse[]): void;
    /** A transport that sends the endpoint to the fake exactly as `nango.proxy` would send it to graph.microsoft.com. */
    transport(): GraphTransport;
    close(): Promise<void>;
}

const RECORDINGS_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'graph');

export function readGraphRecording(recording: string): Record<string, FakeGraphResponse> {
    const file = path.join(RECORDINGS_DIR, recording.endsWith('.json') ? recording : `${recording}.json`);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { responses: Record<string, FakeGraphResponse> };
    return parsed.responses;
}

export async function startFakeGraph(...recordings: string[]): Promise<FakeGraph> {
    const responses = new Map<string, FakeGraphResponse>();
    const once = new Map<string, FakeGraphResponse[]>();
    const calls: FakeGraphCall[] = [];
    const load = (recording: string) => {
        for (const [key, value] of Object.entries(readGraphRecording(recording))) responses.set(key, value);
    };
    recordings.forEach(load);

    const server: Server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://fake');
        const pathAndQuery = `${url.pathname}${url.search}`;
        calls.push({
            method: request.method ?? 'GET',
            pathAndQuery,
            at: Date.now(),
            hasAuthorization: request.headers.authorization !== undefined,
            hasDeltaExcludeParent: Object.keys(request.headers).some((name) => name.toLowerCase() === 'deltaexcludeparent'),
            hasPrefer: request.headers.prefer !== undefined,
        });
        const queued = once.get(pathAndQuery);
        const answer = queued && queued.length > 0 ? queued.shift()! : responses.get(pathAndQuery);
        const reply = answer ?? { status: 404, body: { error: { code: 'itemNotFound', message: 'not recorded' } } };
        const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
        response.writeHead(reply.status, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(text),
            ...(reply.headers ?? {}),
        });
        response.end(text);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    const transport = (): GraphTransport => async ({ endpoint, signal }) => {
        const res = await fetch(`${url}${endpoint}`, { method: 'GET', signal });
        const text = await res.text();
        const headers: Record<string, string> = {};
        res.headers.forEach((value, name) => {
            headers[name.toLowerCase()] = value;
        });
        const result: GraphResponse = { status: res.status, data: text ? JSON.parse(text) : null, headers };
        return result;
    };

    return {
        url,
        calls,
        load,
        respondOnce(pathAndQuery, ...queued) {
            once.set(pathAndQuery, [...(once.get(pathAndQuery) ?? []), ...queued]);
        },
        transport,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
}
