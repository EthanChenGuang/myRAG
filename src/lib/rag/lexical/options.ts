/** Optional switches of the shared lexical tokenizer; omitted, the output is the default one (D-08, D-42). */
export interface LexicalOptions {
  /** Language of the text; with stemIt, a language with a stemmer adds stem tokens. */
  language?: string | null;
  /** RAG_LEXICAL_STEM_IT: add Italian stem tokens for text whose language is it. */
  stemIt?: boolean;
  /** Present only while RAG_LEXICAL_DICTIONARY is on: the tenant's TERM matcher (4.1.1). */
  dictionary?: {
    /** Effective TERM version `s<shared>.w<tenant>`. */
    version: string;
    /** Longest match first, non-overlapping, on normalized text. */
    match(normalized: string): ReadonlyArray<{ term: string }>;
  } | null;
  /** Tenant identifier patterns compiled with 'giu' (plan 04.2-34). */
  identifierPatterns?: readonly RegExp[];
}

/** Natural tokens start with a letter, a digit or a Han character, so these prefixes cannot collide. */
export const DICT_TOKEN_PREFIX = '_t_';
export const STEM_TOKEN_PREFIX = '_s_';
