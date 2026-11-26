import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { StreamTextResult, TextStreamPart, ToolSet, UIMessageChunk } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

export type MockFinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';

export interface MockToolCall {
  toolName: string;
  input: unknown;
  toolCallId?: string;
}

/** One model step before the final one; a step with a tool call ends with finish reason tool-calls by default. */
export interface MockStep {
  pieces: string[];
  toolCall?: MockToolCall;
  finishReason?: MockFinishReason;
}

export interface StreamModelOptions {
  /** Steps emitted before the step made of `pieces` (each model call serves the next step). */
  before?: MockStep[];
}

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function stepParts(step: MockStep, index: number): LanguageModelV3StreamPart[] {
  const id = `text-${index}`;
  const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
  if (step.pieces.length > 0) {
    parts.push({ type: 'text-start', id });
    for (const delta of step.pieces) parts.push({ type: 'text-delta', id, delta });
    parts.push({ type: 'text-end', id });
  }
  if (step.toolCall) {
    parts.push({
      type: 'tool-call',
      toolCallId: step.toolCall.toolCallId ?? `call-${index}`,
      toolName: step.toolCall.toolName,
      input: JSON.stringify(step.toolCall.input),
    });
  }
  const reason = step.finishReason ?? (step.toolCall ? 'tool-calls' : 'stop');
  parts.push({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage: USAGE });
  return parts;
}

/** A mock model whose doStream emits the given text pieces (and earlier tool steps) for the real streamText. */
export function streamModelFromPieces(
  pieces: string[],
  finishReason: MockFinishReason = 'stop',
  options: StreamModelOptions = {},
): MockLanguageModelV3 {
  const steps: MockStep[] = [...(options.before ?? []), { pieces, finishReason }];
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const index = Math.min(call, steps.length - 1);
      call += 1;
      return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>(stepParts(steps[index]!, index)) };
    },
  });
}

export interface CollectedStream {
  chunks: UIMessageChunk[];
  /** Concatenated UI text deltas across every step. */
  text: string;
  /** Text of each step as the SDK reports it in `steps`. */
  stepTexts: string[];
}

/** Reads the UI message stream to its end and returns its parts and text. */
export async function collectStream<TOOLS extends ToolSet>(
  result: StreamTextResult<TOOLS, never>,
  options: { messageMetadata?: (input: { part: TextStreamPart<TOOLS> }) => unknown } = {},
): Promise<CollectedStream> {
  const chunks: UIMessageChunk[] = [];
  const reader = result
    .toUIMessageStream({ onError: () => 'stream error', messageMetadata: options.messageMetadata })
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
  const steps = await result.steps;
  return { chunks, text, stepTexts: steps.map((step) => step.text) };
}
