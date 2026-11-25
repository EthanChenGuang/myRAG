import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RAGClient } from '../src/rag_client.js';

type Seen = { headers: http.IncomingHttpHeaders; body: any };

let server: http.Server;
let baseUrl: string;
let seen: Seen[] = [];
let respond: (res: http.ServerResponse) => void = (res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
};

before(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            let body: any = null;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                body = null;
            }
            seen.push({ headers: req.headers, body });
            respond(res);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/voice-rag`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reply(status: number, payload: unknown) {
    seen = [];
    respond = (res) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    };
}

test('sends x-api-key and x-rag-scope-token when a token is given', async () => {
    reply(200, { results: [] });
    const client = new RAGClient(baseUrl, 'key-placeholder');
    await client.query('hello', 'token-placeholder');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['x-api-key'], 'key-placeholder');
    assert.equal(seen[0].headers['x-rag-scope-token'], 'token-placeholder');
});

test('sends no x-rag-scope-token header without a token', async () => {
    reply(200, { results: [] });
    const client = new RAGClient(baseUrl, 'key-placeholder');
    await client.query('hello');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['x-api-key'], 'key-placeholder');
    assert.equal('x-rag-scope-token' in seen[0].headers, false);
});

test('keeps query, userId and matchCount in the body for old-app compatibility', async () => {
    reply(200, { results: [] });
    const client = new RAGClient(baseUrl, 'key-placeholder');
    await client.query('what is x', 'token-placeholder', 'user-id-placeholder');
    assert.deepEqual(seen[0].body, { query: 'what is x', userId: 'user-id-placeholder', matchCount: 5 });
});

test('200 with results maps to an ok result with context, sources and images', async () => {
    reply(200, {
        results: [
            { document_id: 'doc-12345678-aaaa', content: 'alpha', similarity: 0.9, metadata: { filename: 'a.pdf' } },
            { document_id: 'doc-12345678-aaaa', content: 'beta', similarity: 0.8 },
            { document_id: 'short', content: 'gamma', similarity: 0.7 },
        ],
        source_images: [{ url: 'https://example.test/i.png', name: 'i', type: 'image/png' }],
    });
    const client = new RAGClient(baseUrl, 'key-placeholder');
    const result = await client.query('q', 'token-placeholder');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
        result.context,
        '[Context from document doc-12345678-aaaa]: alpha\n\n[Context from document doc-12345678-aaaa]: beta\n\n[Context from document short]: gamma'
    );
    assert.deepEqual(result.sources, [
        { id: 'doc-12345678-aaaa', name: 'Document doc-1234', similarity: 0.8 },
        { id: 'short', name: 'Document short', similarity: 0.7 },
    ]);
    assert.deepEqual(result.source_images, [{ url: 'https://example.test/i.png', name: 'i', type: 'image/png' }]);
});

test('source names come from metadata filename, then name, then a short id', async () => {
    reply(200, {
        results: [
            { document_id: 'aaaaaaaa-1', content: 'x', similarity: 0.5, metadata: { filename: 'a.pdf' } },
            { document_id: 'bbbbbbbb-2', content: 'y', similarity: 0.4, metadata: { name: 'named' } },
        ],
    });
    const client = new RAGClient(baseUrl, 'key-placeholder');
    const result = await client.query('q', 'token-placeholder');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
        result.sources.map((s) => s.name),
        ['a.pdf', 'named']
    );
});

test('200 with no results is ok with an empty context', async () => {
    reply(200, { results: [] });
    const client = new RAGClient(baseUrl, 'key-placeholder');
    const result = await client.query('q', 'token-placeholder');
    assert.deepEqual(result, { ok: true, context: '', sources: [], source_images: [] });
});

test('401 gives unauthorized', async () => {
    reply(401, { error: 'unauthorized' });
    const client = new RAGClient(baseUrl, 'key-placeholder');
    assert.deepEqual(await client.query('q', 'token-placeholder'), { ok: false, reason: 'unauthorized' });
});

test('403 gives unauthorized', async () => {
    reply(403, { error: 'forbidden' });
    const client = new RAGClient(baseUrl, 'key-placeholder');
    assert.deepEqual(await client.query('q', 'token-placeholder'), { ok: false, reason: 'unauthorized' });
});

test('503 gives unavailable', async () => {
    reply(503, { error: 'knowledge_base_unavailable' });
    const client = new RAGClient(baseUrl, 'key-placeholder');
    assert.deepEqual(await client.query('q', 'token-placeholder'), { ok: false, reason: 'unavailable' });
});

test('other statuses give error', async () => {
    reply(500, { error: 'boom' });
    const client = new RAGClient(baseUrl, 'key-placeholder');
    assert.deepEqual(await client.query('q', 'token-placeholder'), { ok: false, reason: 'error' });
});

test('connection refused gives error', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const client = new RAGClient(`http://127.0.0.1:${port}/x`, 'key-placeholder');
    assert.deepEqual(await client.query('q', 'token-placeholder'), { ok: false, reason: 'error' });
});

test('neither the token nor the api key is written to the console', async () => {
    reply(401, { error: 'unauthorized' });
    const lines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;
    const capture = (...args: unknown[]) => {
        lines.push(
            args
                .map((a) => {
                    if (typeof a === 'string') return a;
                    if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}\n${JSON.stringify((a as any).config ?? {})}`;
                    try {
                        return JSON.stringify(a);
                    } catch {
                        return String(a);
                    }
                })
                .join(' ')
        );
    };
    console.log = capture;
    console.error = capture;
    console.warn = capture;
    try {
        const client = new RAGClient(baseUrl, 'key-placeholder');
        await client.query('q', 'secret-token-placeholder');
    } finally {
        console.log = origLog;
        console.error = origErr;
        console.warn = origWarn;
    }
    assert.equal(lines.some((l) => l.includes('secret-token-placeholder')), false);
    assert.equal(lines.some((l) => l.includes('key-placeholder')), false);
});
