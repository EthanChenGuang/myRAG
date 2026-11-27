import type { ContextBlock } from '../types';

export type DecomposedAnswerBlockRef = Pick<ContextBlock, 'alias' | 'isImage' | 'subQuestionIndexes'>;

export interface DecomposedAnswerInput {
  subQuestions: readonly string[];
  comparison: boolean;
  uncoveredIndexes: readonly number[];
  blocks: readonly DecomposedAnswerBlockRef[];
  language: string | null;
  citationsActive: boolean;
}

export function uncoveredSubQuestions(_count: number, _blocks: readonly DecomposedAnswerBlockRef[]): number[] {
  return [];
}

export function buildDecomposedAnswerBlock(_input: DecomposedAnswerInput): string | null {
  return null;
}
