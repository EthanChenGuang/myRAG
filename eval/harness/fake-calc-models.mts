import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { CalcRequest, CalcResult } from '../../src/lib/rag-eval/contracts.generated.ts';
import { CALC_BLOCK_CLOSE, CALC_BLOCK_OPEN } from '../../src/lib/rag/calc/block-tag.ts';
import { evaluateCalc } from '../../src/lib/rag/calc/evaluate.ts';
import { formatNumber } from '../../src/lib/rag/calc/numbers.ts';
import { rational } from '../../src/lib/rag/calc/rational.ts';
import { numberFormatFor } from '../../src/lib/rag/lang/registry-fields.ts';
import { contextBlocks, promptParts, splitForStreaming, type ContextBlock } from './fake-citation-generator.mts';

/**
 * Harness-only scripted calculation models for the Phase 5.2.1 gates (D-78, RESEARCH Pattern C). Behaviour is data: each
 * fake finds its paraphrase group in eval/fixtures/calc-fake-scripts.json by the question text, maps the script's block
 * alias to the context block that holds the quoted rule, and reads only the prompt it receives. A fake calls the tool, or
 * writes the trailing block, only when the `[rule:calculation]` part is in its system prompt; without it the answer is plain
 * text that applies the rule to the total. Selected by model id through installFakeAnswerModels; never imported by src/.
 */
export const FAKE_CALC_FOLLOW_MODEL = 'fake/calc-follow-v1';
export const FAKE_CALC_FOLLOW_BLOCK_MODEL = 'fake/calc-follow-block-v1';
export const FAKE_CALC_SKIP_RULE_MODEL = 'fake/calc-skip-rule-v1';
export const FAKE_CALC_MISSING_OPERAND_MODEL = 'fake/calc-missing-operand-v1';

export const FAKE_CALC_MODEL_IDS = [
  FAKE_CALC_FOLLOW_MODEL,
  FAKE_CALC_FOLLOW_BLOCK_MODEL,
  FAKE_CALC_SKIP_RULE_MODEL,
  FAKE_CALC_MISSING_OPERAND_MODEL,
] as const;

export type FakeCalcModelId = (typeof FAKE_CALC_MODEL_IDS)[number];

/** The fake that declares no tool support, so the eval turn offers the trailing block instead (D-72). */
const NO_TOOL_MODELS: ReadonlySet<string> = new Set([FAKE_CALC_FOLLOW_BLOCK_MODEL]);

export const CALC_FAKE_SCRIPTS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/calc-fake-scripts.json');

const CALC_RULE_LINE = '[rule:calculation]';
const CALCULATE_TOOL = 'calculate';

export interface CalcScriptBlock {
  document: string;
  quote: string;
  section: string;
}

export interface CalcScriptGroup {
  paraphrase_group: string;
  language: string;
  rule_shape: string;
  items: string[];
  questions: string[];
  blocks: Record<string, CalcScriptBlock>;
  request: CalcRequest;
  expected_value: string;
  unit: string;
  skip_rule: { stated_value: string; how: string };
  missing_operand: { operand: string; cited_value: string };
}

export interface CalcFakeScripts {
  schema_version: number;
  groups: CalcScriptGroup[];
}

export function isFakeCalcModel(modelId: string): modelId is FakeCalcModelId {
  return (FAKE_CALC_MODEL_IDS as readonly string[]).includes(modelId);
}

/** The fake registry's tool capability: false for a fake that declares no tool support, undefined for any other id. */
export function fakeCalcToolCapability(modelId: string): boolean | undefined {
  return NO_TOOL_MODELS.has(modelId) ? false : undefined;
}

let cachedScripts: CalcFakeScripts | null = null;

export function loadCalcFakeScripts(file: string = CALC_FAKE_SCRIPTS_PATH): CalcFakeScripts {
  if (file === CALC_FAKE_SCRIPTS_PATH && cachedScripts) return cachedScripts;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CalcFakeScripts;
  if (!Array.isArray(parsed.groups)) throw new Error(`[Fake Calc] ${file} has no groups`);
  if (file === CALC_FAKE_SCRIPTS_PATH) cachedScripts = parsed;
  return parsed;
}

function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function sentenceEnd(language: string): string {
  return language === 'zh' ? '。' : '.';
}

/** The context alias of every script alias, by the block that holds its quoted rule; null when one is missing. */
function aliasMap(group: CalcScriptGroup, blocks: readonly ContextBlock[]): Map<string, string> | null {
  const map = new Map<string, string>();
  for (const [scriptAlias, spec] of Object.entries(group.blocks)) {
    const wanted = fold(spec.quote);
    const block = blocks.find((candidate) => fold(candidate.text).includes(wanted));
    if (!block) return null;
    map.set(scriptAlias, block.alias);
  }
  return map;
}

function mapAliases(request: CalcRequest, aliases: ReadonlyMap<string, string>): CalcRequest {
  return {
    ...request,
    operands: request.operands.map((operand) =>
      operand.source.kind === 'chunk' && operand.source.alias !== undefined
        ? { ...operand, source: { ...operand.source, alias: aliases.get(operand.source.alias) ?? operand.source.alias } }
        : operand,
    ),
  } as CalcRequest;
}

/** The missing-operand variant: the named operand carries a value its block does not hold. */
function withMissingOperand(request: CalcRequest, group: CalcScriptGroup): CalcRequest {
  const { operand: name, cited_value: value } = group.missing_operand;
  return {
    ...request,
    operands: request.operands.map((operand) => (operand.name === name ? { ...operand, value } : operand)),
  } as CalcRequest;
}

function formatted(exact: string, displayValue: string, language: string): string {
  const slash = exact.indexOf('/');
  const value = rational(BigInt(exact.slice(0, slash)), BigInt(exact.slice(slash + 1)));
  const point = displayValue.indexOf('.');
  const places = point < 0 ? 0 : displayValue.length - point - 1;
  return formatNumber(value, places, numberFormatFor(language));
}

function formattedDecimal(decimal: string, language: string): string {
  const negative = decimal.startsWith('-');
  const body = negative ? decimal.slice(1) : decimal;
  const point = body.indexOf('.');
  const digits = point < 0 ? body : body.slice(0, point) + body.slice(point + 1);
  const places = point < 0 ? 0 : body.length - point - 1;
  const value = rational(BigInt(`${negative ? '-' : ''}${digits}`), BigInt(10) ** BigInt(places));
  return formatNumber(value, places, numberFormatFor(language));
}

/** Every labelled step other than the result, with its value, then the stated total citing the rule's block. */
function answerText(input: {
  request: CalcRequest;
  result: CalcResult | null;
  stated: string;
  unit: string;
  citeAlias: string | null;
  language: string;
}): string {
  const end = sentenceEnd(input.language);
  const lines: string[] = [];
  if (input.result?.status === 'ok') {
    for (const declared of input.request.steps) {
      if (declared.id === input.request.result || declared.label === undefined) continue;
      const step = (input.result.steps ?? []).find((candidate) => candidate.id === declared.id);
      if (step) lines.push(`${declared.label}: ${formatted(step.exact, step.display, input.language)}${end}`);
    }
  }
  const resultStep = input.request.steps.find((step) => step.id === input.request.result);
  const label = resultStep?.label ?? input.request.result;
  const marker = input.citeAlias ? ` [${input.citeAlias}]` : '';
  lines.push(`${label}: ${formattedDecimal(input.stated, input.language)} ${input.unit}${end}${marker}`);
  return lines.join('\n');
}

interface ToolResultSeen {
  toolCallId: string;
  result: CalcResult | null;
}

function lastToolResult(options: LanguageModelV3CallOptions): ToolResultSeen | null {
  for (let index = options.prompt.length - 1; index >= 0; index -= 1) {
    const message = options.prompt[index];
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || part.toolName !== CALCULATE_TOOL) continue;
      const output = part.output as { type?: string; value?: unknown };
      const value = output?.type === 'json' && output.value && typeof output.value === 'object' ? (output.value as CalcResult) : null;
      return { toolCallId: part.toolCallId, result: value };
    }
  }
  return null;
}

function toolOffered(options: LanguageModelV3CallOptions): boolean {
  return (options.tools ?? []).some((candidate) => candidate.type === 'function' && candidate.name === CALCULATE_TOOL);
}

export type CalcFakeTurn =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; toolCallId: string; input: CalcRequest };

/** Only for questions of a scripted group; every other question is answered by the fallback the caller supplies. */
export function scriptCalcTurn(modelId: FakeCalcModelId, options: LanguageModelV3CallOptions, scripts: CalcFakeScripts): CalcFakeTurn | null {
  const { system, question } = promptParts(options);
  const key = question.trim();
  const group = scripts.groups.find((candidate) => candidate.questions.some((text) => text.trim() === key));
  if (!group) return null;
  const blocks = contextBlocks(system);
  const aliases = aliasMap(group, blocks);
  const citeAlias = aliases ? ([...aliases.values()][0] ?? null) : null;
  const language = group.language;
  const instructed = system.includes(CALC_RULE_LINE);
  const blockMode = instructed && system.includes(CALC_BLOCK_OPEN);

  if (!instructed || aliases === null) {
    return { kind: 'text', text: answerText({ request: group.request, result: null, stated: group.skip_rule.stated_value, unit: group.unit, citeAlias, language }) };
  }

  let request = mapAliases(group.request, aliases);
  if (modelId === FAKE_CALC_MISSING_OPERAND_MODEL) request = withMissingOperand(request, group);
  const aliasSet = new Set(aliases.values());

  if (!blockMode && toolOffered(options)) {
    const seen = lastToolResult(options);
    if (seen === null) return { kind: 'tool-call', toolCallId: `calc-${group.paraphrase_group}`, input: request };
    const result = seen.result;
    const toolValue = result?.status === 'ok' && result.value !== null ? result.value : group.expected_value;
    const stated = modelId === FAKE_CALC_SKIP_RULE_MODEL ? group.skip_rule.stated_value : toolValue;
    return { kind: 'text', text: answerText({ request, result, stated, unit: group.unit, citeAlias, language }) };
  }

  if (blockMode) {
    const result = evaluateCalc(request, { aliases: aliasSet });
    const computed = result.status === 'ok' && result.value !== null ? result.value : group.expected_value;
    const stated = modelId === FAKE_CALC_SKIP_RULE_MODEL ? group.skip_rule.stated_value : computed;
    const visible = answerText({ request, result, stated, unit: group.unit, citeAlias, language });
    return { kind: 'text', text: `${visible}\n\n${CALC_BLOCK_OPEN}${JSON.stringify(request)}${CALC_BLOCK_CLOSE}` };
  }

  return { kind: 'text', text: answerText({ request, result: null, stated: group.skip_rule.stated_value, unit: group.unit, citeAlias, language }) };
}

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function finish(unified: 'stop' | 'tool-calls'): LanguageModelV3FinishReason {
  return { unified, raw: unified };
}

/** A calculation fake as a mock model; `fallback` answers questions outside the scripts. */
export function createFakeCalcModel(
  modelId: FakeCalcModelId,
  fallback: (options: LanguageModelV3CallOptions) => string,
  scripts: CalcFakeScripts = loadCalcFakeScripts(),
): LanguageModel {
  const turn = (options: LanguageModelV3CallOptions): CalcFakeTurn => scriptCalcTurn(modelId, options, scripts) ?? { kind: 'text', text: fallback(options) };
  return new MockLanguageModelV3({
    provider: 'fake',
    modelId,
    doGenerate: async (options) => {
      const scripted = turn(options);
      const content: LanguageModelV3Content[] =
        scripted.kind === 'tool-call'
          ? [{ type: 'tool-call', toolCallId: scripted.toolCallId, toolName: CALCULATE_TOOL, input: JSON.stringify(scripted.input) }]
          : [{ type: 'text', text: scripted.text }];
      return { content, finishReason: finish(scripted.kind === 'tool-call' ? 'tool-calls' : 'stop'), usage: USAGE, warnings: [] };
    },
    doStream: async (options) => {
      const scripted = turn(options);
      const parts: LanguageModelV3StreamPart[] =
        scripted.kind === 'tool-call'
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: scripted.toolCallId, toolName: CALCULATE_TOOL, input: JSON.stringify(scripted.input) },
              { type: 'finish', finishReason: finish('tool-calls'), usage: USAGE },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'fake-text' },
              ...splitForStreaming(scripted.text).map((delta) => ({ type: 'text-delta' as const, id: 'fake-text', delta })),
              { type: 'text-end', id: 'fake-text' },
              { type: 'finish', finishReason: finish('stop'), usage: USAGE },
            ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  }) as unknown as LanguageModel;
}
