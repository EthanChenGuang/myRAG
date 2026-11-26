import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { VoicePipeline } from '../src/voice_agent.js';
import { scopeTokenBinding, type HistoryTurn, type RAGQueryResult } from '../src/rag_client.js';

type RagCall = { query: string; token?: string; userId?: string; history?: HistoryTurn[] };

const TOKEN_A = 'scope-token-placeholder-a';
const TOKEN_B = 'scope-token-placeholder-b';

function okResult(serverQueryRewrite: boolean): RAGQueryResult {
    return { ok: true, context: '', sources: [], source_images: [], serverQueryRewrite };
}

function makePipeline(env: string | undefined, headers: boolean[] = []) {
    if (env === undefined) delete process.env.VOICE_SERVER_QUERY_REWRITE;
    else process.env.VOICE_SERVER_QUERY_REWRITE = env;
    const originalLog = console.log;
    console.log = () => {};
    let pipeline: VoicePipeline;
    try {
        pipeline = new VoicePipeline(
            {
                openaiApiKey: 'key-placeholder',
                assemblyApiKey: 'key-placeholder',
                resembleApiKey: 'key-placeholder',
                resembleVoiceId: 'voice-placeholder',
                ragApiUrl: 'http://127.0.0.1:1/api/internal/voice-rag',
                ragApiKey: 'key-placeholder',
            },
            () => {}
        );
    } finally {
        console.log = originalLog;
    }
    const ragCalls: RagCall[] = [];
    const llmCalls: unknown[] = [];
    let responseIndex = 0;
    const p = pipeline as any;
    p.rag = {
        query: async (query: string, token?: string, userId?: string, history?: HistoryTurn[]) => {
            ragCalls.push({ query, token, userId, history });
            const header = headers[Math.min(responseIndex, headers.length - 1)] ?? false;
            responseIndex++;
            return okResult(header);
        },
    };
    p.llm = {
        chat: {
            completions: {
                create: async (args: unknown) => {
                    llmCalls.push(args);
                    return { choices: [{ message: { content: 'rewritten query' } }] };
                },
            },
        },
    };
    let rewriteCalls = 0;
    const originalRewrite = p.rewriteQueryWithContext.bind(pipeline);
    p.rewriteQueryWithContext = async (q: string) => {
        rewriteCalls++;
        return originalRewrite(q);
    };
    return {
        pipeline,
        p,
        ragCalls,
        llmCalls,
        rewriteCount: () => rewriteCalls,
        async turn(text: string, answer = 'an answer') {
            const out = await p.retrieve(text, p.currentRequestId);
            p.recordExchange(out.rewrittenQuery, answer);
            return out;
        },
    };
}

function quiet<T>(fn: () => Promise<T>): Promise<T> {
    const log = console.log;
    console.log = () => {};
    return fn().finally(() => {
        console.log = log;
    });
}

afterEach(() => {
    delete process.env.VOICE_SERVER_QUERY_REWRITE;
});

for (const value of [undefined, 'false', 'yes', 'TRUE', '1']) {
    test(`switch ${value === undefined ? 'unset' : `"${value}"`}: local rewrite runs once per turn and no history is sent`, () =>
        quiet(async () => {
            const h = makePipeline(value, [true]);
            h.pipeline.setScopeToken(TOKEN_A);
            h.p.recordTurn({ role: 'assistant', content: 'greeting line' });
            const first = await h.turn('first question');
            assert.equal(h.rewriteCount(), 1);
            assert.equal(first.rewrittenQuery, 'rewritten query');
            await h.turn('follow-up question');
            assert.equal(h.rewriteCount(), 2);
            assert.equal(h.llmCalls.length, 2);
            assert.equal(h.ragCalls.length, 2);
            for (const call of h.ragCalls) {
                assert.equal(call.history, undefined);
                assert.equal(call.query, 'rewritten query');
                assert.equal(call.token, TOKEN_A);
            }
        }));
}

test('switch true, server never sends the header: every follow-up rewrites locally and sends no history', () =>
    quiet(async () => {
        const h = makePipeline('true', [false]);
        h.pipeline.setScopeToken(TOKEN_A);
        h.p.recordTurn({ role: 'assistant', content: 'greeting line' });
        for (let i = 0; i < 4; i++) await h.turn(`question ${i}`);
        assert.equal(h.rewriteCount(), 4);
        assert.equal(h.llmCalls.length, 4);
        assert.ok(h.ragCalls.every((c) => c.history === undefined && c.query === 'rewritten query'));
    }));

test('switch true, server sends the header: next follow-up skips the local rewrite and sends the last 6 turns with bindings', () =>
    quiet(async () => {
        const h = makePipeline('true', [true]);
        h.pipeline.setScopeToken(TOKEN_A);
        h.p.recordTurn({ role: 'assistant', content: 'greeting line' });
        await h.turn('question 0', 'answer 0');
        assert.equal(h.rewriteCount(), 1);
        assert.equal(h.ragCalls[0].history, undefined);
        for (let i = 1; i <= 4; i++) await h.turn(`question ${i}`, `answer ${i}`);
        assert.equal(h.rewriteCount(), 1);
        assert.equal(h.llmCalls.length, 1);
        const last = h.ragCalls[4];
        assert.equal(last.query, 'question 4');
        const binding = scopeTokenBinding(TOKEN_A);
        assert.deepEqual(last.history, [
            { role: 'user', content: 'question 1', binding },
            { role: 'assistant', content: 'answer 1', binding },
            { role: 'user', content: 'question 2', binding },
            { role: 'assistant', content: 'answer 2', binding },
            { role: 'user', content: 'question 3', binding },
            { role: 'assistant', content: 'answer 3', binding },
        ]);
        assert.ok(h.ragCalls.slice(1).every((c) => Array.isArray(c.history)));
    }));

test('switch true: a response without the header puts the next follow-up back on the local rewrite', () =>
    quiet(async () => {
        const h = makePipeline('true', [true, false, true]);
        h.pipeline.setScopeToken(TOKEN_A);
        h.p.recordTurn({ role: 'assistant', content: 'greeting line' });
        await h.turn('q0');
        assert.equal(h.rewriteCount(), 1);
        await h.turn('q1');
        assert.equal(h.rewriteCount(), 1);
        assert.ok(Array.isArray(h.ragCalls[1].history));
        await h.turn('q2');
        assert.equal(h.rewriteCount(), 2);
        assert.equal(h.ragCalls[2].history, undefined);
        await h.turn('q3');
        assert.equal(h.rewriteCount(), 2);
        assert.ok(Array.isArray(h.ragCalls[3].history));
    }));

test('switch true: a failed voice-rag response clears the flag', () =>
    quiet(async () => {
        const h = makePipeline('true', [true]);
        h.pipeline.setScopeToken(TOKEN_A);
        h.p.recordTurn({ role: 'assistant', content: 'greeting line' });
        await h.turn('q0');
        h.p.rag.query = async (query: string, token?: string, userId?: string, history?: HistoryTurn[]) => {
            h.ragCalls.push({ query, token, userId, history });
            return { ok: false, reason: 'unavailable' };
        };
        await h.p.retrieve('q1', h.p.currentRequestId);
        await h.p.retrieve('q2', h.p.currentRequestId);
        assert.ok(Array.isArray(h.ragCalls[1].history));
        assert.equal(h.ragCalls[2].history, undefined);
        assert.equal(h.rewriteCount(), 2);
    }));

test('switch true: without a scope token the local rewrite runs and no history is sent', () =>
    quiet(async () => {
        const h = makePipeline('true', [true]);
        h.p.recordTurn({ role: 'assistant', content: 'greeting line' });
        await h.turn('q0');
        await h.turn('q1');
        assert.equal(h.rewriteCount(), 2);
        assert.ok(h.ragCalls.every((c) => c.history === undefined));
    }));

test('each turn keeps the binding of the token in use when it was recorded, across sessions', () =>
    quiet(async () => {
        const a = makePipeline('true', [true]);
        a.pipeline.setScopeToken(TOKEN_A);
        a.p.recordTurn({ role: 'assistant', content: 'greeting a' });
        const b = makePipeline('true', [true]);
        b.pipeline.setScopeToken(TOKEN_B);
        b.p.recordTurn({ role: 'assistant', content: 'greeting b' });
        await a.turn('qa0', 'aa0');
        await b.turn('qb0', 'ab0');
        await a.turn('qa1');
        await b.turn('qb1');
        const bindingA = scopeTokenBinding(TOKEN_A);
        const bindingB = scopeTokenBinding(TOKEN_B);
        assert.notEqual(bindingA, bindingB);
        assert.ok(Array.isArray(a.ragCalls[1].history), 'session A follow-up sends history');
        assert.ok(Array.isArray(b.ragCalls[1].history), 'session B follow-up sends history');
        assert.ok(a.ragCalls[1].history!.every((t) => t.binding === bindingA));
        assert.ok(b.ragCalls[1].history!.every((t) => t.binding === bindingB));
        assert.ok(!a.ragCalls[1].history!.some((t) => t.content.includes('qb') || t.content.includes('ab')));
    }));

test('token refresh: earlier turns keep the old binding, later turns get the new one, both sent unchanged', () =>
    quiet(async () => {
        const h = makePipeline('true', [true]);
        h.pipeline.setScopeToken(TOKEN_A);
        h.p.recordTurn({ role: 'assistant', content: 'greeting line' });
        await h.turn('before refresh', 'answer before');
        h.pipeline.setScopeToken(TOKEN_B);
        await h.turn('first after refresh', 'answer after');
        await h.turn('second after refresh');
        const oldBinding = scopeTokenBinding(TOKEN_A);
        const newBinding = scopeTokenBinding(TOKEN_B);
        assert.equal(h.ragCalls[1].token, TOKEN_B);
        assert.ok(Array.isArray(h.ragCalls[1].history), 'first follow-up after refresh sends history');
        assert.deepEqual(
            h.ragCalls[1].history!.map((t) => t.binding),
            [oldBinding, oldBinding, oldBinding]
        );
        assert.deepEqual(h.ragCalls[2].history, [
            { role: 'assistant', content: 'greeting line', binding: oldBinding },
            { role: 'user', content: 'rewritten query', binding: oldBinding },
            { role: 'assistant', content: 'answer before', binding: oldBinding },
            { role: 'user', content: 'first after refresh', binding: newBinding },
            { role: 'assistant', content: 'answer after', binding: newBinding },
        ]);
    }));

test('reset clears the server-rewrite flag so a new session starts on the local rewrite', () =>
    quiet(async () => {
        const h = makePipeline('true', [true]);
        h.pipeline.setScopeToken(TOKEN_A);
        h.p.recordTurn({ role: 'assistant', content: 'greeting line' });
        await h.turn('q0');
        h.pipeline.reset();
        h.p.recordTurn({ role: 'assistant', content: 'greeting line' });
        await h.turn('q1');
        assert.equal(h.rewriteCount(), 2);
        assert.equal(h.ragCalls[1].history, undefined);
    }));
