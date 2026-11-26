import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoicePipeline } from '../src/voice_agent.js';
import type { RAGQueryResult } from '../src/rag_client.js';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const TOKEN = 'scope-token-placeholder';

type Timing = { ttft_ms: number; pre_generation_ms: number };
type Report = { traceId: string; timing: Timing; token?: string };

interface Options {
    rag?: RAGQueryResult | (() => Promise<RAGQueryResult>);
    deltas?: Array<string | null>;
    clock?: number[];
    onDelta?: (index: number, p: any) => void;
    reportTiming?: (traceId: string, timing: Timing, token?: string) => Promise<void>;
}

function okResult(extra: Partial<Extract<RAGQueryResult, { ok: true }>> = {}): RAGQueryResult {
    return { ok: true, context: '', sources: [], source_images: [], serverQueryRewrite: false, ...extra };
}

function quietly<T>(fn: () => T): T {
    const saved = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    console.debug = () => {};
    const restore = () => Object.assign(console, saved);
    try {
        const out = fn();
        if (out instanceof Promise) return out.finally(restore) as T;
        restore();
        return out;
    } catch (error) {
        restore();
        throw error;
    }
}

function makePipeline(options: Options = {}) {
    delete process.env.VOICE_SERVER_QUERY_REWRITE;
    const pipeline = quietly(
        () =>
            new VoicePipeline(
                {
                    openaiApiKey: 'key-placeholder',
                    assemblyApiKey: 'key-placeholder',
                    resembleApiKey: 'key-placeholder',
                    resembleVoiceId: 'voice-placeholder',
                    ragApiUrl: 'http://127.0.0.1:1/api/internal/voice-rag',
                    ragApiKey: 'key-placeholder',
                },
                () => {}
            )
    );
    const p = pipeline as any;
    p.scopeToken = TOKEN;
    const reports: Report[] = [];
    const events: string[] = [];
    p.rag = {
        query: async () => {
            const rag = options.rag ?? okResult({ traceId: TRACE_ID });
            return typeof rag === 'function' ? rag() : rag;
        },
        reportTiming:
            options.reportTiming ??
            (async (traceId: string, timing: Timing, token?: string) => {
                events.push('report');
                reports.push({ traceId, timing, token });
            }),
    };
    const deltas = options.deltas ?? ['', 'Hello there. ', 'More text'];
    p.llm = {
        chat: {
            completions: {
                create: async () => {
                    events.push('llm_call');
                    return (async function* () {
                        for (let index = 0; index < deltas.length; index++) {
                            options.onDelta?.(index, p);
                            events.push(`delta:${index}`);
                            yield { choices: [{ delta: { content: deltas[index] } }] };
                        }
                    })();
                },
            },
        },
    };
    p.rewriteQueryWithContext = async (query: string) => query;
    p.synthesizeToQueue = async (_sentence: string, num: number, queue: Map<number, Buffer>) => {
        queue.set(num, Buffer.alloc(0));
        return 0;
    };
    if (options.clock) {
        const ticks = [...options.clock];
        p.clock = () => {
            const next = ticks.shift();
            if (next === undefined) throw new Error('clock read more often than expected');
            return next;
        };
    }
    return { pipeline, p, reports, events };
}

test('pre_generation_ms ends at the LLM call and ttft_ms at the first non-empty delta', async () => {
    const { pipeline, reports, events } = makePipeline({ clock: [1000, 1180, 1420], deltas: ['', null, 'Hello there. ', 'More text'] });
    await quietly(() => pipeline.processUserMessage('synthetic question'));
    assert.deepEqual(reports, [{ traceId: TRACE_ID, timing: { ttft_ms: 420, pre_generation_ms: 180 }, token: TOKEN }]);
    assert.ok(events.indexOf('report') > events.indexOf('delta:2'), 'the post is made after the first non-empty delta');
    assert.ok(events.indexOf('report') < events.indexOf('delta:3'), 'the post is made at the first non-empty delta, not at the end');
});

test('exactly one post is made per turn', async () => {
    const { pipeline, reports } = makePipeline({ clock: [0, 10, 20, 100, 120, 150], deltas: ['One. ', 'Two. ', 'Three.'] });
    await quietly(() => pipeline.processUserMessage('synthetic question'));
    assert.equal(reports.length, 1);
    await quietly(() => pipeline.processUserMessage('second synthetic question'));
    assert.equal(reports.length, 2);
    assert.deepEqual(reports[1].timing, { ttft_ms: 50, pre_generation_ms: 20 });
});

test('a turn without a trace id makes no post', async () => {
    const { pipeline, reports, events } = makePipeline({ rag: okResult() });
    await quietly(() => pipeline.processUserMessage('synthetic question'));
    assert.ok(events.includes('delta:1'));
    assert.deepEqual(reports, []);
});

test('a turn whose retrieval failed makes no post and calls no LLM', async () => {
    const { pipeline, p, reports, events } = makePipeline({ rag: { ok: false, reason: 'unavailable' } });
    p.speakFixedLine = async () => {};
    await quietly(() => pipeline.processUserMessage('synthetic question'));
    assert.deepEqual(reports, []);
    assert.equal(events.includes('llm_call'), false);
});

test('a turn interrupted before any delta makes no post', async () => {
    const { pipeline, reports } = makePipeline({
        deltas: ['', 'Hello there. '],
        onDelta: (index, p) => {
            if (index === 1) p.cancelCurrentPlayback = true;
        },
    });
    await quietly(() => pipeline.processUserMessage('synthetic question'));
    assert.deepEqual(reports, []);
});

test('the turn does not wait for the timing post', async () => {
    let calls = 0;
    const { pipeline, events } = makePipeline({
        reportTiming: () => {
            calls++;
            return new Promise<void>(() => {});
        },
    });
    const finished = await quietly(() =>
        Promise.race([
            pipeline.processUserMessage('synthetic question').then(() => 'done'),
            new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
        ])
    );
    assert.equal(finished, 'done');
    assert.equal(calls, 1);
    assert.ok(events.includes('delta:2'));
});

test('a rejecting timing post does not fail the turn', async () => {
    const { pipeline } = makePipeline({ reportTiming: () => Promise.reject(new Error('post failed')) });
    await assert.doesNotReject(quietly(() => pipeline.processUserMessage('synthetic question')));
});

test('a throwing timing post does not fail the turn', async () => {
    const { pipeline } = makePipeline({
        reportTiming: () => {
            throw new Error('post failed');
        },
    });
    await assert.doesNotReject(quietly(() => pipeline.processUserMessage('synthetic question')));
});
