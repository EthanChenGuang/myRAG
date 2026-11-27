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
