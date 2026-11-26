import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { RAGClient, scopeTokenBinding, type HistoryTurn } from '../src/rag_client.js';

type Seen = { headers: http.IncomingHttpHeaders; body: any };

let server: http.Server;
let baseUrl: string;
let seen: Seen[] = [];
let respondHeaders: Record<string, string> = {};
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

function reply(status: number, payload: unknown, extraHeaders: Record<string, string> = {}) {
    seen = [];
    respondHeaders = extraHeaders;
    respond = (res) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...respondHeaders });
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
    assert.deepEqual(result, { ok: true, context: '', sources: [], source_images: [], serverQueryRewrite: false });
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

const SERVER_CONTEXT = 'Reference notice line\n<documents>\n<doc id="c1" source="a.pdf">alpha</doc>\n</documents>\nEnd of reference material.';

test('a non-empty server-built context string is used as the context verbatim', async () => {
    reply(200, {
        results: [{ document_id: 'doc-12345678-aaaa', content: 'alpha', similarity: 0.9, metadata: { filename: 'a.pdf' } }],
        source_images: [{ url: 'https://example.test/i.png', name: 'i', type: 'image/png' }],
        context: SERVER_CONTEXT,
    });
    const client = new RAGClient(baseUrl, 'key-placeholder');
    const result = await client.query('q', 'token-placeholder');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.context, SERVER_CONTEXT);
    assert.deepEqual(result.sources, [{ id: 'doc-12345678-aaaa', name: 'a.pdf', similarity: 0.9 }]);
    assert.deepEqual(result.source_images, [{ url: 'https://example.test/i.png', name: 'i', type: 'image/png' }]);
});

for (const [label, value] of [
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['a number', 42],
    ['an object', { text: 'x' }],
    ['null', null],
] as const) {
    test(`a context field that is ${label} falls back to the per-result format`, async () => {
        reply(200, {
            results: [{ document_id: 'short', content: 'gamma', similarity: 0.7 }],
            context: value,
        });
        const client = new RAGClient(baseUrl, 'key-placeholder');
        const result = await client.query('q', 'token-placeholder');
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.context, '[Context from document short]: gamma');
        assert.deepEqual(result.sources, [{ id: 'short', name: 'Document short', similarity: 0.7 }]);
        assert.deepEqual(result.source_images, []);
    });
}

const BINDING_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const BINDING_B = 'BBBBBBBBBBBBBBBBBBBBBB';

test('scopeTokenBinding is the first 22 characters of base64url SHA-256 over the token', () => {
    const expected = createHash('sha256').update('token-placeholder', 'utf8').digest('base64url').slice(0, 22);
    assert.equal(scopeTokenBinding('token-placeholder'), expected);
    assert.equal(scopeTokenBinding('token-placeholder').length, 22);
    assert.notEqual(scopeTokenBinding('token-placeholder'), scopeTokenBinding('other-token-placeholder'));
});

test('without history the body has no history key', async () => {
    reply(200, { results: [] });
    const client = new RAGClient(baseUrl, 'key-placeholder');
    await client.query('q', 'token-placeholder', 'user-id-placeholder', undefined);
    assert.deepEqual(seen[0].body, { query: 'q', userId: 'user-id-placeholder', matchCount: 5 });
    assert.equal('history' in seen[0].body, false);
});

test('history is sent with at most the last 6 turns, each cut to 1,000 characters, bindings unchanged', async () => {
    reply(200, { results: [] });
    const turns: HistoryTurn[] = [];
    for (let i = 0; i < 8; i++) {
        turns.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i} ` + 'x'.repeat(i === 7 ? 1500 : 3), binding: i % 3 === 0 ? BINDING_B : BINDING_A });
    }
    const client = new RAGClient(baseUrl, 'key-placeholder');
    await client.query('q', 'token-placeholder', 'user-id-placeholder', turns);
    const history = seen[0].body.history;
    assert.equal(history.length, 6);
    assert.deepEqual(history.map((h: HistoryTurn) => h.content.slice(0, 6)), ['turn 2', 'turn 3', 'turn 4', 'turn 5', 'turn 6', 'turn 7']);
    assert.deepEqual(history.map((h: HistoryTurn) => h.binding), turns.slice(2).map((t) => t.binding));
    assert.deepEqual(history.map((h: HistoryTurn) => h.role), turns.slice(2).map((t) => t.role));
    assert.equal(history[5].content.length, 1000);
    assert.ok(history.every((h: HistoryTurn) => h.content.length <= 1000));
    assert.equal(seen[0].body.query, 'q');
    assert.equal(seen[0].body.matchCount, 5);
});

test('history keeps only user and assistant turns and drops empty ones', async () => {
    reply(200, { results: [] });
    const turns = [
        { role: 'system', content: 'sys', binding: BINDING_A },
        { role: 'user', content: 'first question', binding: BINDING_A },
        { role: 'tool', content: 'tool out', binding: BINDING_A },
        { role: 'assistant', content: '', binding: BINDING_A },
        { role: 'assistant', content: 'first answer', binding: BINDING_A },
    ] as unknown as HistoryTurn[];
    const client = new RAGClient(baseUrl, 'key-placeholder');
    await client.query('q', 'token-placeholder', undefined, turns);
    assert.deepEqual(seen[0].body.history, [
        { role: 'user', content: 'first question', binding: BINDING_A },
        { role: 'assistant', content: 'first answer', binding: BINDING_A },
    ]);
});

test('serverQueryRewrite is true only for x-rag-server-query-rewrite: 1', async () => {
    const client = new RAGClient(baseUrl, 'key-placeholder');
    const payload = {
        results: [{ document_id: 'short', content: 'gamma', similarity: 0.7 }],
        source_images: [{ url: 'https://example.test/i.png', name: 'i', type: 'image/png' }],
    };
    reply(200, payload, { 'x-rag-server-query-rewrite': '1' });
    const on = await client.query('q', 'token-placeholder');
    assert.equal(on.ok, true);
    if (!on.ok) return;
    assert.equal(on.serverQueryRewrite, true);
    assert.equal(on.context, '[Context from document short]: gamma');
    assert.deepEqual(on.source_images, payload.source_images);

    reply(200, { results: [] }, { 'x-rag-server-query-rewrite': '1' });
    const emptyOn = await client.query('q', 'token-placeholder');
    assert.equal(emptyOn.ok && emptyOn.serverQueryRewrite, true);

    for (const headers of [{}, { 'x-rag-server-query-rewrite': '0' }, { 'x-rag-server-query-rewrite': 'true' }, { 'x-rag-server-query-rewrite': '1 ' + 'x' }]) {
        reply(200, payload, headers);
        const off = await client.query('q', 'token-placeholder');
        assert.equal(off.ok, true);
        if (!off.ok) return;
        assert.equal(off.serverQueryRewrite, false);
    }
});

test('history content is never written to the console', async () => {
    reply(200, { results: [] });
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    try {
        const client = new RAGClient(baseUrl, 'key-placeholder');
        await client.query('q', 'token-placeholder', undefined, [{ role: 'user', content: 'history-marker-placeholder', binding: BINDING_A }]);
    } finally {
        console.log = origLog;
    }
    assert.equal(lines.some((l) => l.includes('history-marker-placeholder')), false);
});
