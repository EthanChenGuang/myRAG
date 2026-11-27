import { jsonSchema, stepCountIs, streamText, tool, type UIMessageChunk } from 'ai';
import { createCitationSession, type ContextBlock } from '@/lib/rag';
import { createAnswerCollector } from '@/lib/rag/generation/answer-collector';
import { buildAnswerTransforms } from '@/lib/rag/generation/answer-transforms';
import type { AnswerChannel } from '@/lib/rag/generation/answer-turn';
import { sentinelTransform } from '@/lib/rag/generation/sentinel';
import { fixedText } from '@/lib/rag/lang/texts';
import { streamModelFromPieces, type MockFinishReason, type StreamModelOptions } from './stream-model';

export function contextBlock(alias: string, text: string): ContextBlock {
  return {
    documentId: `doc-${alias}`,
    documentName: 'synthetic.pdf',
    documentVersion: 1,
    chunkIds: [`chunk-${alias}`],
    page: null,
    sectionPath: null,
    title: 'synthetic.pdf',
    text,
    isImage: false,
    alias,
  };
}

const lookup = tool({
  description: 'Look something up',
  inputSchema: jsonSchema<{ query: string }>({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
  execute: async () => ({ results: [] }),
});

export interface ChainRunInput {
  pieces: string[];
  finishReason?: MockFinishReason;
  options?: StreamModelOptions;
  channel?: AnswerChannel;
  sentinel?: boolean;
  anyNonDefault?: boolean;
  perSentence?: boolean;
  claimCheck?: boolean;
  /** Attaches a chunk-alias citation session with blocks S1 and S2. */
  citations?: boolean;
}

/** Runs citation session transforms plus the answer chain on the real streamText and reads the UI stream to its end. */
export async function runAnswerChain(input: ChainRunInput) {
  const session = createCitationSession({
    capabilities: { citations: input.citations ?? false },
    ragMode: 'strict',
    modelId: 'synthetic/model',
    language: 'en',
    config: { citations: input.citations ?? false },
    perSentence: input.perSentence ?? false,
  });
  session.attach({ blocks: [contextBlock('S1', 'Alpha is one.'), contextBlock('S2', 'Beta is two.')] });
  const collector = createAnswerCollector({
    turn: {
      config: {
        anyNonDefault: input.anyNonDefault ?? true,
        citationPerSentence: input.perSentence ?? false,
        claimCheck: input.claimCheck ?? false,
      },
      answerLanguage: 'en',
    },
    channel: input.channel ?? 'web',
    aliases: () => session.aliases(),
  });
  const chain = buildAnswerTransforms({
    citationTransforms: session.transforms(),
    sentinel: input.sentinel
      ? sentinelTransform({
          refusalText: fixedText('notices.no_information', 'en'),
          onRefusal: () => collector.markRefused(),
          onStripped: (count) => collector.countStripped(count),
        })
      : null,
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
  let finishMetadata: Record<string, unknown> | undefined;
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
    if (value.type === 'finish') finishMetadata = value.messageMetadata as Record<string, unknown> | undefined;
  }
  const text = chunks
    .filter((chunk): chunk is Extract<UIMessageChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map((chunk) => chunk.delta)
    .join('');
  return { session, collector, text, responseText: responseText as string | null, finishMetadata };
}
