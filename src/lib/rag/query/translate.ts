import type { TranslatedQuery } from './variants';
import type { TranslateSkip } from './llamaindex/translate';
import type { PostCheckLimits, PostCheckSkipReason } from './post-checks';
import type { Lang } from './rewrite-gate';
import type { QueryTransformer } from './transformer';

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

/** What the query layer adds to the D-22 context: the KB targets (D-23) and the D-15 post-check inputs. */
export interface QueryLayerTranslateContext extends TranslateContext {
  sourceLanguage: Lang;
  /** From translationTargets; empty means nothing to translate. */
  targets: readonly Lang[];
  protectedTokens: readonly string[];
  /** QueryParams.max_translations. */
  maxItems?: number;
  limits?: PostCheckLimits;
  /** The framework's transformer (D-02); the native one when absent. */
  transformer?: Pick<QueryTransformer, 'translate'>;
  /** Receives every discarded or failed target (reason only, never text). */
  onSkip?: (skip: TranslateSkip) => void;
}

const POST_CHECK_REASONS: ReadonlySet<string> = new Set<PostCheckSkipReason>(['protected_token_lost', 'length', 'empty', 'cap']);

export class TranslateCallFailed extends Error {
  constructor() {
    super('[Query Layer] translate call failed');
    this.name = 'TranslateCallFailed';
  }
}

function isQueryLayerContext(ctx: TranslateContext): ctx is QueryLayerTranslateContext {
  return Array.isArray((ctx as Partial<QueryLayerTranslateContext>).targets);
}

export const QUERY_LAYER_TRANSLATOR_NAME = 'query_layer';

/**
 * D-24: the Phase 6 small-model translator behind the Phase 4 D-22 contract, delegating to QueryTransformer.translate.
 * Without query-layer targets it translates nothing. When every target failed in the model call (not in a post-check) it
 * throws, so the stage is recorded skipped rather than ok.
 */
export const queryLayerTranslator: Translator = Object.freeze({
  name: QUERY_LAYER_TRANSLATOR_NAME,
  translate: async (text: string, ctx: TranslateContext): Promise<TranslatedQuery[]> => {
    if (!isQueryLayerContext(ctx) || ctx.targets.length === 0) return [];
    const transformer = ctx.transformer ?? (await import('./transformer')).getQueryTransformer();
    const result = await transformer.translate({
      query: text,
      language: ctx.sourceLanguage,
      targets: ctx.targets,
      protectedTokens: ctx.protectedTokens,
      signal: ctx.signal,
      ...(ctx.maxItems !== undefined ? { maxItems: ctx.maxItems } : {}),
      ...(ctx.limits ? { limits: ctx.limits } : {}),
    });
    for (const skip of result.skipped) ctx.onSkip?.(skip);
    if (result.variants.length === 0 && result.skipped.some((skip) => !POST_CHECK_REASONS.has(skip.reason))) {
      throw new TranslateCallFailed();
    }
    return result.variants.map((variant) => ({ text: variant.text, language: variant.language }));
  },
});

/** Tests and eval only: serves hand-written translations of known questions and nothing for any other text. */
export function createFixtureTranslator(table: TranslationTable): Translator {
  const byQuestion = parseTable(table);
  return {
    name: 'fixture',
    translate: async (text) => (byQuestion.get(normalizeTranslationKey(text)) ?? []).map((item) => ({ ...item })),
  };
}
