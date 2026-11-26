import { OUTPUT_POLICY_NOTICE, OUTPUT_POLICY_NOTICE_UNTAGGED } from '../context/wrap';
import { fixedText, type TextKey, type TextParams } from '../lang/texts';
import type { AnswerConfig } from './answer-config';
import type { AnswerChannel } from './answer-turn';
import { NO_ANSWER_SENTINEL } from './sentinel';

/** Phase 5.2 D-05: the fixed order of the answer-rule block; the citation instruction (part 1) is appended before it by Phase 5. */
export const ANSWER_RULE_IDS = [
  'relevance',
  'partial_answer',
  'general_knowledge',
  'web_separation',
  'version',
  'calculation',
  'concise',
  'output_policy',
] as const;

export type AnswerRuleId = (typeof ANSWER_RULE_IDS)[number];

export interface AnswerRulesInput {
  /** The final system prompt: mode wrapper applied, {{context}} substituted, citation instruction appended. Never edited. */
  prompt: string;
  /** The RAG mode: strict, balanced, flexible or bypass. */
  mode: string;
  /** D-09 answer language; null falls back to RAG_PRIMARY_LANGUAGE through the registry reader. */
  language: string | null;
  config: Pick<AnswerConfig, 'partialAnswerRule' | 'contextRelevanceRule' | 'versionLabels' | 'outputGuard'>;
  channel: AnswerChannel;
  webSearchOffered: boolean;
  /** D-32; set from the output-cap rules by plan 05.2-10. */
  capApplies: boolean;
  /** D-70; set by Phase 5.2.1. */
  calcOffered: boolean;
  contextTagging: boolean;
}

interface Part {
  id: AnswerRuleId;
  text: () => string;
}

function plan(input: AnswerRulesInput): Part[] {
  const { config, mode, channel } = input;
  const voice = channel === 'voice';
  const webSearch = input.webSearchOffered && !voice;
  const language = input.language ?? '';
  let cachedParams: TextParams | null = null;
  const params = (): TextParams => {
    if (cachedParams) return cachedParams;
    const notCovered = fixedText('labels.not_covered', language);
    cachedParams = {
      // D-16: no stream transform runs on the voice answer, so the spoken phrase stands in for the token.
      sentinel: voice ? notCovered : NO_ANSWER_SENTINEL,
      not_covered: notCovered,
      general_knowledge: fixedText('labels.general_knowledge', language),
      from_documents: fixedText('labels.from_documents', language),
      from_web: fixedText('labels.from_web', language),
    };
    return cachedParams;
  };
  const registry = (id: AnswerRuleId, key: TextKey): Part => ({ id, text: () => fixedText(key, language, params()) });

  const parts: Part[] = [];
  const strict = mode === 'strict';
  const open = mode === 'balanced' || mode === 'flexible';
  if (strict || open) {
    if (config.contextRelevanceRule) {
      const key: TextKey = strict ? (webSearch ? 'instructions.relevance_web' : 'instructions.relevance') : 'instructions.relevance_open';
      parts.push(registry('relevance', key));
    }
    if (config.partialAnswerRule && strict) parts.push(registry('partial_answer', 'instructions.partial_answer'));
    if (config.partialAnswerRule && mode === 'balanced') parts.push(registry('general_knowledge', 'instructions.general_knowledge'));
    if (config.partialAnswerRule && strict && webSearch) parts.push(registry('web_separation', 'instructions.web_separation'));
    if (config.versionLabels) parts.push(registry('version', 'instructions.version'));
    if (input.calcOffered && !voice) parts.push(registry('calculation', 'instructions.calculation'));
    if (input.capApplies && !voice) parts.push(registry('concise', 'instructions.concise'));
  }
  if (config.outputGuard === 'flag' || config.outputGuard === 'enforce') {
    parts.push({ id: 'output_policy', text: () => (input.contextTagging ? OUTPUT_POLICY_NOTICE : OUTPUT_POLICY_NOTICE_UNTAGGED) });
  }
  return parts;
}

/** The ids of the parts composeAnswerRules would append, in block order. */
export function composedPartIds(input: AnswerRulesInput): readonly AnswerRuleId[] {
  return plan(input).map((part) => part.id);
}

/**
 * Phase 5.2 D-04: the one place that builds the instructions this phase and Phase 5.2.1 add. Appends the parts after
 * the prompt, each headed by its ASCII rule id line; returns the prompt itself when no part applies. `log: false` skips
 * the `[Answer Rules]` line when a turn composes a second prompt (the Claude Citations system text).
 */
export function composeAnswerRules(input: AnswerRulesInput, options: { log?: boolean } = {}): string {
  const parts = plan(input);
  if (parts.length === 0) return input.prompt;
  if (options.log !== false) console.log('[Answer Rules]', { parts: parts.map((part) => part.id), mode: input.mode, channel: input.channel });
  return [input.prompt, ...parts.map((part) => `[rule:${part.id}]\n${part.text()}`)].join('\n\n');
}
