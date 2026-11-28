import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import type { ContextBlock } from '../types';
import { measureAnswerStructure, type AnswerStructure } from './answer-structure';
import { uncoveredSubQuestions, type DecomposedAnswerInput } from './decomposed-answer';

interface DecomposedTurnResult {
  queryPlan?: { sub_questions?: readonly string[]; language?: string | null; gate?: { reasons?: readonly string[] } } | null;
  blocks?: readonly ContextBlock[];
}

function decomposedAnswerEffective(): boolean {
  try {
    return loadRagConfig(getRagDeps().ragEnv()).queryAdditions.effective.decomposedAnswer;
  } catch {
    return false;
  }
}

/**
 * Phase 6.2 D-11, D-12: the decomposed-answer input of a turn whose final plan has two or more sub-questions and whose
 * knowledge-base context reached the model, while RAG_DECOMPOSED_ANSWER is effective; undefined otherwise (prompt unchanged).
 */
export function decomposedAnswerFor(
  result: DecomposedTurnResult | null | undefined,
  options: { citationsActive: boolean },
): DecomposedAnswerInput | undefined {
  const plan = result?.queryPlan;
  const subQuestions = plan?.sub_questions ?? [];
  if (!plan || subQuestions.length < 2) return undefined;
  const blocks = result?.blocks ?? [];
  if (!blocks.some((block) => !block.isImage)) return undefined;
  if (!decomposedAnswerEffective()) return undefined;
  return {
    subQuestions: [...subQuestions],
    comparison: (plan.gate?.reasons ?? []).includes('R3_COMPARISON'),
    uncoveredIndexes: uncoveredSubQuestions(subQuestions.length, blocks),
    blocks,
    language: plan.language ?? null,
    citationsActive: options.citationsActive,
  };
}

/** D-12: the report-only structure of the finished answer of a decomposed turn. */
export function answerStructureFor(input: DecomposedAnswerInput, answer: string, aliases: ReadonlySet<string> | null): AnswerStructure {
  return measureAnswerStructure({ answer, subQuestionCount: input.subQuestions.length, language: input.language, aliases });
}

/** The chat and embed trace record of answer_structure: counts only; cited_parts is omitted when not measured. */
export function answerStructureStage(structure: AnswerStructure, at: number) {
  return {
    name: 'answer_structure',
    status: 'ok' as const,
    startedAt: at,
    endedAt: at,
    counts: {
      parts: structure.parts,
      ...(structure.cited_parts !== null ? { cited_parts: structure.cited_parts } : {}),
      uncovered_parts: structure.uncovered_parts,
    },
    attributes: { cited_parts_measured: structure.cited_parts !== null },
  };
}
