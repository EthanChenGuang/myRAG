import crypto from 'node:crypto';
import type { RagConfig } from '../config';
import { loadTenantIdentifierPatterns } from '../identifiers/patterns';
import { loadEffectiveDictionary, type EffectiveDictionary } from '../terminology/load';
import { buildMatcher, type TermEntry, type TerminologyMatcher } from '../terminology/matcher';
import { assertTenantScope, type TenantScope } from '../tenant/scope';
import type { LexicalOptions } from './options';
import { normalizeLexical } from './tokenize';

/**
 * Per-tenant options of the shared lexical tokenizer for index-side text (LANG-07 D-08..D-10, RET-15 D-30): the tenant's effective TERM
 * dictionary through the 4.1.1 loader and matcher, Italian stemming with the document language, and the tenant's identifier patterns.
 * The tenant comes only from scopeKey(scope). A load failure answers no tokens of that kind, no stamp and a warning code; logs carry
 * version strings and counts only (4.1.1 D-21).
 */

export type LexicalSwitches = {
  v2: Pick<RagConfig['v2'], 'lexicalDictionary' | 'lexicalStemIt' | 'identifierIndex'> & Partial<Pick<RagConfig['v2'], 'lexicalQuantity'>>;
};

/** The one off rule of every lexical option: false means no resolve, no load and today's text and version. */
export function lexicalOptionsOn(config: LexicalSwitches | undefined): boolean {
  if (!config) return false;
  const { lexicalDictionary, lexicalStemIt, identifierIndex } = config.v2;
  return lexicalDictionary || lexicalStemIt || identifierIndex;
}

export type LexicalOptionsWarning = 'lexical_dictionary_unavailable' | 'identifier_patterns_unavailable';

/** What a chunk records about the options its lexical_text was built with; null means that part was not used. */
export interface LexicalStamp {
  /** Effective TERM version `s<shared>[.w<tenant>]` (chunk metadata key lexical_dict_version). */
  dictVersion: string | null;
  /** `p` plus 12 hex characters over the tenant's enabled patterns (chunk metadata key lexical_patterns). */
  patterns: string | null;
}

export interface ResolvedLexicalOptions {
  options: LexicalOptions | undefined;
  stamp: LexicalStamp;
  warnings: LexicalOptionsWarning[];
}

export interface ResolveLexicalInput {
  language: string | null;
  signal?: AbortSignal;
}

export type LexicalOptionsResolver = (scope: TenantScope, config: LexicalSwitches, input: ResolveLexicalInput) => Promise<ResolvedLexicalOptions>;

const LOG = '[RAG Lexical]';
const MIN_HAN_CHARS = 2;
const HAN_CHAR = /\p{Script=Han}/gu;
const WHITESPACE = /\s/u;
const EXCLUDED_KINDS: ReadonlySet<TermEntry['kind']> = new Set(['misspelling', 'identifier']);

/** D-08: Han terms of two or more characters, Latin terms of more than one word or with an elision. */
function qualifies(normalized: string): boolean {
  if ((normalized.match(HAN_CHAR)?.length ?? 0) >= MIN_HAN_CHARS) return true;
  return WHITESPACE.test(normalized) || normalized.includes("'");
}

function surface(text: string): string {
  return normalizeLexical(text).trim();
}

/**
 * The lexical view of one entry for the shared matcher: canonical and variants that qualify, matched one way, and emitted as the
 * canonical when it qualifies (so a variant and its canonical share one token). Translation pairs join as ordinary terms (D-08).
 */
function lexicalEntry(entry: TermEntry): TermEntry | null {
  if (EXCLUDED_KINDS.has(entry.kind)) return null;
  const forms = [...new Set([entry.canonical, ...entry.variants, ...entry.normalizedVariants].map(surface))].filter((form) => form !== '' && qualifies(form));
  if (forms.length === 0) return null;
  return {
    ...entry,
    kind: entry.kind === 'translation' ? 'synonym' : entry.kind,
    mode: 'one_way',
    variants: forms,
    normalizedVariants: forms,
  };
}

const matchers = new WeakMap<EffectiveDictionary, TerminologyMatcher>();

function lexicalMatcher(dictionary: EffectiveDictionary): TerminologyMatcher {
  let matcher = matchers.get(dictionary);
  if (!matcher) {
    const entries = dictionary.entries.map(lexicalEntry).filter((item): item is TermEntry => item !== null);
    matcher = buildMatcher(entries, { minHanChars: MIN_HAN_CHARS });
    matchers.set(dictionary, matcher);
  }
  return matcher;
}

function dictionaryOption(dictionary: EffectiveDictionary): NonNullable<LexicalOptions['dictionary']> {
  const matcher = lexicalMatcher(dictionary);
  return {
    version: dictionary.version,
    match(normalized: string) {
      return matcher.match(normalized).map((found) => {
        const canonical = surface(found.entry.canonical);
        return { term: qualifies(canonical) ? canonical : found.surface };
      });
    },
  };
}

/** Sorted `id|pattern|flags` lines of the enabled, compiled patterns; flags as stored (`u` or `iu`). */
export function identifierPatternsFingerprint(patternIds: readonly string[], expressions: readonly RegExp[]): string {
  const lines = patternIds.map((id, index) => {
    const expression = expressions[index]!;
    return `${id}|${expression.source}|${expression.flags.includes('i') ? 'iu' : 'u'}`;
  });
  return `p${crypto.createHash('sha256').update(lines.sort().join('\n')).digest('hex').slice(0, 12)}`;
}

const defaultResolver: LexicalOptionsResolver = async (scope, config, input) => {
  assertTenantScope(scope);
  const { lexicalDictionary, lexicalStemIt, identifierIndex } = config.v2;
  const stamp: LexicalStamp = { dictVersion: null, patterns: null };
  const warnings: LexicalOptionsWarning[] = [];
  if (!lexicalDictionary && !lexicalStemIt && !identifierIndex) return { options: undefined, stamp, warnings };

  const options: LexicalOptions = {};
  if (lexicalStemIt) {
    options.stemIt = true;
    options.language = input.language;
  }

  if (lexicalDictionary) {
    try {
      const dictionary = await loadEffectiveDictionary(scope, input.signal ? { signal: input.signal } : {});
      options.dictionary = dictionaryOption(dictionary);
      stamp.dictVersion = dictionary.version;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      console.warn(`${LOG} dictionary unavailable; lexical text built without dictionary tokens`, { code: 'lexical_dictionary_unavailable' });
      warnings.push('lexical_dictionary_unavailable');
    }
  }

  if (identifierIndex) {
    const loaded = await loadTenantIdentifierPatterns(scope, input.signal ? { signal: input.signal } : {});
    if (loaded.loadFailed) {
      warnings.push('identifier_patterns_unavailable');
    } else {
      options.identifierPatterns = loaded.expressions;
      stamp.patterns = identifierPatternsFingerprint(loaded.patternIds, loaded.expressions);
    }
  }

  const empty = options.stemIt === undefined && options.dictionary === undefined && options.identifierPatterns === undefined;
  return { options: empty ? undefined : options, stamp, warnings };
};

let resolver: LexicalOptionsResolver = defaultResolver;

/** One resolve per document (ingest) or per tenant (relex); loaders cache per tenant key. */
export async function resolveLexicalOptions(scope: TenantScope, config: LexicalSwitches, input: ResolveLexicalInput): Promise<ResolvedLexicalOptions> {
  return resolver(scope, config, input);
}

export function setLexicalOptionsResolverForTests(next: LexicalOptionsResolver): void {
  resolver = next;
}

export function resetLexicalOptionsForTests(): void {
  resolver = defaultResolver;
}
