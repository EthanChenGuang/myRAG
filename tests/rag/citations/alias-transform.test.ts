import { describe, expect, it, vi } from 'vitest';
import { streamText, type UIMessageChunk } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createCitationSession, type CitationFinishMetadata, type ContextBlock } from '@/lib/rag';

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function blocks(count: number): ContextBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    documentId: `doc-${index + 1}`,
    documentName: `doc-${index + 1}.pdf`,
    documentVersion: 1,
    chunkIds: [`chunk-${index + 1}`],
    page: null,
    sectionPath: null,
    title: `doc-${index + 1}.pdf`,
    text: `Block ${index + 1} text.`,
    isImage: false,
    alias: `S${index + 1}`,
  }));
}

function session(count = 12) {
  const created = createCitationSession({
    capabilities: { citations: true },
    ragMode: 'strict',
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    language: 'en',
    config: { citations: true },
  });
  created.attach({ blocks: blocks(count) });
  return created;
}

function textParts(id: string, deltas: string[]) {
  return [
    { type: 'text-start' as const, id },
    ...deltas.map((delta) => ({ type: 'text-delta' as const, id, delta })),
    { type: 'text-end' as const, id },
  ];
}

async function run(parts: LanguageModelV3StreamPart[], citationSession = session()) {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
        { type: 'stream-start', warnings: [] },
        ...parts,
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
      ]),
    }),
  });
  const result = streamText({
    model,
    prompt: 'question',
    experimental_transform: citationSession.transforms(),
    onError: () => {},
  });
  let finishSeen: CitationFinishMetadata | undefined;
  const chunks: UIMessageChunk[] = [];
  const reader = result
    .toUIMessageStream({
      onError: () => 'stream error',
      messageMetadata: ({ part }) => {
        if (part.type !== 'finish') return undefined;
        finishSeen = citationSession.finishMetadata();
        return finishSeen;
      },
    })
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const text = chunks
    .filter((chunk): chunk is Extract<UIMessageChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map((chunk) => chunk.delta)
    .join('');
  return { chunks, text, finishSeen, session: citationSession };
}

describe('aliasParserTransform on the real streamText', () => {
  const ANSWER = 'x [S12, S3] y【S2】z';

  it('finds the same validated aliases for every two-way split and leaves the text unchanged', async () => {
    for (let cut = 0; cut <= ANSWER.length; cut++) {
      const deltas = [ANSWER.slice(0, cut), ANSWER.slice(cut)].filter((delta) => delta.length > 0);
      const { text, finishSeen } = await run(textParts('t1', deltas));
      expect(text, `split at ${cut}`).toBe(ANSWER);
      expect(finishSeen?.citations?.map((citation) => citation.alias), `split at ${cut}`).toEqual(['S12', 'S3', 'S2']);
      expect(finishSeen?.citations?.map((citation) => citation.n)).toEqual([1, 2, 3]);
      expect(finishSeen?.invalidCitations).toBe(0);
    }
  });

  it('does not join a marker across two text blocks', async () => {
    const { text, finishSeen } = await run([...textParts('a', ['see [S1']), ...textParts('b', ['] done'])]);
    expect(text).toBe('see [S1] done');
    expect(finishSeen?.citations).toEqual([]);
  });

  it('gives messageMetadata for the finish part the final citations', async () => {
    const { chunks, finishSeen } = await run(textParts('t1', ['A [S', '1] and [S', '99].']));
    const finish = chunks.find((chunk) => chunk.type === 'finish') as { messageMetadata?: CitationFinishMetadata } | undefined;
    expect(finish?.messageMetadata).toEqual(finishSeen);
    expect(finish?.messageMetadata?.citations?.map((citation) => citation.alias)).toEqual(['S1']);
    expect(finish?.messageMetadata?.invalidCitations).toBe(1);
    expect(finish?.messageMetadata?.citationStrategy).toBe('chunk-alias');
  });

  it('forwards a model error part unchanged and reports no citations', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new Error('model failed');
    const { chunks, session: citationSession } = await run([
      ...textParts('t1', ['partial [S1] ']),
      { type: 'error', error },
    ]);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(true);
    expect(citationSession.finishMetadata().citations).toEqual([]);
    expect(citationSession.answerText()).toBe('partial [S1] ');
  });

  it('accumulates the answer text across text blocks', async () => {
    const { session: citationSession } = await run([...textParts('a', ['one ', '[S2]']), ...textParts('b', [' two'])]);
    expect(citationSession.answerText()).toBe('one [S2] two');
    expect(citationSession.finishMetadata().citations?.map((citation) => citation.alias)).toEqual(['S2']);
  });
});
