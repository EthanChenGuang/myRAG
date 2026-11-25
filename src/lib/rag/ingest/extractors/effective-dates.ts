export type EffectiveDateSource = 'rule' | 'model';

export interface ExtractedEffectiveDates {
  from: string | null;
  to: string | null;
  confidence: number;
  evidenceQuote: string;
  source: EffectiveDateSource;
}

export interface ExtractEffectiveDatesOptions {
  language: string | null;
  primary: string | null;
  llm?: { filename: string; signal: AbortSignal } | null;
}

export interface ExtractEffectiveDatesOutput {
  result: ExtractedEffectiveDates | null;
  warnings: string[];
}

export interface EffectiveDateLlmInput {
  filename: string;
  text: string;
  language: string | null;
  signal: AbortSignal;
}

export type EffectiveDateLlmCall = (input: EffectiveDateLlmInput) => Promise<unknown>;

export const RULE_CONFIDENCE = 0.9;
export const MAX_LLM_TEXT_CHARS = 8000;

export function setEffectiveDateLlmForTests(_call: EffectiveDateLlmCall | null): void {}

export async function extractEffectiveDates(_text: string, _options: ExtractEffectiveDatesOptions): Promise<ExtractEffectiveDatesOutput> {
  return { result: null, warnings: [] };
}
