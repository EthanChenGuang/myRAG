import type { TranslatedQuery } from './variants';

export interface TranslateContext {
  signal: AbortSignal;
  sourceLanguage: string | null;
}

export interface Translator {
  readonly name: string;
  translate(text: string, ctx: TranslateContext): Promise<TranslatedQuery[]>;
}

export interface TranslationTable {
  version: 1;
  entries: Array<{ question: string; translations: TranslatedQuery[] }>;
}

export function getTranslator(): Translator {
  return { name: 'unset', translate: async () => [] };
}

export function setTranslatorForTests(_translator: Translator): void {}

export function resetTranslatorForTests(): void {}

export function createFixtureTranslator(_table: TranslationTable): Translator {
  return { name: 'unset', translate: async () => [] };
}
