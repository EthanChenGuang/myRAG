import type { AnswerConfig } from './answer-config';
import type { AnswerChannel } from './answer-turn';

export const ANSWER_RULE_IDS = [] as const;

export type AnswerRuleId = string;

export interface AnswerRulesInput {
  prompt: string;
  mode: string;
  language: string | null;
  config: Pick<AnswerConfig, 'partialAnswerRule' | 'contextRelevanceRule' | 'versionLabels' | 'outputGuard'>;
  channel: AnswerChannel;
  webSearchOffered: boolean;
  capApplies: boolean;
  calcOffered: boolean;
  contextTagging: boolean;
}

export function composedPartIds(_input: AnswerRulesInput): readonly AnswerRuleId[] {
  return [];
}

export function composeAnswerRules(input: AnswerRulesInput): string {
  return input.prompt;
}
