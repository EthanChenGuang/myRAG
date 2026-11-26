import crypto from 'node:crypto';
import type { LanguageModel } from 'ai';
import type { LanguageModelV3CallOptions, LanguageModelV3FinishReason, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { ClaimJudgement, GoldenItem } from '../../src/lib/rag-eval/contracts.generated.ts';
import { NO_ANSWER_SENTINEL } from '../../src/lib/rag/generation/sentinel.ts';
import { fixedText } from '../../src/lib/rag/lang/texts.ts';
import { stripCitationMarkers } from '../../src/lib/citations/marker-grammar.ts';
import {
  DEFAULT_FAKE_CITATION_SEED,
  contextBlocks,
  fakeCitationAnswer,
  firstSentence,
  installFakeCitationGenerator,
  promptParts,
  splitForStreaming,
  type ContextBlock,
  type FakeLanguageModelFactory,
} from './fake-citation-generator.mts';
import { hanChars, latinTokens } from './fake-groundedness.mts';

/**
 * Harness-only scripted answer models for the Phase 5.2 gates (D-54, D-42, D-34, D-27). Each fake reads only the prompt it
 * receives plus the golden item the harness hands it by question, is deterministic, and is selected by model id through
 * installFakeAnswerModels, which serves every other id with the fake citation generator. The rule-following fake keys on
 * the ASCII `[rule:<id>]` lines composeAnswerRules writes, never on registry wording. Never imported by src/.
 */
export const FAKE_RULE_FOLLOWING_MODEL = 'fake/rule-following-v1';
export const FAKE_VIOLATING_PARTIAL_MODEL = 'fake/violating-partial-v1';
export const FAKE_VIOLATING_VERSIONS_MODEL = 'fake/violating-versions-v1';
export const FAKE_VIOLATING_OFFTOPIC_MODEL = 'fake/violating-offtopic-v1';
export const FAKE_REPEATING_INJECTION_MODEL = 'fake/repeating-injection-v1';
export const FAKE_CAP_AWARE_MODEL = 'fake/cap-aware-v1';
export const FAKE_JUDGE_MODEL = 'fake/judge-v1';

export const FAKE_ANSWER_MODEL_IDS = [
  FAKE_RULE_FOLLOWING_MODEL,
  FAKE_VIOLATING_PARTIAL_MODEL,
  FAKE_VIOLATING_VERSIONS_MODEL,
  FAKE_VIOLATING_OFFTOPIC_MODEL,
  FAKE_REPEATING_INJECTION_MODEL,
  FAKE_CAP_AWARE_MODEL,
  FAKE_JUDGE_MODEL,
] as const;

export type FakeAnswerModelId = (typeof FAKE_ANSWER_MODEL_IDS)[number];

type RuleCategory = 'partial_answer' | 'stale_version' | 'off_topic_context';

/** The rule category each violating fake always breaks; it follows the rules of the other categories. */
const VIOLATES: Readonly<Partial<Record<FakeAnswerModelId, RuleCategory>>> = {
  [FAKE_VIOLATING_PARTIAL_MODEL]: 'partial_answer',
  [FAKE_VIOLATING_VERSIONS_MODEL]: 'stale_version',
  [FAKE_VIOLATING_OFFTOPIC_MODEL]: 'off_topic_context',
};

const RULE_LINE_RE = /^\[rule:([a-z][a-z0-9_]*)\]$/gm;
const URL_RE = /https?:\/\/[^\s)\]>"']+/g;
const HAS_URL_RE = /https?:\/\/\S/;
const MARKER_RE = /\[S[1-9][0-9]*\]/g;
const EVIDENCE_REF_RE = /^S[1-9][0-9]*$/;
const REPEAT_PIECE_CHARS = 8;
const NO_CONTEXT_ANSWER = 'The provided documents do not contain this information.';

interface Turn {
  system: string;
  question: string;
  rules: ReadonlySet<string>;
  /** Strict-mode rule texts carry the no-answer sentinel; the balanced and flexible ones never do. */
  strict: boolean;
  blocks: ContextBlock[];
  item: GoldenItem | undefined;
  seed: string;
}

function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function digest(seed: string, text: string): Buffer {
  return crypto.createHash('sha256').update(`${seed}\u0000${text}`, 'utf8').digest();
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?。！？]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function blockWith(blocks: readonly ContextBlock[], needle: string): ContextBlock | undefined {
  const wanted = fold(needle);
  return wanted === '' ? undefined : blocks.find((block) => fold(block.text).includes(wanted));
}

function cited(text: string, block: ContextBlock | undefined): string {
  return block ? `${sentence(text)} [${block.alias}]` : sentence(text);
}

function itemLanguage(turn: Turn): string {
  return turn.item?.language ?? 'en';
}

function generalKnowledgeLine(turn: Turn): string {
  return `**${fixedText('labels.general_knowledge', itemLanguage(turn))}**`;
}

/** A plausible value invented for a gap; deterministic per question and aspect. */
function inventedValue(turn: Turn, aspect: string): string {
  return String(10 + (digest(turn.seed, `${turn.question}\u0000${aspect}`)[0] % 90));
}

function partialAnswer(turn: Turn, follow: boolean): string {
  const spec = turn.item!.partial!;
  const covered = spec.covered.flatMap((span) => {
    const block = blockWith(turn.blocks, span.quote);
    return block ? [cited(span.quote, block)] : [];
  });
  if (follow) {
    if (turn.rules.has('partial_answer')) {
      if (covered.length === 0 && turn.strict) return NO_ANSWER_SENTINEL;
      const notCovered = fixedText('labels.not_covered', itemLanguage(turn));
      return [...covered, ...spec.uncovered_aspects.map((aspect) => `${aspect}: ${notCovered}.`)].join(' ');
    }
    if (turn.rules.has('general_knowledge')) {
      const invented = spec.uncovered_aspects.map((aspect) => `${aspect}: ${inventedValue(turn, aspect)}.`);
      return [covered.join(' '), [generalKnowledgeLine(turn), invented.join(' ')].join('\n')].filter(Boolean).join('\n\n');
    }
  }
  return [...covered, ...spec.uncovered_aspects.map((aspect) => `${aspect}: ${inventedValue(turn, aspect)}.`)].join(' ');
}

function versionsAnswer(turn: Turn, follow: boolean): string {
  const spec = turn.item!.versions!;
  if (follow && turn.rules.has('version')) {
    const target = spec.historical ? spec.stale : spec.current;
    const block = blockWith(turn.blocks, target.value);
    if (!block) return turn.strict ? NO_ANSWER_SENTINEL : fixedText('labels.not_covered', itemLanguage(turn));
    const label = fixedText('labels.version', itemLanguage(turn), { version: target.version_label });
    return cited(`${target.value} (${label})`, block);
  }
  const current = blockWith(turn.blocks, spec.current.value);
  const stale = blockWith(turn.blocks, spec.stale.value);
  return `${cited(spec.current.value, current)} ${cited(`Or ${spec.stale.value}`, stale)}`;
}

function offTopicAnswer(turn: Turn, follow: boolean): string {
  if (follow && turn.rules.has('relevance')) {
    if (turn.strict) return NO_ANSWER_SENTINEL;
    const hex = digest(turn.seed, turn.question).subarray(0, 3).toString('hex');
    return `${generalKnowledgeLine(turn)}\nGeneral answer ${hex}.`;
  }
  const spec = turn.item!.off_topic!;
  for (const span of spec.adjacent_quotes) {
    const block = blockWith(turn.blocks, span.quote);
    if (block) return cited(span.quote, block);
  }
  const first = turn.blocks[0];
  return first ? cited(firstSentence(first.text) || 'See the source', first) : NO_CONTEXT_ANSWER;
}

function ruleAnswer(turn: Turn, modelId: FakeAnswerModelId): string {
  const item = turn.item;
  const violated = VIOLATES[modelId];
  if (item?.category === 'partial_answer' && item.partial) return partialAnswer(turn, violated !== 'partial_answer');
  if (item?.category === 'stale_version' && item.versions) return versionsAnswer(turn, violated !== 'stale_version');
  if (item?.category === 'off_topic_context' && item.off_topic) return offTopicAnswer(turn, violated !== 'off_topic_context');
  return fakeCitationAnswer({ system: turn.system, question: turn.question, seed: turn.seed });
}

function blockBody(text: string): string {
  return text
    .trim()
    .replace(/^Document: [^\n]*?Content:[ \t]*/, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('<') && !line.startsWith('==='))
    .join(' ')
    .trim();
}

/** Repeats, with its citation, every context block that holds a link: the planted link and the request around it. */
function repeatingAnswer(turn: Turn): string {
  const withLinks = turn.blocks.filter((block) => HAS_URL_RE.test(block.text));
  if (withLinks.length === 0) return fakeCitationAnswer({ system: turn.system, question: turn.question, seed: turn.seed });
  return withLinks.map((block) => `${sentence(blockBody(block.text))} [${block.alias}]`).join(' ');
}

/** Small pieces with a cut inside every link and every marker, so no delta holds a whole link. */
function splitRepeating(text: string): string[] {
  const cuts = new Set<number>();
  for (let position = REPEAT_PIECE_CHARS; position < text.length; position += REPEAT_PIECE_CHARS) cuts.add(position);
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    cuts.add(start + 5);
    cuts.add(start + Math.floor(match[0].length / 2));
  }
  for (const match of text.matchAll(MARKER_RE)) cuts.add((match.index ?? 0) + 2);
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

/** Every block's first sentence with its citation; a token is a whitespace-separated word in this fake. */
function capAwareAnswer(turn: Turn, maxOutputTokens: number | undefined): { text: string; finish: 'stop' | 'length'; tokens: number } {
  const full =
    turn.blocks.length === 0
      ? NO_CONTEXT_ANSWER
      : turn.blocks.map((block) => `${firstSentence(block.text) || 'See the source.'} [${block.alias}]`).join(' ');
  const words = full.split(/\s+/).filter(Boolean);
  if (maxOutputTokens !== undefined && maxOutputTokens > 0 && words.length > maxOutputTokens) {
    return { text: words.slice(0, maxOutputTokens).join(' '), finish: 'length', tokens: maxOutputTokens };
  }
  return { text: words.join(' '), finish: 'stop', tokens: words.length };
}

export interface FakeJudgePremise {
  ref: string;
  text: string;
}

export interface FakeJudgeClaim {
  index: number;
  hypothesis: string;
  premise_refs: readonly string[];
}

function units(text: string): string[] {
  return [...latinTokens(text), ...hanChars(text)];
}

/** The values a sentence states: its tokens with a digit, else its content words (four letters or more, or Han characters). */
function sentenceValues(hypothesis: string): string[] {
  const tokens = units(stripCitationMarkers(hypothesis));
  const numeric = tokens.filter((token) => /\p{N}/u.test(token));
  if (numeric.length > 0) return [...new Set(numeric)];
  return [...new Set(tokens.filter((token) => token.length >= 4 || /\p{Script=Han}/u.test(token)))];
}

/**
 * Deterministic judgement by premise overlap (D-27): a sentence is supported when every value it states occurs in one of
 * its referenced premises, unsupported otherwise, and not_enough_info when none of its references names a premise.
 */
export function fakeJudgeClaims(input: { premises: readonly FakeJudgePremise[]; claims: readonly FakeJudgeClaim[] }): ClaimJudgement {
  const premises = new Map(input.premises.map((premise) => [premise.ref, new Set(units(premise.text))]));
  return {
    judgements: input.claims.map((claim) => {
      const refs = claim.premise_refs.filter((ref) => premises.has(ref));
      if (refs.length === 0) return { index: claim.index, verdict: 'not_enough_info' as const, evidence_ref: null };
      const values = sentenceValues(claim.hypothesis);
      const evidence = values.length === 0 ? undefined : refs.find((ref) => values.every((value) => premises.get(ref)!.has(value)));
      if (evidence === undefined) return { index: claim.index, verdict: 'unsupported' as const, evidence_ref: null };
      return { index: claim.index, verdict: 'supported' as const, evidence_ref: EVIDENCE_REF_RE.test(evidence) ? evidence : null };
    }),
  };
}

function isJudgeRequest(value: unknown): value is { premises: FakeJudgePremise[]; claims: FakeJudgeClaim[] } {
  if (typeof value !== 'object' || value === null) return false;
  const { premises, claims } = value as { premises?: unknown; claims?: unknown };
  return (
    Array.isArray(premises) &&
    Array.isArray(claims) &&
    premises.every((p) => typeof p?.ref === 'string' && typeof p?.text === 'string') &&
    claims.every((c) => Number.isInteger(c?.index) && typeof c?.hypothesis === 'string' && Array.isArray(c?.premise_refs))
  );
}

/** The judge request is the JSON object ({ premises, claims }) the prompt carries; anything else is judged as no claims. */
function judgeAnswer(options: LanguageModelV3CallOptions): string {
  const { system, question } = promptParts(options);
  for (const text of [question, system]) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (isJudgeRequest(parsed)) return JSON.stringify(fakeJudgeClaims(parsed));
    } catch {
      // not the request object
    }
  }
  return JSON.stringify({ judgements: [] });
}

function usage(output: number) {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function finishReason(unified: 'stop' | 'length'): LanguageModelV3FinishReason {
  return { unified, raw: unified };
}

interface Scripted {
  text: string;
  finish: 'stop' | 'length';
  tokens: number;
  pieces: (text: string) => string[];
}

export interface FakeAnswerModelsOptions {
  /** The golden items of the run; a fake finds an item's structure by its question. */
  items: readonly GoldenItem[];
  seed?: string;
}

/** Returns the factory the harness installs with setEvalLanguageModelFactory; non-Phase-5.2 ids get the fake citation generator. */
export function installFakeAnswerModels(options: FakeAnswerModelsOptions): FakeLanguageModelFactory {
  const seed = options.seed ?? DEFAULT_FAKE_CITATION_SEED;
  const byQuestion = new Map<string, GoldenItem>();
  for (const item of options.items) {
    const key = item.question.trim();
    if (!byQuestion.has(key)) byQuestion.set(key, item);
  }
  const citation = installFakeCitationGenerator(seed);
  const known = new Set<string>(FAKE_ANSWER_MODEL_IDS);

  const script = (modelId: FakeAnswerModelId, callOptions: LanguageModelV3CallOptions): Scripted => {
    if (modelId === FAKE_JUDGE_MODEL) {
      const text = judgeAnswer(callOptions);
      return { text, finish: 'stop', tokens: 0, pieces: (value) => [value] };
    }
    const { system, question } = promptParts(callOptions);
    const turn: Turn = {
      system,
      question,
      rules: new Set([...system.matchAll(RULE_LINE_RE)].map((match) => match[1])),
      strict: system.includes(NO_ANSWER_SENTINEL),
      blocks: contextBlocks(system),
      item: byQuestion.get(question),
      seed,
    };
    if (modelId === FAKE_CAP_AWARE_MODEL) {
      return { ...capAwareAnswer(turn, callOptions.maxOutputTokens), pieces: splitForStreaming };
    }
    if (modelId === FAKE_REPEATING_INJECTION_MODEL) {
      const text = repeatingAnswer(turn);
      return { text, finish: 'stop', tokens: text.split(/\s+/).filter(Boolean).length, pieces: splitRepeating };
    }
    const text = ruleAnswer(turn, modelId);
    return { text, finish: 'stop', tokens: text.split(/\s+/).filter(Boolean).length, pieces: splitForStreaming };
  };

  return (modelId) => {
    if (!known.has(modelId)) return citation(modelId);
    const id = modelId as FakeAnswerModelId;
    return new MockLanguageModelV3({
      provider: 'fake',
      modelId: id,
      doGenerate: async (callOptions) => {
        const scripted = script(id, callOptions);
        return {
          content: [{ type: 'text' as const, text: scripted.text }],
          finishReason: finishReason(scripted.finish),
          usage: usage(scripted.tokens),
          warnings: [],
        };
      },
      doStream: async (callOptions) => {
        const scripted = script(id, callOptions);
        const parts: LanguageModelV3StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'fake-text' },
          ...scripted.pieces(scripted.text).map((delta) => ({ type: 'text-delta' as const, id: 'fake-text', delta })),
          { type: 'text-end', id: 'fake-text' },
          { type: 'finish', finishReason: finishReason(scripted.finish), usage: usage(scripted.tokens) },
        ];
        return { stream: convertArrayToReadableStream(parts) };
      },
    }) as unknown as LanguageModel;
  };
}
