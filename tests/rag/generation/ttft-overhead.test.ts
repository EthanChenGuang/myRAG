import { describe, expect, it } from 'vitest';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { streamText, type StreamTextTransform, type ToolSet } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import budgets from '../../../eval/config/latency-budgets.json';
import { createAnswerCollector } from '@/lib/rag/generation/answer-collector';
import { buildAnswerTransforms } from '@/lib/rag/generation/answer-transforms';
import { aliasParserTransform } from '@/lib/rag/generation/citations/transforms';
import { NO_ANSWER_SENTINEL, sentinelTransform } from '@/lib/rag/generation/sentinel';
import { fixedText } from '@/lib/rag/lang/texts';
import { createOutputLinkPolicy } from '@/lib/rag/security/link-targets';
import { createOutputGuard } from '@/lib/rag/security/output-guard';
import { outputGuardTransform } from '@/lib/rag/security/output-guard-stream';

/**
 * Plan 05.2-38 (D-61): what the Phase 5.2 answer chain costs before the first token, on the real streamText with a fake model.
 * The chain with every switch on is citation parser, sentinel, output guard (enforce), notice and collector; the chain with
 * every switch off is what the route passes today with no Phase 5.2 switch on: no transform.
 */
type Transform = StreamTextTransform<ToolSet>;

const PROSE = 'The synthetic report lists three review steps and one owner for each step of the sample process.';
const LONGEST_WORD = Math.max(...PROSE.split(/\s+/).map((word) => word.length));
const STREAMS = 200;

function chainOn(): Transform[] {
  const collector = createAnswerCollector({
    turn: { config: { anyNonDefault: true, citationPerSentence: true, claimCheck: false }, answerLanguage: 'en' },
    channel: 'web',
  });
  const sink = { feed: () => {}, end: () => {}, finish: () => {}, fail: () => {} };
  return buildAnswerTransforms({
    citationTransforms: [aliasParserTransform(sink)],
    sentinel: sentinelTransform({ refusalText: fixedText('notices.no_information', 'en') }),
    guard: outputGuardTransform({
      createGuard: () =>
        createOutputGuard({
          mode: 'enforce',
          placeholder: fixedText('notices.link_removed', 'en'),
          language: 'en',
          links: createOutputLinkPolicy({ allowlistValue: '', siteUrl: 'https://app.fixture-site.example' }),
        }),
    }),
    noticeCollector: collector.transforms(),
  });
}

/** A model that emits one character per text delta, each only after the test releases it. */
function gatedModel(text: string) {
  let released = 0;
  let wake: (() => void) | null = null;
  const release = () => {
    released += 1;
    wake?.();
  };
  const model = new MockLanguageModelV3({
    doStream: async () => {
      let sent = 0;
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 't' });
        },
        async pull(controller) {
          while (sent >= released && sent < text.length) await new Promise<void>((resolve) => (wake = resolve));
          if (sent < text.length) {
            controller.enqueue({ type: 'text-delta', id: 't', delta: text[sent]! });
            sent += 1;
            return;
          }
          controller.enqueue({ type: 'text-end', id: 't' });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          });
          controller.close();
        },
      });
      return { stream };
    },
  });
  return { model, release, released: () => released };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Characters the model had emitted when the first UI text delta was read. */
async function charsBeforeFirstDelta(transforms: Transform[]): Promise<{ chars: number; firstDelta: string }> {
  const gated = gatedModel(PROSE);
  const result = streamText({ model: gated.model, prompt: 'question', experimental_transform: transforms, onError: () => {} });
  const reader = result.toUIMessageStream().getReader();
  let firstDelta: string | null = null;
  let chars = -1;
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.type === 'text-delta' && firstDelta === null) {
        firstDelta = value.delta;
        chars = gated.released();
      }
    }
  })();
  while (firstDelta === null && gated.released() < PROSE.length) {
    gated.release();
    await settle();
  }
  while (gated.released() < PROSE.length) gated.release();
  await reading;
  return { chars, firstDelta: firstDelta ?? '' };
}

/** Milliseconds from the streamText call to the first UI text delta, the model emitting the prose word by word at once. */
async function timeToFirstDelta(transforms: Transform[]): Promise<number> {
  const pieces = PROSE.split(/(?<= )/);
  const parts: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    ...pieces.map((delta): LanguageModelV3StreamPart => ({ type: 'text-delta', id: 't', delta })),
    { type: 'text-end', id: 't' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    },
  ];
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: convertArrayToReadableStream(parts) }) });
  const start = performance.now();
  const result = streamText({ model, prompt: 'question', experimental_transform: transforms, onError: () => {} });
  const reader = result.toUIMessageStream().getReader();
  let first: number | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === 'text-delta' && first === null) first = performance.now() - start;
  }
  return first ?? Number.POSITIVE_INFINITY;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

describe('time to first token with every Phase 5.2 switch on (D-61)', () => {
  it('releases the first text after at most the sentinel hold-back plus one word of guard hold-back', async () => {
    const off = await charsBeforeFirstDelta([]);
    const on = await charsBeforeFirstDelta(chainOn());
    expect(off.chars).toBe(1);
    expect(on.chars).toBeGreaterThan(0);
    expect(on.chars).toBeLessThanOrEqual(NO_ANSWER_SENTINEL.length + LONGEST_WORD + 1);
    expect(PROSE.startsWith(on.firstDelta)).toBe(true);
    console.log(`[TTFT] first UI text delta after ${on.chars} model characters with the chain on (off: ${off.chars})`);
  });

  it('keeps the median first-token overhead over 200 streams under the chat first-token budget', async () => {
    const offTimes: number[] = [];
    const onTimes: number[] = [];
    for (let i = 0; i < STREAMS; i += 1) {
      offTimes.push(await timeToFirstDelta([]));
      onTimes.push(await timeToFirstDelta(chainOn()));
    }
    const overhead = median(onTimes) - median(offTimes);
    const allowance = budgets.ttft.chat.miss.p50_ms;
    console.log(
      `[TTFT] ${STREAMS} streams: median off ${median(offTimes).toFixed(3)} ms, on ${median(onTimes).toFixed(3)} ms, ` +
        `overhead ${overhead.toFixed(3)} ms against the chat first-token budget p50 ${allowance} ms`,
    );
    expect(Number.isFinite(overhead)).toBe(true);
    expect(overhead).toBeLessThan(allowance);
  });
});
