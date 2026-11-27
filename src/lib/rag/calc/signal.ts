export type CalcOfferReason = 'question_quantity' | 'intent_with_context_quantity';

export interface CalcOfferInput {
  question: string;
  blockTexts: readonly string[];
  language: string | null;
}

export function mayOfferCalc(_question: string, _language: string | null): boolean {
  return false;
}

export function shouldOfferCalcTool(_input: CalcOfferInput): { offer: boolean; reason: CalcOfferReason | null } {
  return { offer: false, reason: null };
}
