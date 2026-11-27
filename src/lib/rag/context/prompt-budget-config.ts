import type { PromptBudgetConfig, TokenizerCalibration } from '@/lib/rag-eval/contracts.generated';

export type { PromptBudgetConfig, TokenizerCalibration };
export type FactorSource = 'measured' | 'default';

export function parsePromptBudgetConfig(raw: unknown): PromptBudgetConfig {
  return raw as PromptBudgetConfig;
}
export function parseTokenizerCalibration(raw: unknown): TokenizerCalibration {
  return raw as TokenizerCalibration;
}
export function promptBudgetConfig(): PromptBudgetConfig {
  return {} as PromptBudgetConfig;
}
export function tokenizerCalibration(): TokenizerCalibration {
  return {} as TokenizerCalibration;
}
export function promptBudgetConfigVersion(): string {
  return '';
}
export function tokenizerCalibrationVersion(): string {
  return '';
}
export function factorFor(_family: string | null, _calibration?: TokenizerCalibration): { factor: number; source: FactorSource } {
  return { factor: 1, source: 'measured' };
}
export function estimateTokens(_text: string, _family: string | null, _calibration?: TokenizerCalibration): number {
  return 0;
}
