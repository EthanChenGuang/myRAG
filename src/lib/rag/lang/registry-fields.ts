import type { LanguagePack } from './registry';

export type NumberFormat = LanguagePack['number_format'];

export function numberFormatFor(_language: string): NumberFormat {
  return { group_separators: [], decimal_marks: [], fullwidth_digits: false, magnitude_words: [] };
}

export function calcIntentTermsFor(_language: string): string[] {
  return [];
}
