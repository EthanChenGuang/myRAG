import crypto from 'node:crypto';
import type { LanguageModel } from 'ai';
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCitationMarkers } from '../../src/lib/citations/marker-grammar.ts';
import { hasRefusalDirective } from './prompt-directives.mts';

/**
 * Harness-only deterministic generator for the chunk-alias path (D-24). It reads the "[S<k>] <title>" labels from the
 * system prompt, cites one or two of them with the first sentence of each cited block, adds an unknown alias for about
 * one question in five, and streams the answer with every marker split across chunks. Never imported by src/.
 *
 * Instruction-sensitive mode (Phase 5.3 D-13), only for the questions in `noAnswerQuestions` that reach the generator with
 * context: the refusal text of the question's language when the prompt template carries a refusal directive, else a fixed
 * unsupported answer. Every other question is answered exactly as without the option.
 */
export const FAKE_CITATION_GENERATOR_MODEL = 'fake/citation-alias-v1';
export const FAKE_INVALID_ALIAS = 'S99';
export const DEFAULT_FAKE_CITATION_SEED = 'p5-22';

export type FakeLanguageModelFactory = (_modelId: string) => LanguageModel;

const HEADER_RE = /^\[S([1-9][0-9]*)\][^\n]*\n/gm;
const FIRST_SENTENCE_RE = /^[\s\S]*?[.!?。！？](?=\s|$)/;
const MAX_SENTENCE_CHARS = 300;
const STREAM_PIECE_CHARS = 12;
const NO_CONTEXT_ANSWER = 'The provided documents do not contain this information.';
const REFUSAL_TEXTS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/refusal-texts.json');

/** One neutral answer per language that cites no block and that no refusal text matches. */
export const FAKE_UNSUPPORTED_ANSWERS: Readonly<Record<string, string>> = {
  en: 'Based on general knowledge, the answer is yes.',
  it: 'In base alle conoscenze generali, la risposta è sì.',
  zh: '根据一般常识，答案是肯定的。',
};

export interface FakeCitationGeneratorOptions {
  /** Question text to the item's language code, for the golden items with answerable false. */
  noAnswerQuestions?: ReadonlyMap<string, string>;
  /** The assembled template of resolveEvalPromptTemplate; the directive is read from it, not from the wrapped system prompt. */
  promptTemplate?: string;
}

let refusalTexts: Record<string, string[]> | null = null;

/** The refusal texts the Python scorer recognises (eval/fixtures/refusal-texts.json, read once). */
function loadRefusalTexts(): Record<string, string[]> {
  refusalTexts ??= JSON.parse(fs.readFileSync(REFUSAL_TEXTS_PATH, 'utf8')) as Record<string, string[]>;
  return refusalTexts;
}

function refusalTextFor(language: string): string {
  const text = loadRefusalTexts()[language]?.[0];
  if (!text) throw new Error(`[Fake Generator] no refusal text for language ${language}`);
  return text;
}

function hasContext(system: string, blockCount: number, template: string | undefined): boolean {
  if (blockCount > 0) return true;
  if (template === undefined) return false;
  // An empty retrieval injects nothing into the template; anything else in the system prompt is context.
  return system.trim() !== '' && system.trim() !== template.replace('{{context}}', '').trim();
}

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

interface LabelledBlock {
  alias: string;
  sentence: string;
}

/** Ingested chunks start with "Document: <name>. Chunk <i> of <n>. Content: "; the answer quotes the content after it. */
const CHUNK_PREFIX_RE = /^Document: [^\n]*?Content:[ \t]*/;

function firstSentence(raw: string): string {
  const body = raw
    .trim()
    .replace(CHUNK_PREFIX_RE, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('===') && !line.startsWith('---'))
    .join(' ')
    .trim();
  if (body === '') return '';
  const match = FIRST_SENTENCE_RE.exec(body);
  let sentence = (match ? match[0] : body).trim().slice(0, MAX_SENTENCE_CHARS).trim();
  if (!/[.!?。！？]$/.test(sentence)) sentence = `${sentence}.`;
  return sentence;
}

/** The labelled blocks in prompt order; a label that appears twice keeps its first block. */
export function labelledBlocks(system: string): LabelledBlock[] {
  const headers = [...system.matchAll(HEADER_RE)];
  const blocks: LabelledBlock[] = [];
  const seen = new Set<string>();
  headers.forEach((header, index) => {
    const alias = `S${header[1]}`;
    if (seen.has(alias)) return;
    seen.add(alias);
    const start = (header.index ?? 0) + header[0].length;
    const end = index + 1 < headers.length ? (headers[index + 1].index ?? system.length) : system.length;
    blocks.push({ alias, sentence: firstSentence(system.slice(start, end)) });
  });
  return blocks;
}

function digest(seed: string, question: string): Buffer {
  return crypto.createHash('sha256').update(`${seed}\u0000${question}`, 'utf8').digest();
}

/** The answer for one question: a pure function of the system prompt, the question and the seed. */
export function fakeCitationAnswer(input: { system: string; question: string; seed?: string } & FakeCitationGeneratorOptions): string {
  const blocks = labelledBlocks(input.system);
  const noAnswerLanguage = input.noAnswerQuestions?.get(input.question);
  if (noAnswerLanguage !== undefined && hasContext(input.system, blocks.length, input.promptTemplate)) {
    if (hasRefusalDirective(input.promptTemplate ?? input.system)) return refusalTextFor(noAnswerLanguage);
    const unsupported = FAKE_UNSUPPORTED_ANSWERS[noAnswerLanguage];
    if (!unsupported) throw new Error(`[Fake Generator] no unsupported answer for language ${noAnswerLanguage}`);
    return unsupported;
  }
  if (blocks.length === 0) return NO_CONTEXT_ANSWER;
  const bytes = digest(input.seed ?? DEFAULT_FAKE_CITATION_SEED, input.question);
  const count = blocks.length;
  const first = bytes[0] % count;
  const cited = [blocks[first]];
  if (count > 1 && bytes[1] % 2 === 1) cited.push(blocks[(first + 1 + (bytes[2] % (count - 1))) % count]);
  const parts = cited.map((block) => `${block.sentence || 'See the source.'} [${block.alias}]`);
  if (bytes[3] % 5 === 0) {
    const known = new Set(blocks.map((block) => block.alias));
    const invalid = known.has(FAKE_INVALID_ALIAS) ? `S${count + 100}` : FAKE_INVALID_ALIAS;
    parts.push(`See also [${invalid}].`);
  }
  return parts.join(' ');
}

/** Cuts the text into small pieces with a cut inside every marker, so no piece holds a whole marker. */
export function splitForStreaming(text: string): string[] {
  const cuts = new Set<number>();
  for (let position = STREAM_PIECE_CHARS; position < text.length; position += STREAM_PIECE_CHARS) cuts.add(position);
  for (const marker of findCitationMarkers(text)) cuts.add(marker.start + 2);
  const ordered = [...cuts].filter((cut) => cut > 0 && cut < text.length).sort((a, b) => a - b);
  const pieces: string[] = [];
  let previous = 0;
  for (const cut of ordered) {
    pieces.push(text.slice(previous, cut));
    previous = cut;
  }
  pieces.push(text.slice(previous));
  return pieces.filter((piece) => piece.length > 0);
}

function promptParts(options: LanguageModelV3CallOptions): { system: string; question: string } {
  const system = options.prompt
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n\n');
  const users = options.prompt.filter((message) => message.role === 'user');
  const last = users[users.length - 1];
  const question = last
    ? last.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
        .trim()
    : '';
  return { system, question };
}

/** Returns the language-model factory the harness installs with setEvalLanguageModelFactory. */
export function installFakeCitationGenerator(
  seed: string = DEFAULT_FAKE_CITATION_SEED,
  options: FakeCitationGeneratorOptions = {},
): FakeLanguageModelFactory {
  for (const language of new Set(options.noAnswerQuestions?.values() ?? [])) {
    refusalTextFor(language);
    if (!FAKE_UNSUPPORTED_ANSWERS[language]) throw new Error(`[Fake Generator] no unsupported answer for language ${language}`);
  }
  const answer = (callOptions: LanguageModelV3CallOptions): string =>
    fakeCitationAnswer({ ...promptParts(callOptions), seed, ...options });
  return (modelId) =>
    new MockLanguageModelV3({
      provider: 'fake',
      modelId: modelId || FAKE_CITATION_GENERATOR_MODEL,
      doGenerate: async (options) => {
        const text = answer(options);
        return {
          content: [{ type: 'text' as const, text }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: USAGE,
          warnings: [],
        };
      },
      doStream: async (options) => {
        const text = answer(options);
        const parts: LanguageModelV3StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'fake-text' },
          ...splitForStreaming(text).map((delta) => ({ type: 'text-delta' as const, id: 'fake-text', delta })),
          { type: 'text-end', id: 'fake-text' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
        ];
        return { stream: convertArrayToReadableStream(parts) };
      },
    }) as unknown as LanguageModel;
}
