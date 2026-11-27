import type { PromptBudgetTrace } from '@/lib/rag-eval/contracts.generated';
import type { PromptBudgetConfig, TokenizerCalibration } from './prompt-budget-config';

export interface BudgetMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
}
export interface PromptBudgetInput {
  window: number | null;
  family: string | null;
  parts: { system: string; rules: string; tools: unknown; question: string };
  history: readonly BudgetMessage[];
  answerReserve: number;
  documentTarget: number;
  standaloneQuery?: string | null;
  answerLanguage?: string;
  mcpToolReserve?: boolean;
  overflowMode?: 'truncate' | 'refine';
  config?: PromptBudgetConfig;
  calibration?: TokenizerCalibration;
  count?: (text: string) => number;
}
export interface PromptBudgetPlan {
  status: 'ok' | 'exceeded';
  documentBudget: number;
  keptHistory: BudgetMessage[];
  standaloneNote: string | null;
  trace: PromptBudgetTrace;
}
export class PromptOrderError extends Error {
  constructor(readonly code: 'question_missing' | 'question_not_last') {
    super(code);
  }
}
export function groupHistoryTurns(_messages: readonly BudgetMessage[]): BudgetMessage[][] {
  return [];
}
export function planPromptBudget(_input: PromptBudgetInput): PromptBudgetPlan {
  return { status: 'ok', documentBudget: 0, keptHistory: [], standaloneNote: null, trace: {} as PromptBudgetTrace };
}
export function finalizePromptBudget(
  plan: PromptBudgetPlan,
  _built: { builtParts: Partial<Record<'system' | 'rules' | 'tools' | 'question' | 'documents', unknown>>; droppedDocuments: number },
): { status: 'ok' | 'exceeded'; action: 'confirmed' | 'dropped_history' | 'exceeded'; keptHistory: BudgetMessage[]; standaloneNote: string | null; trace: PromptBudgetTrace } {
  return { status: 'ok', action: 'confirmed', keptHistory: [], standaloneNote: null, trace: plan.trace };
}
export function assertQuestionLast(_messages: readonly BudgetMessage[], _question: string): void {}
