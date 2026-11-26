import { createHash } from 'node:crypto';
import {
  TerminologyLexiconTermSchema,
  TerminologyTranslationPairSchema,
  type TerminologyLexicon,
  type TerminologyLexiconTerm,
  type TerminologyTranslationPair,
} from '@/lib/rag-eval/contracts.generated';
import { normalizeLexical } from '../lexical/tokenize';
import { scopeKey, type TenantScope } from '../tenant/scope';
import { loadEffectiveDictionary, type EffectiveDictionary } from './load';
import type { TermEntry } from './matcher';

export type { TerminologyLexicon, TerminologyLexiconTerm, TerminologyTranslationPair };

export type TerminologyLexiconKind = TerminologyLexiconTerm['kind'];

/** D-33: the options of the stable read API (Phase 4.2 LANG-07, Phase 6.2 XLG-05). */
export interface TerminologyLexiconOptions {
  /** Keep terms of these languages and of `any`; a translation pair needs both its languages here. */
  languages?: readonly string[];
  /** Keep terms of these kinds; translation pairs need `translation` here when the filter is set. */
  kinds?: readonly TerminologyLexiconKind[];
  /** Translation pairs appear only with true (D-32). */
  includeTranslations?: boolean;
}

export class TerminologyUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`[RAG Terminology] ${message}`, options);
    this.name = 'TerminologyUnavailableError';
  }
}

const MEMO_MAX = 1024;

/** Sorted-key JSON, so the hash depends on content only. */
function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sort(record[key])]));
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

interface MemoEntry {
  entries: readonly TermEntry[];
  lexicon: TerminologyLexicon;
}

const memo = new Map<string, MemoEntry>();

function lexiconVersion(dictionary: EffectiveDictionary): string {
  return `s${dictionary.sharedVersion}.w${dictionary.workspaceVersion}`;
}

function normalizedVariants(entry: TermEntry): string[] {
  const source = entry.normalizedVariants.length === entry.variants.length ? entry.normalizedVariants : entry.variants.map(normalizeLexical);
  return source.map((value) => value.trim()).filter((value) => value.length > 0);
}

function languagesCollide(a: string, b: string): boolean {
  return a === b || a === 'any' || b === 'any';
}

/** Workspace wins a collision: a shared entry sharing a normalized variant (or, for a pair, a source and both languages) is dropped. */
function effectiveEntries(entries: readonly TermEntry[]): TermEntry[] {
  const workspace = entries.filter((entry) => entry.layer === 'workspace');
  const workspaceTerms = workspace
    .filter((entry) => entry.kind !== 'translation')
    .map((entry) => ({ language: entry.language, variants: new Set(normalizedVariants(entry)) }));
  const workspacePairs = workspace
    .filter((entry) => entry.kind === 'translation')
    .map((entry) => ({ source: entry.sourceLanguage, target: entry.targetLanguage, variants: new Set(normalizedVariants(entry)) }));
  return entries.filter((entry) => {
    if (entry.layer === 'workspace') return true;
    const variants = normalizedVariants(entry);
    if (entry.kind === 'translation') {
      return !workspacePairs.some(
        (pair) => pair.source === entry.sourceLanguage && pair.target === entry.targetLanguage && variants.some((value) => pair.variants.has(value)),
      );
    }
    return !workspaceTerms.some((other) => languagesCollide(other.language, entry.language) && variants.some((value) => other.variants.has(value)));
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTerms(a: TerminologyLexiconTerm, b: TerminologyLexiconTerm): number {
  return compareText(a.normalized, b.normalized) || compareText(a.language, b.language) || compareText(a.kind, b.kind);
}

function comparePairs(a: TerminologyTranslationPair, b: TerminologyTranslationPair): number {
  return (
    compareText(a.source_language, b.source_language) ||
    compareText(a.target_language, b.target_language) ||
    compareText(a.target_normalized, b.target_normalized) ||
    compareText(a.entry_id, b.entry_id)
  );
}

function project(dictionary: EffectiveDictionary, options: TerminologyLexiconOptions): TerminologyLexicon {
  const languages = options.languages ? new Set(options.languages) : null;
  const kinds = options.kinds ? new Set<string>(options.kinds) : null;
  const languageKept = (language: string) => !languages || language === 'any' || languages.has(language);
  const kindKept = (kind: string) => !kinds || kinds.has(kind);

  const terms = new Map<string, TerminologyLexiconTerm>();
  const addTerm = (normalized: string, language: string, kind: string) => {
    if (!languageKept(language) || !kindKept(kind)) return;
    const parsed = TerminologyLexiconTermSchema.safeParse({ normalized, language, kind });
    if (!parsed.success) return;
    terms.set(`${parsed.data.normalized}\u0000${parsed.data.language}\u0000${parsed.data.kind}`, parsed.data);
  };
  const translations: TerminologyTranslationPair[] = [];

  for (const entry of effectiveEntries(dictionary.entries)) {
    const variants = normalizedVariants(entry);
    const canonical = normalizeLexical(entry.canonical).trim();
    if (entry.kind !== 'translation') {
      for (const value of [canonical, ...variants]) if (value.length > 0) addTerm(value, entry.language, entry.kind);
      continue;
    }
    if (!options.includeTranslations || !kindKept('translation')) continue;
    const source = entry.sourceLanguage;
    const target = entry.targetLanguage;
    if (!source || !target || (languages && (!languages.has(source) || !languages.has(target)))) continue;
    const pair = TerminologyTranslationPairSchema.safeParse({
      entry_id: entry.entryId,
      source_language: source,
      target_language: target,
      sources: entry.variants,
      target: entry.canonical,
      target_normalized: canonical,
    });
    if (!pair.success) continue;
    translations.push(pair.data);
    for (const value of variants) addTerm(value, source, 'translation');
    addTerm(canonical, target, 'translation');
  }

  const sortedTerms = [...terms.values()].sort(compareTerms);
  const sortedPairs = translations.sort(comparePairs);
  const entriesSha256 = createHash('sha256')
    .update(canonicalJson({ terms: sortedTerms, translations: sortedPairs }), 'utf8')
    .digest('hex');
  return deepFreeze({ version: lexiconVersion(dictionary), entries_sha256: entriesSha256, terms: sortedTerms, translations: sortedPairs });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function optionsKey(options: TerminologyLexiconOptions): string {
  return canonicalJson({
    languages: options.languages ? [...new Set(options.languages)].sort() : null,
    kinds: options.kinds ? [...new Set(options.kinds)].sort() : null,
    includeTranslations: options.includeTranslations === true,
  });
}

function remember(key: string, entry: MemoEntry): void {
  memo.delete(key);
  memo.set(key, entry);
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/**
 * D-33: the tenant's effective dictionary as normalized terms and (with includeTranslations) translation pairs. The only tenant input is
 * the minted scope; the plan-05 loader sends its key to rag_term_effective on the service-role client. Reads no switch.
 */
export async function getTerminologyLexicon(scope: TenantScope, opts: TerminologyLexiconOptions = {}): Promise<TerminologyLexicon> {
  const tenantKey = scopeKey(scope);
  let dictionary: EffectiveDictionary;
  try {
    dictionary = await loadEffectiveDictionary(scope);
  } catch (error) {
    throw new TerminologyUnavailableError('the effective dictionary could not be loaded', { cause: error });
  }
  if (dictionary.tenantKey !== tenantKey) throw new TerminologyUnavailableError('the loaded dictionary belongs to another tenant');
  const key = `${tenantKey}\u0000${lexiconVersion(dictionary)}\u0000${optionsKey(opts)}`;
  const hit = memo.get(key);
  if (hit && hit.entries === dictionary.entries) return hit.lexicon;
  const lexicon = project(dictionary, opts);
  remember(key, { entries: dictionary.entries, lexicon });
  return lexicon;
}

export function resetTerminologyLexiconForTests(): void {
  memo.clear();
}
