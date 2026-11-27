import type { LanguageModel } from 'ai';
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { countContextTokens } from '../../src/lib/rag/context/budget.ts';
import { contextBlocks, firstSentence, splitForStreaming } from './fake-citation-generator.mts';

/**
 * Harness-only recording small-window model for the Phase 5.2.1 budget gates (D-88, RESEARCH Pattern F). It counts every
 * request with its own estimator (cl100k times FAKE_SMALL_WINDOW_FACTOR, deliberately not the planner's default factor), fails
 * a request whose prompt plus requested output exceeds its window, fails a request whose last user message is not the item's
 * question, and reports its own count as the provider's input tokens. Records ids and numbers only, never text. Never
 * imported by src/.
 */
export const FAKE_SMALL_WINDOW_MODEL = 'fixture/small-window-4k';
export const FAKE_SMALL_WINDOW_TOKENS = 4096;
export const FAKE_SMALL_WINDOW_FACTOR = 1.3;
/** The model's own output limit, declared to the eval route through the factory seam. */
export const FAKE_SMALL_WINDOW_OUTPUT_LIMIT = 512;
export const FAKE_WINDOW_EXCEEDED = 'fake_window_exceeded';
export const FAKE_QUESTION_NOT_LAST = 'question_not_last';

/** The fake windows the harness registers in the model-window override map (setModelContextLengthOverrides). */
export const FAKE_MODEL_CONTEXT_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  [FAKE_SMALL_WINDOW_MODEL]: FAKE_SMALL_WINDOW_TOKENS,
});

export type SmallWindowOutcome = 'ok' | typeof FAKE_WINDOW_EXCEEDED | typeof FAKE_QUESTION_NOT_LAST;

export interface SmallWindowRequest {
  /** The fake's estimate of the prompt (system, messages and tool schemas). */
  promptTokens: number;
  maxOutputTokens: number;
  messages: number;
  outcome: SmallWindowOutcome;
}

export class FakeSmallWindowError extends Error {
  constructor(readonly code: typeof FAKE_WINDOW_EXCEEDED | typeof FAKE_QUESTION_NOT_LAST) {
    super(code);
    this.name = 'FakeSmallWindowError';
  }
}

export function isFakeSmallWindowModel(modelId: string): boolean {
  return modelId === FAKE_SMALL_WINDOW_MODEL;
}

const recorded: SmallWindowRequest[] = [];

/** Every request the fake received since the last reset, in order. */
export function smallWindowRequests(): readonly SmallWindowRequest[] {
  return recorded;
}

export function resetSmallWindowRequests(): void {
  recorded.length = 0;
}

function partText(part: { type: string; text?: string }): string {
  return (part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string' ? part.text : JSON.stringify(part);
}

function messageText(message: LanguageModelV3Prompt[number]): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content as ReadonlyArray<{ type: string; text?: string }>).map(partText).join('\n');
}

function userText(message: LanguageModelV3Prompt[number]): string {
  if (message.role !== 'user') return '';
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

/** The fake's own count: cl100k over each message and the tool schemas, times its factor. */
export function smallWindowPromptTokens(options: Pick<LanguageModelV3CallOptions, 'prompt' | 'tools'>): number {
  const texts = options.prompt.map(messageText);
  if (options.tools && options.tools.length > 0) texts.push(JSON.stringify(options.tools));
  const raw = texts.reduce((total, text) => total + (text ? countContextTokens(text) : 0), 0);
  return Math.ceil(raw * FAKE_SMALL_WINDOW_FACTOR);
}

/** The last user message, followed only by this turn's tool steps, holds the question. */
function questionIsLast(prompt: LanguageModelV3Prompt, isQuestion: (text: string) => boolean): boolean {
  let last = -1;
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index].role === 'user') {
      last = index;
      break;
    }
  }
  if (last < 0 || !isQuestion(userText(prompt[last]))) return false;
  return prompt.slice(last + 1).every((message) => message.role === 'tool' || message.role === 'assistant');
}

export interface SmallWindowModelOptions {
  /** True for the text of an item's question. */
  isQuestion: (text: string) => boolean;
  /** The answer when the context carries no labelled block. */
  fallback: (options: LanguageModelV3CallOptions) => string;
}

function respond(callOptions: LanguageModelV3CallOptions, options: SmallWindowModelOptions) {
  const promptTokens = smallWindowPromptTokens(callOptions);
  const maxOutputTokens = callOptions.maxOutputTokens ?? 0;
  const entry: SmallWindowRequest = { promptTokens, maxOutputTokens, messages: callOptions.prompt.length, outcome: 'ok' };
  recorded.push(entry);
  void questionIsLast;
  void options;
  const system = callOptions.prompt
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n\n');
  const first = contextBlocks(system)[0];
  const text = first ? `${firstSentence(first.text) || 'See the source.'} [${first.alias}]` : options.fallback(callOptions);
  const outputTokens = text.split(/\s+/).filter(Boolean).length;
  const usage = {
    inputTokens: { total: promptTokens, noCache: promptTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  };
  return { text, usage };
}

export function createSmallWindowModel(options: SmallWindowModelOptions): LanguageModel {
  return new MockLanguageModelV3({
    provider: 'fixture',
    modelId: FAKE_SMALL_WINDOW_MODEL,
    doGenerate: async (callOptions) => {
      const { text, usage } = respond(callOptions, options);
      return { content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    },
    doStream: async (callOptions) => {
      const { text, usage } = respond(callOptions, options);
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'fake-text' },
        ...splitForStreaming(text).map((delta) => ({ type: 'text-delta' as const, id: 'fake-text', delta })),
        { type: 'text-end', id: 'fake-text' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  }) as unknown as LanguageModel;
}

/** The fake's output limit for the eval route's factory seam; undefined for every other id. */
export function fakeSmallWindowOutputLimit(modelId: string): number | undefined {
  return isFakeSmallWindowModel(modelId) ? FAKE_SMALL_WINDOW_OUTPUT_LIMIT : undefined;
}
