import { describe, expect, it, vi } from 'vitest';
import { jsonSchema, stepCountIs, streamText, tool, type TextStreamPart, type ToolSet } from 'ai';
import { NO_ANSWER_SENTINEL, applySentinelToText, sentinelTransform } from '@/lib/rag/generation/sentinel';
import { fixedText } from '@/lib/rag/lang/texts';
import { collectStream, streamModelFromPieces, type MockFinishReason, type StreamModelOptions } from '../../helpers/stream-model';

const TOKEN = NO_ANSWER_SENTINEL;
const REFUSAL = fixedText('notices.no_information', 'en');
const REFUSAL_WEB = fixedText('notices.no_information_web', 'en');

const webSearch = tool({
  description: 'Search the web',
  inputSchema: jsonSchema<{ query: string }>({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
  execute: async () => ({ results: [] }),
});

async function run(
  pieces: string[],
  { finishReason = 'stop', options = {}, refusalText = REFUSAL }: { finishReason?: MockFinishReason; options?: StreamModelOptions; refusalText?: string } = {},
) {
  const onRefusal = vi.fn();
  const onStripped = vi.fn();
  let finishText: string | undefined;
  const result = streamText({
    model: streamModelFromPieces(pieces, finishReason, options),
    prompt: 'question',
    tools: { webSearch },
    stopWhen: stepCountIs(4),
    experimental_transform: sentinelTransform({ refusalText, onRefusal, onStripped }),
    onFinish: (event) => {
      finishText = event.text;
    },
    onError: () => {},
  });
  const collected = await collectStream(result);
  const stripped = onStripped.mock.calls.reduce((sum, [count]) => sum + (count as number), 0);
  return { ...collected, finishText, onRefusal, stripped };
}

describe('sentinelTransform on the real streamText', () => {
  it('replaces a token split over two deltas with the refusal text', async () => {
    const out = await run([TOKEN.slice(0, 7), TOKEN.slice(7)]);
    expect(out.text).toBe(REFUSAL);
    expect(out.finishText).toBe(REFUSAL);
    expect(out.onRefusal).toHaveBeenCalledTimes(1);
    expect(out.onRefusal).toHaveBeenCalledWith({ refusalOrigin: 'model_relevance' });
  });

  it('drops the whole block when the token is followed by more text', async () => {
    const out = await run([TOKEN.slice(0, 3), TOKEN.slice(3), ' extra text']);
    expect(out.text).toBe(REFUSAL);
    expect(out.onRefusal).toHaveBeenCalledTimes(1);
  });

  it('streams an answer that only starts like the token unchanged', async () => {
    const out = await run(['%', 'Not a sentinel']);
    expect(out.text).toBe('%Not a sentinel');
    expect(out.onRefusal).not.toHaveBeenCalled();
  });

  it('strips and counts a later token', async () => {
    const out = await run(['Answer. ', TOKEN.slice(0, 5), TOKEN.slice(5), ' more']);
    expect(out.text).toBe('Answer.  more');
    expect(out.stripped).toBe(1);
    expect(out.onRefusal).not.toHaveBeenCalled();
  });

  it('appends the refusal after the text of an earlier tool step', async () => {
    const out = await run([TOKEN], {
      refusalText: REFUSAL_WEB,
      options: { before: [{ pieces: ['Let me search.'], toolCall: { toolName: 'webSearch', input: { query: 'q' } } }] },
    });
    expect(out.text).toBe(`Let me search.\n\n${REFUSAL_WEB}`);
    expect(out.stepTexts).toEqual(['Let me search.', `\n\n${REFUSAL_WEB}`]);
    expect(out.onRefusal).toHaveBeenCalledTimes(1);
  });

  it('decides a held prefix as it stands when the step ends with finish reason length', async () => {
    const out = await run(['  %%NO_'], { finishReason: 'length' });
    expect(out.text).toBe('  %%NO_');
    expect(out.onRefusal).not.toHaveBeenCalled();
  });

  it('forwards finish-step and tool parts before the next step text', async () => {
    const result = streamText({
      model: streamModelFromPieces(['Final answer.'], 'stop', {
        before: [{ pieces: ['%%'], toolCall: { toolName: 'webSearch', input: { query: 'q' } } }],
      }),
      prompt: 'question',
      tools: { webSearch },
      stopWhen: stepCountIs(4),
      experimental_transform: sentinelTransform({ refusalText: REFUSAL }),
      onError: () => {},
    });
    const parts: TextStreamPart<ToolSet>[] = [];
    for await (const part of result.fullStream) parts.push(part);
    const types = parts.map((part) => part.type);
    const finalDelta = parts.findIndex((part) => part.type === 'text-delta' && part.text === 'Final answer.');
    expect(finalDelta).toBeGreaterThan(-1);
    for (const type of ['tool-call', 'tool-result', 'finish-step']) {
      const at = types.indexOf(type as (typeof types)[number]);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(finalDelta);
    }
    expect(types.at(-1)).toBe('finish');
  });
});

describe('stream and whole-text agree', () => {
  const answers = [
    TOKEN,
    ` "${TOKEN}" more`,
    `Answer. ${TOKEN} more`,
    'Plain answer with 10% and %% marks.',
    '%%NO_ANSWER but not the token',
    `x${TOKEN}${TOKEN}y`,
    `  \`${TOKEN}\``,
  ];

  it('gives the same text and outcome for every split point', async () => {
    for (const answer of answers) {
      const expected = applySentinelToText([answer], REFUSAL);
      for (let cut = 0; cut <= answer.length; cut += 1) {
        const pieces = [answer.slice(0, cut), answer.slice(cut)].filter((piece) => piece.length > 0);
        const out = await run(pieces);
        expect({ answer, cut, text: out.text, refused: out.onRefusal.mock.calls.length > 0, stripped: out.stripped }).toEqual({
          answer,
          cut,
          text: expected.text,
          refused: expected.refused,
          stripped: expected.strippedCount,
        });
      }
    }
  });

  it('agrees for a two-step turn', async () => {
    const expected = applySentinelToText(['Line one.', TOKEN], REFUSAL);
    const out = await run([TOKEN.slice(0, 9), TOKEN.slice(9)], {
      options: { before: [{ pieces: ['Line ', 'one.'], toolCall: { toolName: 'webSearch', input: { query: 'q' } } }] },
    });
    expect(out.text).toBe(expected.text);
    expect(expected.refused).toBe(true);
  });
});
