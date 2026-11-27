import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    accumulateToolCalls,
    applyReplacement,
    createToolCallAccumulator,
    estimateTokens,
    splitSentences,
    stripAliasMarkers,
    summarizeCheck,
    trimHistory,
    type HistoryMessage,
} from '../src/calc_tool.js';

test('interleaved deltas of two calls assemble into two complete calls with parsed arguments', () => {
    const calls = accumulateToolCalls([
        [{ index: 0, id: 'call_a', type: 'function', function: { name: 'calculate', arguments: '{"oper' } }],
        [{ index: 1, id: 'call_b', type: 'function', function: { name: 'calculate', arguments: '{"x":' } }],
        [{ index: 0, function: { arguments: 'ands":[]}' } }],
        [{ index: 1, function: { arguments: '2}' } }],
    ]);
    assert.equal(calls.length, 2);
    assert.deepEqual(
        calls.map((c) => ({ index: c.index, id: c.id, name: c.name, valid: c.valid, args: c.arguments })),
        [
            { index: 0, id: 'call_a', name: 'calculate', valid: true, args: { operands: [] } },
            { index: 1, id: 'call_b', name: 'calculate', valid: true, args: { x: 2 } },
        ]
    );
    assert.equal(calls[0].argumentsText, '{"operands":[]}');
});

test('malformed or non-object arguments yield a call marked invalid', () => {
    const calls = accumulateToolCalls([
        [{ index: 0, id: 'call_a', function: { name: 'calculate', arguments: '{"broken"' } }],
        [{ index: 1, id: 'call_b', function: { name: 'calculate', arguments: '[1,2]' } }],
        [{ index: 2, id: 'call_c', function: { name: '', arguments: '{}' } }],
    ]);
    assert.deepEqual(
        calls.map((c) => [c.valid, c.arguments]),
        [
            [false, null],
            [false, null],
            [false, {}],
        ]
    );
});

test('a call without an id gets a stable id from its index; the accumulator adds batches incrementally', () => {
    const acc = createToolCallAccumulator();
    assert.equal(acc.size(), 0);
    acc.add([{ index: 3, function: { name: 'calculate', arguments: '{}' } }]);
    assert.equal(acc.size(), 1);
    const [call] = acc.calls();
    assert.equal(call.id, 'call_3');
    assert.equal(call.valid, true);
});

test('applyReplacement replaces exactly the returned span', () => {
    assert.equal(applyReplacement('The total is 120 units.', { start: 13, end: 16, text: '125' }), 'The total is 125 units.');
});

test('applyReplacement ignores a span outside the text or malformed', () => {
    const text = 'The total is 120 units.';
    assert.equal(applyReplacement(text, { start: 13, end: 99, text: '125' }), text);
    assert.equal(applyReplacement(text, { start: -1, end: 3, text: 'x' }), text);
    assert.equal(applyReplacement(text, { start: 8, end: 4, text: 'x' }), text);
    assert.equal(applyReplacement(text, { start: 1.5, end: 3, text: 'x' }), text);
    assert.equal(applyReplacement(text, null), text);
});

test('stripAliasMarkers removes [S1]-style markers and keeps the rest of the text', () => {
    assert.equal(stripAliasMarkers('The sum is 12 [S1]. The rate is 3 [S2][S10].'), 'The sum is 12. The rate is 3.');
    assert.equal(stripAliasMarkers('Both apply [S1, S2] today.'), 'Both apply today.');
    assert.equal(stripAliasMarkers('No markers [here] or [S0] or [s1].'), 'No markers [here] or [S0] or [s1].');
});

test('estimateTokens is one token per three characters, rounded up', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('ab'), 1);
    assert.equal(estimateTokens('abc'), 1);
    assert.equal(estimateTokens('abcd'), 2);
    assert.equal(estimateTokens('x'.repeat(300)), 100);
});

function turn(i: number, size: number): HistoryMessage[] {
    return [
        { role: 'user', content: `question ${i} ` + 'q'.repeat(size) },
        { role: 'assistant', content: `answer ${i} ` + 'a'.repeat(size) },
    ];
}

test('trimHistory keeps everything when the history fits its share', () => {
    const history: HistoryMessage[] = [{ role: 'system', content: 'system text' }, ...turn(1, 10), ...turn(2, 10)];
    const out = trimHistory(history, { contextLength: 100_000 });
    assert.deepEqual(out.messages, history);
    assert.equal(out.dropped, 0);
    assert.ok(out.historyTokens > 0);
});

test('trimHistory drops oldest whole turns, keeps the system message and the current question', () => {
    const current: HistoryMessage = { role: 'user', content: 'current synthetic question' };
    const history: HistoryMessage[] = [{ role: 'system', content: 'system text' }, ...turn(1, 1200), ...turn(2, 1200), ...turn(3, 30), current];
    // share 0.25 of 4096 = 1024 tokens; each 1,200-character turn is about 816 tokens
    const out = trimHistory(history, { contextLength: 4096 });
    assert.equal(out.messages[0].role, 'system');
    assert.equal(out.messages[out.messages.length - 1], current);
    const contents = out.messages.map((m) => String(m.content).split(' ').slice(0, 2).join(' '));
    assert.deepEqual(contents, ['system text', 'question 2', 'answer 2', 'question 3', 'answer 3', 'current synthetic']);
    assert.equal(out.dropped, 2);
    assert.ok(out.historyTokens <= 1024);
});

test('trimHistory never drops the current question, even when nothing else fits', () => {
    const current: HistoryMessage = { role: 'user', content: 'c'.repeat(9000) };
    const out = trimHistory([{ role: 'system', content: 's' }, ...turn(1, 1000), current], { contextLength: 1024 });
    assert.deepEqual(out.messages.map((m) => m.role), ['system', 'user']);
    assert.equal(out.messages[1], current);
    assert.equal(out.historyTokens, 0);
});

test('trimHistory keeps a turn with its tool messages together and honours a custom share', () => {
    const history: HistoryMessage[] = [
        { role: 'assistant', content: 'greeting' },
        { role: 'user', content: 'u'.repeat(300) },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_0' }] },
        { role: 'tool', content: 't'.repeat(300), tool_call_id: 'call_0' },
        { role: 'assistant', content: 'a'.repeat(300) },
        { role: 'user', content: 'short' },
        { role: 'assistant', content: 'reply' },
    ];
    const out = trimHistory(history, { contextLength: 1024, historyShare: 0.1 });
    assert.deepEqual(out.messages.map((m) => m.content), ['short', 'reply']);
    assert.equal(out.dropped, 5);
});

test('splitSentences splits on punctuation followed by whitespace and keeps the last fragment', () => {
    assert.deepEqual(splitSentences('One. Two! Three? Four'), ['One.', 'Two!', 'Three?', 'Four']);
    assert.deepEqual(splitSentences('  '), []);
    assert.deepEqual(splitSentences('The value is 1.5 units. Done.'), ['The value is 1.5 units.', 'Done.']);
});

test('summarizeCheck takes the corrected check first, else the first check, else not_verified', () => {
    assert.deepEqual(summarizeCheck(null), { stated: null, recomputed: null, status: 'not_verified' });
    assert.deepEqual(
        summarizeCheck({
            checks: [
                { status: 'verified', stated: '2', recomputed: '2' },
                { status: 'corrected', stated: '120', recomputed: '125' },
            ],
            notices: [],
            replacement: { start: 0, end: 3, text: '125' },
        }),
        { stated: '120', recomputed: '125', status: 'corrected' }
    );
    assert.deepEqual(summarizeCheck({ checks: [{ status: 'verified', stated: '7', recomputed: '7' }], notices: [], replacement: null }), {
        stated: '7',
        recomputed: '7',
        status: 'verified',
    });
    assert.deepEqual(summarizeCheck({ checks: [], notices: [], replacement: null }), { stated: null, recomputed: null, status: 'not_verified' });
});

// ---------------------------------------------------------------------------------------------------------------
// Pipeline (D-76, D-87): the tool loop, held speech and the history trim, with a fake LLM stream

import { VoicePipeline } from '../src/voice_agent.js';
import type { RAGQueryResult, VoiceCalcCheck, VoiceCalcOffer } from '../src/rag_client.js';

const SCOPE_TOKEN = 'scope-token-placeholder';
const CHUNK = '11111111-1111-4111-8111-111111111111';
const OFFER: VoiceCalcOffer = { offered: true, check: true, sources: [{ alias: 'S1', chunk_id: CHUNK }], tool_schema: { type: 'object' } };
const TOOL_ARGS = { operands: [{ name: 'a', value: '120', source: { kind: 'chunk', alias: 'S1' } }], steps: [], result: 'a' };
const TOOL_RESULT = { status: 'ok', value: '125', unit: null, steps: [], reject_reason: null };

type Chunk = { content?: string; tool_calls?: unknown[] };

function toolCallChunks(id = 'call_1'): Chunk[] {
    const args = JSON.stringify(TOOL_ARGS);
    return [
        { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'calculate', arguments: args.slice(0, 10) } }] },
        { tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] },
    ];
}

function silence<T>(fn: () => Promise<T>): Promise<T> {
    const saved = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    console.debug = () => {};
    return fn().finally(() => Object.assign(console, saved));
}

interface HarnessOptions {
    rag: RAGQueryResult;
    rounds: Chunk[][];
    check?: VoiceCalcCheck | null;
    executeResult?: unknown;
    contextLength?: string;
}

function harness(options: HarnessOptions) {
    delete process.env.VOICE_SERVER_QUERY_REWRITE;
    const savedLength = process.env.VOICE_AGENT_CONTEXT_LENGTH;
    if (options.contextLength === undefined) delete process.env.VOICE_AGENT_CONTEXT_LENGTH;
    else process.env.VOICE_AGENT_CONTEXT_LENGTH = options.contextLength;
    const saved = { log: console.log };
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
        console.log = saved.log;
        if (savedLength === undefined) delete process.env.VOICE_AGENT_CONTEXT_LENGTH;
        else process.env.VOICE_AGENT_CONTEXT_LENGTH = savedLength;
    }
    const p = pipeline as any;
    p.scopeToken = SCOPE_TOKEN;
    const events: string[] = [];
    const spoken: string[] = [];
    const llmCalls: any[] = [];
    const queryArgs: unknown[][] = [];
    const executeCalls: unknown[][] = [];
    const checkCalls: unknown[][] = [];
    p.rag = {
        query: async (...args: unknown[]) => {
            queryArgs.push(args);
            return options.rag;
        },
        reportTiming: async () => {},
        executeCalc: async (...args: unknown[]) => {
            events.push('execute');
            executeCalls.push(args);
            return options.executeResult === undefined ? TOOL_RESULT : options.executeResult;
        },
        checkCalc: async (...args: unknown[]) => {
            events.push('check');
            checkCalls.push(args);
            return options.check === undefined ? null : options.check;
        },
    };
    p.llm = {
        chat: {
            completions: {
                create: async (args: any) => {
                    llmCalls.push({ ...args, messages: [...args.messages] });
                    const round = options.rounds[Math.min(llmCalls.length - 1, options.rounds.length - 1)];
                    return (async function* () {
                        for (const delta of round) yield { choices: [{ delta }] };
                    })();
                },
            },
        },
    };
    p.rewriteQueryWithContext = async (query: string) => query;
    p.synthesizeToQueue = async (sentence: string, num: number, queue: Map<number, Buffer>) => {
        events.push(`tts:${sentence}`);
        spoken.push(sentence);
        queue.set(num, Buffer.alloc(0));
        return 0;
    };
    return { pipeline, p, events, spoken, llmCalls, queryArgs, executeCalls, checkCalls };
}

function ok(extra: Partial<Extract<RAGQueryResult, { ok: true }>> = {}): RAGQueryResult {
    return { ok: true, context: '[S1] [Context from document d]: block', sources: [], source_images: [], serverQueryRewrite: false, ...extra };
}

test('pipeline: without a calc offer the request has no tools and speech streams sentence by sentence as today', async () => {
    const h = harness({ rag: ok({ context: 'plain context' }), rounds: [[{ content: 'First part. ' }, { content: 'Second [S1] part' }]] });
    await silence(() => h.pipeline.processUserMessage('synthetic question'));
    assert.equal(h.llmCalls.length, 1);
    assert.equal('tools' in h.llmCalls[0], false);
    assert.deepEqual(h.spoken, ['First part.', 'Second [S1] part']);
    assert.deepEqual(h.queryArgs, [['synthetic question', SCOPE_TOKEN, undefined]]);
    const history = h.pipeline.getConversationHistory();
    assert.equal(history[1].content, 'First part. Second [S1] part');
    assert.equal('calc' in history[1], false);
    assert.equal(h.events.includes('check'), false);
});

test('pipeline: a tool turn executes the call, holds speech until the check, and speaks the recomputed value', async () => {
    const text = 'The total is 120 [S1]. Done.';
    const h = harness({
        rag: ok({ calc: OFFER }),
        rounds: [toolCallChunks(), [{ content: 'The total is ' }, { content: '120 [S1]. ' }, { content: 'Done.' }]],
        check: { checks: [{ status: 'corrected', stated: '120', recomputed: '125' }], notices: [], replacement: { start: 13, end: 16, text: '125' } },
    });
    await silence(() => h.pipeline.processUserMessage('synthetic question'));

    assert.equal(h.llmCalls.length, 2);
    assert.equal(h.llmCalls[0].tools[0].function.name, 'calculate');
    assert.deepEqual(h.llmCalls[0].tools[0].function.parameters, OFFER.tool_schema);
    assert.deepEqual(h.executeCalls, [[TOOL_ARGS, 'synthetic question', OFFER.sources, SCOPE_TOKEN]]);
    const second = h.llmCalls[1].messages;
    assert.deepEqual(second[second.length - 2], {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'calculate', arguments: JSON.stringify(TOOL_ARGS) } }],
    });
    assert.deepEqual(second[second.length - 1], { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify(TOOL_RESULT) });

    assert.deepEqual(h.checkCalls, [[text, [{ origin: 'tool', request: TOOL_ARGS, result: TOOL_RESULT, anchor_offset: 0 }], 'synthetic question', OFFER.sources, SCOPE_TOKEN]]);
    assert.deepEqual(h.spoken, ['The total is 125.', 'Done.']);
    assert.ok(h.events.indexOf('check') < h.events.findIndex((e) => e.startsWith('tts:')), 'nothing is spoken before the check answers');

    const history = h.pipeline.getConversationHistory();
    assert.equal(history[1].content, 'The total is 125. Done.');
    assert.deepEqual(history[1].calc, { stated: '120', recomputed: '125', status: 'corrected' });
});

test('pipeline: when the check fails the held text is spoken with markers removed and recorded not_verified', async () => {
    const h = harness({ rag: ok({ calc: OFFER }), rounds: [toolCallChunks(), [{ content: 'The total is 120 [S1]. Done.' }]], check: null });
    await silence(() => h.pipeline.processUserMessage('synthetic question'));
    assert.equal(h.checkCalls.length, 1);
    assert.deepEqual(h.spoken, ['The total is 120.', 'Done.']);
    const history = h.pipeline.getConversationHistory();
    assert.equal(history[1].content, 'The total is 120. Done.');
    assert.deepEqual(history[1].calc, { stated: null, recomputed: null, status: 'not_verified' });
});

test('pipeline: an offered turn without a tool call streams as today with markers removed and no check', async () => {
    const h = harness({ rag: ok({ calc: OFFER }), rounds: [[{ content: 'Plain answer [S1]. ' }, { content: 'More' }]] });
    await silence(() => h.pipeline.processUserMessage('synthetic question'));
    assert.equal(h.llmCalls.length, 1);
    assert.equal(h.llmCalls[0].tools.length, 1);
    assert.deepEqual(h.spoken, ['Plain answer.', 'More']);
    assert.equal(h.checkCalls.length, 0);
    const history = h.pipeline.getConversationHistory();
    assert.equal(history[1].content, 'Plain answer. More');
    assert.equal('calc' in history[1], false);
});

test('pipeline: a runaway tool loop stops after two tool rounds and the last request carries no tools', async () => {
    const h = harness({ rag: ok({ calc: OFFER }), rounds: [toolCallChunks('call_1'), toolCallChunks('call_2'), [{ content: 'Final 125 [S1].' }]], check: null });
    await silence(() => h.pipeline.processUserMessage('synthetic question'));
    assert.equal(h.llmCalls.length, 3);
    assert.ok(h.llmCalls[0].tools && h.llmCalls[1].tools);
    assert.equal('tools' in h.llmCalls[2], false);
    assert.equal(h.executeCalls.length, 2);
    assert.deepEqual(h.spoken, ['Final 125.']);
});

test('pipeline: with the check off a tool turn speaks the text after the tool without a check call', async () => {
    const h = harness({ rag: ok({ calc: { ...OFFER, check: false } }), rounds: [toolCallChunks(), [{ content: 'The total is 125 [S1]. ' }, { content: 'Done.' }]] });
    await silence(() => h.pipeline.processUserMessage('synthetic question'));
    assert.equal(h.checkCalls.length, 0);
    assert.deepEqual(h.spoken, ['The total is 125.', 'Done.']);
    assert.deepEqual(h.pipeline.getConversationHistory()[1].calc, { stated: null, recomputed: null, status: 'not_verified' });
});

test('pipeline: an invalid tool call is answered without calling the route', async () => {
    const h = harness({
        rag: ok({ calc: OFFER }),
        rounds: [[{ tool_calls: [{ index: 0, id: 'call_x', function: { name: 'calculate', arguments: '{"broken' } }] }], [{ content: 'No result.' }]],
    });
    await silence(() => h.pipeline.processUserMessage('synthetic question'));
    assert.equal(h.executeCalls.length, 0);
    assert.equal(h.checkCalls.length, 0, 'no trace, so nothing to check');
    const second = h.llmCalls[1].messages;
    assert.deepEqual(second[second.length - 1], { role: 'tool', tool_call_id: 'call_x', content: JSON.stringify({ status: 'rejected', reject_reason: 'invalid_request' }) });
    assert.deepEqual(h.spoken, ['No result.']);
});

test('pipeline: with VOICE_AGENT_CONTEXT_LENGTH the history is trimmed and its size is sent to voice-rag', async () => {
    const h = harness({ rag: ok({ context: 'plain context' }), rounds: [[{ content: 'Answer.' }]], contextLength: '1024' });
    const p = h.p;
    p.history.push({ role: 'user', content: 'old question ' + 'q'.repeat(1500) });
    p.history.push({ role: 'assistant', content: 'old answer ' + 'a'.repeat(1500) });
    p.history.push({ role: 'user', content: 'recent question' });
    p.history.push({ role: 'assistant', content: 'recent answer' });
    await silence(() => h.pipeline.processUserMessage('synthetic question'));
    const [args] = h.queryArgs;
    assert.equal(args.length, 5);
    assert.equal(args[3], undefined);
    assert.equal(typeof args[4], 'number');
    assert.ok((args[4] as number) > 0 && (args[4] as number) <= 256);
    const sent = h.llmCalls[0].messages.map((m: any) => m.content);
    assert.deepEqual(sent.slice(1), ['recent question', 'recent answer', 'synthetic question']);
    // the stored transcript keeps every turn
    assert.equal(h.pipeline.getConversationHistory().length, 6);
});

test('pipeline: a tool turn superseded during the check speaks, publishes and stores nothing', async () => {
    const outputs: any[] = [];
    const h = harness({ rag: ok({ calc: OFFER }), rounds: [toolCallChunks(), [{ content: 'The total is 120 [S1].' }]] });
    h.p.onTextOutput = (payload: any) => outputs.push(payload);
    h.p.rag.checkCalc = async () => {
        h.p.currentRequestId = -1;
        return null;
    };
    await silence(() => h.pipeline.processUserMessage('synthetic question'));
    assert.deepEqual(h.spoken, []);
    assert.equal(outputs.some((o) => o.isPartial === false), false);
    assert.equal(outputs.some((o) => typeof o.text === 'string' && o.text.includes('120')), false, 'held text is never displayed');
    assert.equal(h.pipeline.getConversationHistory().length, 0);
});
