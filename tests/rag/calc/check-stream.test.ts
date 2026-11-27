import { stepCountIs, streamText, type UIMessageChunk } from 'ai';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CALC_BLOCK_CLOSE, CALC_BLOCK_OPEN } from '@/lib/rag/calc/block-tag';
import { createCalcTraceHolder, type CalcTraceHolder } from '@/lib/rag/calc/trace-holder';
import { createAnswerCollector } from '@/lib/rag/generation/answer-collector';
import { buildAnswerTransforms, createCalcCheckSink, type CalcCheckSink } from '@/lib/rag/generation/answer-transforms';
import type { AnswerChannel } from '@/lib/rag/generation/answer-turn';
import { buildCalculateTool, CALCULATE_TOOL_NAME } from '@/lib/rag/generation/calc-tool';
import { emitNotice, renderNoticeAsText } from '@/lib/rag/generation/notices';
import { streamModelFromPieces, type MockStep } from '../../helpers/stream-model';

const BLOCKS = [
  { alias: 'S1', text: 'The synthetic register lists a base amount of 120 units for each item.' },
  { alias: 'S2', text: 'A separate synthetic note adds 30 units to every item.' },
];
const ALIASES = new Set(BLOCKS.map((b) => b.alias));
const QUESTION = 'What is the total amount for one item?';

const REQUEST = {
  operands: [
    { name: 'base', value: '120', unit: 'units', source: { kind: 'chunk', alias: 'S1' } },
    { name: 'extra', value: '30', unit: 'units', source: { kind: 'chunk', alias: 'S2' } },
  ],
  steps: [{ id: 'total', op: 'add', args: ['base', 'extra'] }],
  result: 'total',
};

const MISSING_OPERAND = {
  operands: [
    { name: 'base', value: '125', unit: 'units', source: { kind: 'chunk', alias: 'S1' } },
    { name: 'extra', value: '30', unit: 'units', source: { kind: 'chunk', alias: 'S2' } },
  ],
  steps: [{ id: 'total', op: 'add', args: ['base', 'extra'] }],
  result: 'total',
};

const TOOL_STEP: MockStep = { pieces: [], toolCall: { toolName: CALCULATE_TOOL_NAME, input: REQUEST } };

interface RunInput {
  pieces: string[];
  before?: MockStep[];
  channel?: AnswerChannel;
  holder?: CalcTraceHolder;
  calcCheck?: boolean;
  block?: boolean;
}

async function run(input: RunInput) {
  const holder = input.holder ?? createCalcTraceHolder();
  const sink: CalcCheckSink = createCalcCheckSink();
  const collector = createAnswerCollector({
    turn: { config: { anyNonDefault: true, citationPerSentence: false, claimCheck: false }, answerLanguage: 'en' },
    channel: input.channel ?? 'web',
  });
  const chain = buildAnswerTransforms({
    citationTransforms: [],
    ...(input.block ? { calcBlock: { onTrace: holder.recordBlock } } : {}),
    ...(input.calcCheck === false
      ? {}
      : {
          calcCheck: {
            holder,
            blocks: BLOCKS,
            question: QUESTION,
            answerLanguage: 'en',
            offered: true,
            sink,
            addNotice: (notice) => collector.addNotice(notice),
          },
        }),
    noticeCollector: collector.transforms(),
  });
  const result = streamText({
    model: streamModelFromPieces(input.pieces, 'stop', { before: input.before ?? [] }),
    prompt: QUESTION,
    tools: { [CALCULATE_TOOL_NAME]: buildCalculateTool({ aliases: ALIASES, holder }) },
    stopWhen: stepCountIs(4),
    experimental_transform: chain,
    onError: () => {},
  });
  const chunks: UIMessageChunk[] = [];
  let finishMetadata: Record<string, unknown> | undefined;
  const reader = result
    .toUIMessageStream({ messageMetadata: ({ part }) => (part.type === 'finish' ? collector.finishMetadata() : undefined) })
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    if (value.type === 'finish') finishMetadata = value.messageMetadata as Record<string, unknown> | undefined;
  }
  const text = chunks
    .filter((c): c is Extract<UIMessageChunk, { type: 'text-delta' }> => c.type === 'text-delta')
    .map((c) => c.delta)
    .join('');
  const types = chunks.map((c) => c.type);
  return { text, finishMetadata, sink, collector, types, holder };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const CORRECTED = emitNotice('calc_corrected', { language: 'en', params: { value: '150 units' } });
const NOT_VERIFIED = emitNotice('calc_not_verified', { language: 'en' });

describe('calcCheck slot at the final finish-step (D-73, D-75)', () => {
  test('tool turn with a wrong total: web notice calc_corrected with the recomputed value; streamed text is the model text', async () => {
    const out = await run({ before: [TOOL_STEP], pieces: ['The total is ', '160 units.'] });
    expect(out.text).toBe('The total is 160 units.');
    expect(out.finishMetadata?.notices).toEqual([CORRECTED]);
    const recorded = out.sink.result();
    expect(recorded?.checks).toHaveLength(1);
    expect(recorded?.primary).toMatchObject({ status: 'corrected', stated: '160', recomputed: '150', origin: 'tool' });
    expect(recorded?.reviewReasons).toEqual(['calc_mismatch']);
    expect(typeof recorded?.durationMs).toBe('number');
  });

  test('plain-text rendering: the notice is the final text delta after a blank line', async () => {
    const out = await run({ before: [TOOL_STEP], pieces: ['The total is 160 units.'], channel: 'whatsapp' });
    expect(out.text).toBe(`The total is 160 units.${renderNoticeAsText(CORRECTED)}`);
    expect(out.text.endsWith(`\n\n${CORRECTED.text}`)).toBe(true);
  });

  test('trailing block whose operand is missing from its block: calc_not_verified', async () => {
    const block = `${CALC_BLOCK_OPEN}${JSON.stringify(MISSING_OPERAND)}${CALC_BLOCK_CLOSE}`;
    const out = await run({ block: true, pieces: ['The total is 155 units.', block] });
    expect(out.text).toBe('The total is 155 units.');
    expect(out.finishMetadata?.notices).toEqual([NOT_VERIFIED]);
    expect(out.sink.result()?.primary).toMatchObject({ status: 'not_verified', origin: 'trailing_block' });
    expect(out.sink.result()?.reviewReasons).toEqual(['calc_unverified']);
  });

  test('verified turn: no notice, one verified check', async () => {
    const out = await run({ before: [TOOL_STEP], pieces: ['The total is 150 units.'] });
    expect(out.text).toBe('The total is 150 units.');
    expect(out.finishMetadata?.notices).toBeUndefined();
    expect(out.sink.result()?.checks.map((c) => c.status)).toEqual(['verified']);
    expect(out.sink.result()?.reviewReasons).toEqual([]);
  });

  test('a tool-calls finish-step never triggers the check; each finish-step is forwarded', async () => {
    const holder = createCalcTraceHolder();
    const traces = vi.spyOn(holder, 'traces');
    const out = await run({ holder, before: [TOOL_STEP], pieces: ['The total is 150 units.'] });
    expect(traces).toHaveBeenCalledTimes(1);
    expect(out.types.filter((t) => t === 'finish-step')).toHaveLength(2);
    expect(out.types.filter((t) => t === 'start-step')).toHaveLength(2);
    expect(out.types[out.types.length - 1]).toBe('finish');
  });

  test('a check that throws: not_verified with check_error, the stream completes', async () => {
    const holder = createCalcTraceHolder();
    vi.spyOn(holder, 'traces').mockImplementation(() => {
      throw new Error('boom');
    });
    const out = await run({ holder, pieces: ['The total is 150 units.'] });
    expect(out.text).toBe('The total is 150 units.');
    expect(out.types[out.types.length - 1]).toBe('finish');
    expect(out.sink.result()?.primary).toMatchObject({ status: 'not_verified', reason: 'check_error' });
    expect(out.finishMetadata?.notices).toEqual([NOT_VERIFIED]);
  });

  test('without the calcCheck input the chain is the same as before', async () => {
    const collector = createAnswerCollector({
      turn: { config: { anyNonDefault: true, citationPerSentence: false, claimCheck: false }, answerLanguage: 'en' },
      channel: 'web',
    });
    const notice = collector.transforms();
    const without = buildAnswerTransforms({ citationTransforms: [], noticeCollector: notice });
    const withNull = buildAnswerTransforms({ citationTransforms: [], calcCheck: null, noticeCollector: notice });
    expect(withNull).toEqual(without);
    expect(withNull).toHaveLength(2);
    const bare: [] = [];
    expect(buildAnswerTransforms({ citationTransforms: bare, calcCheck: null })).toBe(bare);
    const out = await run({ calcCheck: false, before: [TOOL_STEP], pieces: ['The total is 160 units.'] });
    expect(out.finishMetadata?.notices).toBeUndefined();
    expect(out.sink.result()).toBeNull();
  });
});
