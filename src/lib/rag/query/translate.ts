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

export const NONE_TRANSLATOR_NAME = 'none';

export const NONE_TRANSLATOR: Translator = Object.freeze({
  name: NONE_TRANSLATOR_NAME,
  translate: async () => [],
});
const noneTranslator = NONE_TRANSLATOR;

let current: Translator = noneTranslator;

/** The translator behind the translate stage. None until a translator registers; the Phase 6 translator takes this slot. */
export function getTranslator(): Translator {
  return current;
}

export function setTranslatorForTests(translator: Translator): void {
  current = translator;
}

export function resetTranslatorForTests(): void {
  current = noneTranslator;
}

export function normalizeTranslationKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim();
}

function invalidTable(reason: string): Error {
  return new Error(`[Translation] invalid translation table: ${reason}`);
}

function parseTable(table: TranslationTable): Map<string, TranslatedQuery[]> {
  if (!table || table.version !== 1 || !Array.isArray(table.entries)) throw invalidTable('expected version 1 and an entries array');
  const byQuestion = new Map<string, TranslatedQuery[]>();
  for (const entry of table.entries) {
    if (typeof entry?.question !== 'string' || entry.question.trim() === '' || !Array.isArray(entry.translations)) {
      throw invalidTable('an entry needs a question and translations');
    }
    const translations = entry.translations.map((item) => {
      if (typeof item?.text !== 'string' || item.text.trim() === '' || typeof item.language !== 'string' || item.language === '') {
        throw invalidTable('a translation needs text and a language');
      }
      return { text: item.text, language: item.language };
    });
    byQuestion.set(normalizeTranslationKey(entry.question), translations);
  }
  return byQuestion;
}

/** Tests and eval only: serves hand-written translations of known questions and nothing for any other text. */
export function createFixtureTranslator(table: TranslationTable): Translator {
  const byQuestion = parseTable(table);
  return {
    name: 'fixture',
    translate: async (text) => (byQuestion.get(normalizeTranslationKey(text)) ?? []).map((item) => ({ ...item })),
  };
}
