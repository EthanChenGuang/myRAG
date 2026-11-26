import { describe, expect, it } from 'vitest';
import { jsonSchema, stepCountIs, streamText, tool, type StreamTextTransform, type TextStreamPart, type ToolSet, type UIMessageChunk } from 'ai';
import type { AnswerNotice } from '@/lib/rag-eval/contracts.generated';
import { createAnswerCollector, type AnswerCollector } from '@/lib/rag/generation/answer-collector';
import { applyAnswerPipelineToText, buildAnswerTransforms } from '@/lib/rag/generation/answer-transforms';
import type { AnswerChannel } from '@/lib/rag/generation/answer-turn';
import { emitNotice } from '@/lib/rag/generation/notices';
import { NO_ANSWER_SENTINEL, sentinelTransform } from '@/lib/rag/generation/sentinel';
import { fixedText } from '@/lib/rag/lang/texts';
import { streamModelFromPieces, type MockFinishReason, type StreamModelOptions } from '../../helpers/stream-model';

type Transform = StreamTextTransform<ToolSet>;

const REFUSAL = fixedText('notices.no_information', 'en');
const SYNTHETIC: AnswerNotice = { kind: 'calc_not_verified', text: 'A synthetic notice line for the test.', language: 'en' };

const lookup = tool({
  description: 'Look something up',
  inputSchema: jsonSchema<{ query: string }>({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
  execute: async () => ({ results: [] }),
});

const passThrough = (): Transform => () => new TransformStream();

function turn(overrides: { perSentence?: boolean; anyNonDefault?: boolean } = {}) {
  return {
    config: { anyNonDefault: overrides.anyNonDefault ?? true, citationPerSentence: overrides.perSentence ?? false, claimCheck: false },
    answerLanguage: 'en',
  };
}

/** A transform in the guard slot that adds one notice to the collector at the first text delta. */
function noticeAdder(collector: AnswerCollector, notice: AnswerNotice): Transform {
  return () => {
    let added = false;
    return new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
      transform(part, controller) {
        if (part.type === 'text-delta' && !added) {
          added = true;
          collector.addNotice(notice);
        }
        controller.enqueue(part);
      },
    });
  };
}

interface RunInput {
  pieces: string[];
  finishReason?: MockFinishReason;
  options?: StreamModelOptions;
  channel?: AnswerChannel;
  sentinel?: boolean;
  addNotice?: AnswerNotice;
}

async function run(input: RunInput) {
  const collector = createAnswerCollector({ turn: turn(), channel: input.channel ?? 'web' });
  const chain = buildAnswerTransforms({
    citationTransforms: [],
    sentinel: input.sentinel
      ? sentinelTransform({ refusalText: REFUSAL, onRefusal: () => collector.markRefused(), onStripped: (n) => collector.countStripped(n) })
      : null,
    guard: input.addNotice ? noticeAdder(collector, input.addNotice) : null,
    noticeCollector: collector.transforms(),
  });
  const result = streamText({
    model: streamModelFromPieces(input.pieces, input.finishReason ?? 'stop', input.options ?? {}),
    prompt: 'question',
    tools: { lookup },
    stopWhen: stepCountIs(4),
    experimental_transform: chain,
    onError: () => {},
  });
  let responseText: string | null = null;
  let finishMetadata: unknown;
  const chunks: UIMessageChunk[] = [];
  const reader = result
    .toUIMessageStream({
      messageMetadata: ({ part }) => (part.type === 'finish' ? collector.finishMetadata() : undefined),
      onFinish: ({ responseMessage }) => {
        responseText = responseMessage.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
      },
    })
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    if (value.type === 'finish') finishMetadata = value.messageMetadata;
  }
  const text = chunks
    .filter((chunk): chunk is Extract<UIMessageChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map((chunk) => chunk.delta)
    .join('');
  return { collector, text, responseText: responseText as string | null, finishMetadata };
}

describe('buildAnswerTransforms order (D-35, D-64)', () => {
  const citation = passThrough();
  const sentinel = passThrough();
  const calc = passThrough();
  const guard = passThrough();
  const notice = passThrough();
  const collect = passThrough();

  it('returns the citation transforms unchanged when nothing else is enabled', () => {
    const citations = [citation];
    expect(buildAnswerTransforms({ citationTransforms: citations })).toEqual(citations);
    expect(buildAnswerTransforms({ citationTransforms: citations })[0]).toBe(citation);
    expect(buildAnswerTransforms({ citationTransforms: [] })).toEqual([]);
  });

  it('assembles citation, sentinel, calculation, guard, notice and collector in that order', () => {
    const chain = buildAnswerTransforms({
      citationTransforms: [citation],
      sentinel,
      calcBlock: calc,
      guard,
      noticeCollector: [notice, collect],
    });
    expect(chain).toHaveLength(6);
    [citation, sentinel, calc, guard, notice, collect].forEach((transform, i) => expect(chain[i]).toBe(transform));
  });

  it('skips empty slots without reordering the rest', () => {
    const chain = buildAnswerTransforms({ citationTransforms: [citation], sentinel, noticeCollector: [notice, collect] });
    expect(chain).toHaveLength(4);
    [citation, sentinel, notice, collect].forEach((transform, i) => expect(chain[i]).toBe(transform));
  });
});

describe('the chain on the real streamText', () => {
  it('streams the registry refusal for a token answer and reports refusedByModel', async () => {
    const out = await run({ pieces: [NO_ANSWER_SENTINEL.slice(0, 5), NO_ANSWER_SENTINEL.slice(5)], sentinel: true });
    expect(out.text).toBe(REFUSAL);
    expect(out.collector.refusedByModel()).toBe(true);
    expect(out.collector.finalText()).toBe(out.responseText);
  });

  it('streams an ordinary answer unchanged with the collector text equal to onFinish', async () => {
    const out = await run({ pieces: ['First fact. ', 'Second ', 'fact.'], sentinel: true });
    expect(out.text).toBe('First fact. Second fact.');
    expect(out.collector.refusedByModel()).toBe(false);
    expect(out.collector.finalText()).toBe(out.responseText);
    expect(out.collector.finishReason()).toBe('stop');
  });

  it('web channel: a notice added during the stream goes to the metadata, not the text', async () => {
    const out = await run({ pieces: ['Answer text.'], addNotice: SYNTHETIC, channel: 'web' });
    expect(out.text).toBe('Answer text.');
    expect(out.collector.notices()).toEqual([SYNTHETIC]);
    expect((out.finishMetadata as { notices?: unknown }).notices).toEqual([SYNTHETIC]);
    expect(out.collector.finalText()).toBe(out.responseText);
  });

  it('plain-text channel: the notice is one final text delta after a blank line', async () => {
    const out = await run({ pieces: ['Answer text.'], addNotice: SYNTHETIC, channel: 'whatsapp' });
    expect(out.text).toBe(`Answer text.\n\n${SYNTHETIC.text}`);
    expect(out.collector.notices()).toEqual([SYNTHETIC]);
    expect((out.finishMetadata as { notices?: unknown }).notices).toBeUndefined();
    expect(out.collector.finalText()).toBe(out.responseText);
  });

  it('keeps an exact duplicate notice once', async () => {
    const collector = createAnswerCollector({ turn: turn(), channel: 'web' });
    collector.addNotice(SYNTHETIC);
    collector.addNotice({ ...SYNTHETIC });
    expect(collector.notices()).toEqual([SYNTHETIC]);
  });

  it('opens a new text block when the final step has none (tool step first)', async () => {
    const out = await run({
      pieces: [],
      options: { before: [{ pieces: ['Looking it up.'], toolCall: { toolName: 'lookup', input: { query: 'q' } } }] },
      addNotice: SYNTHETIC,
      channel: 'whatsapp',
    });
    expect(out.text).toBe(`Looking it up.\n\n${SYNTHETIC.text}`);
    expect(out.collector.finalText()).toBe(out.responseText);
  });

  it('a truncated answer with no text at all gets only the notice, without a leading blank line', async () => {
    const out = await run({ pieces: [], finishReason: 'length', channel: 'whatsapp' });
    const notice = emitNotice('answer_truncated', { language: 'en' });
    expect(out.text).toBe(notice.text);
    expect(out.collector.finalText()).toBe(out.responseText);
  });

  it('a tool step followed by a final answer finishes without holding finish-step', async () => {
    const out = await run({
      pieces: ['Final answer.'],
      options: { before: [{ pieces: [], toolCall: { toolName: 'lookup', input: { query: 'q' } } }] },
      sentinel: true,
      channel: 'whatsapp',
    });
    expect(out.text).toBe('Final answer.');
    expect(out.collector.finishReason()).toBe('stop');
  });
});

describe('applyAnswerPipelineToText (whole-text twin)', () => {
  const cases: Array<{ name: string; pieces: string[]; finishReason: MockFinishReason; channel: AnswerChannel }> = [
    { name: 'plain answer, web', pieces: ['One fact. ', 'Two facts.'], finishReason: 'stop', channel: 'web' },
    { name: 'token answer, web', pieces: [NO_ANSWER_SENTINEL], finishReason: 'stop', channel: 'web' },
    { name: 'cut answer, web', pieces: ['One fact. Two'], finishReason: 'length', channel: 'web' },
    { name: 'cut answer, whatsapp', pieces: ['One fact. Two'], finishReason: 'length', channel: 'whatsapp' },
    { name: 'token answer cut, whatsapp', pieces: [NO_ANSWER_SENTINEL, ' rest'], finishReason: 'length', channel: 'whatsapp' },
  ];

  for (const c of cases) {
    it(`gives the stream's text, refusal and notices: ${c.name}`, async () => {
      const streamed = await run({ pieces: c.pieces, finishReason: c.finishReason, channel: c.channel, sentinel: true });
      const whole = applyAnswerPipelineToText(c.pieces.join(''), {
        refusalText: REFUSAL,
        finishReason: c.finishReason,
        language: 'en',
        channel: c.channel,
      });
      expect(whole.text).toBe(streamed.collector.finalText());
      expect(whole.refused).toBe(streamed.collector.refusedByModel());
      expect(whole.notices).toEqual(streamed.collector.notices());
      expect(whole.truncated).toBe(streamed.collector.truncated());
    });
  }
});
