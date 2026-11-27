import type { RpcClient } from '../backend/supabase-rpc';
import { normalizeLexical } from '../lexical/tokenize';
import { terminologyParams } from '../terminology/expand';
import { getTerminologyLexicon } from '../terminology/lexicon';
import { buildMatcher, type TermEntry, type TerminologyMatcher } from '../terminology/matcher';
import { scopeKey, type TenantScope } from '../tenant/scope';

/** XLG-05 (D-13): one TERM translation entry: source surfaces in `sourceLanguage`, the required translation in `targetLanguage`. */
export interface GlossaryPair {
  entryId: string;
  sourceLanguage: string;
  targetLanguage: string;
  sources: readonly string[];
  target: string;
}

/** The tenant's effective glossary and the TERM version it was read at. */
export interface TenantGlossary {
  tenantKey: string;
  version: string;
  pairs: readonly GlossaryPair[];
}

/** A target term the translation of one text must contain. */
export interface RequiredTranslation {
  entryId: string;
  sources: readonly string[];
  target: string;
}

/** D-14: ok (every target present), corrected (one replacement per missing target of its source surface) or lost. */
export type GlossaryEnforcement = { status: 'ok'; text: string } | { status: 'corrected'; text: string; replacements: number } | { status: 'lost' };

type GlossaryInput = TenantGlossary | readonly GlossaryPair[] | null | undefined;

function pairsOf(glossary: GlossaryInput): readonly GlossaryPair[] {
  if (!glossary) return [];
  return Array.isArray(glossary) ? glossary : (glossary as TenantGlossary).pairs;
}

/** The pairs as matcher entries (not kind translation: the 4.1.1 matcher skips those, D-32), keyed back by entry id. */
function asEntry(entryId: string, surfaces: readonly string[], language: string): TermEntry {
  return {
    entryId,
    layer: 'shared',
    canonical: surfaces[0] ?? '',
    variants: [...surfaces],
    normalizedVariants: [],
    language,
    kind: 'synonym',
    mode: 'one_way',
    sourceLanguage: null,
    targetLanguage: null,
  };
}

const matcherMemo = new WeakMap<readonly GlossaryPair[], Map<string, TerminologyMatcher>>();

function minHanChars(): number {
  return terminologyParams().min_han_chars;
}

function sourceMatcher(pairs: readonly GlossaryPair[], sourceLanguage: string, targetLanguage: string): TerminologyMatcher {
  const key = `${sourceLanguage}\u0000${targetLanguage}`;
  let byKey = matcherMemo.get(pairs);
  if (!byKey) {
    byKey = new Map();
    matcherMemo.set(pairs, byKey);
  }
  let matcher = byKey.get(key);
  if (!matcher) {
    const entries = pairs
      .filter((pair) => pair.sourceLanguage === sourceLanguage && pair.targetLanguage === targetLanguage && pair.target.trim() !== '')
      .map((pair) => asEntry(pair.entryId, pair.sources, pair.sourceLanguage));
    matcher = buildMatcher(entries, { minHanChars: minHanChars() });
    byKey.set(key, matcher);
  }
  return matcher;
}

/**
 * D-14: the glossary source terms found in `text` (the 4.1.1 matcher: Han substrings, Latin word boundaries, elisions and accents
 * folded by normalizeLexical, longest match first) and the target terms a translation into `targetLanguage` must contain. Rows for
 * another language pair are ignored. Pure; logs nothing.
 */
export function requiredTranslations(text: string, sourceLanguage: string, targetLanguage: string, glossary: GlossaryInput): RequiredTranslation[] {
  const pairs = pairsOf(glossary);
  if (pairs.length === 0 || text === '' || sourceLanguage === targetLanguage) return [];
  const byId = new Map(pairs.map((pair) => [pair.entryId, pair]));
  const out: RequiredTranslation[] = [];
  const seen = new Set<string>();
  for (const match of sourceMatcher(pairs, sourceLanguage, targetLanguage).match(text)) {
    const pair = byId.get(match.entry.entryId);
    if (!pair || seen.has(pair.entryId)) continue;
    seen.add(pair.entryId);
    out.push({ entryId: pair.entryId, sources: pair.sources, target: pair.target });
  }
  return out;
}

/** The text normalized character by character, with each normalized index mapped to its original index (end included). */
function normalizedWithOffsets(text: string): { normalized: string; offsets: number[] } | null {
  let normalized = '';
  const offsets: number[] = [];
  let index = 0;
  for (const char of text) {
    const piece = normalizeLexical(char);
    for (let k = 0; k < piece.length; k += 1) offsets.push(index);
    normalized += piece;
    index += char.length;
  }
  offsets.push(text.length);
  // Composition across characters would break the mapping; such an output cannot be corrected safely.
  return normalizeLexical(text) === normalized ? { normalized, offsets } : null;
}

function contains(text: string, surfaces: readonly string[], entryId: string): boolean {
  return buildMatcher([asEntry(entryId, surfaces, 'any')], { minHanChars: 1 }).match(text).length > 0;
}

/**
 * D-14: checks one translated text against the required targets. Every target present: ok. A missing target whose source surface
 * is still in the output: its first occurrence is replaced by the target once (corrected). A missing target with no source surface
 * left: lost, and the caller discards the translation (skip reason glossary_term_lost). Pure; logs nothing.
 */
export function enforceGlossary(output: string, required: readonly RequiredTranslation[]): GlossaryEnforcement {
  const missing = required.filter((item) => !contains(output, [item.target], item.entryId));
  if (missing.length === 0) return { status: 'ok', text: output };
  const mapped = normalizedWithOffsets(output);
  if (!mapped) return { status: 'lost' };
  const spans: Array<{ start: number; end: number; target: string }> = [];
  for (const item of missing) {
    const match = buildMatcher([asEntry(item.entryId, item.sources, 'any')], { minHanChars: 1 })
      .match(mapped.normalized)
      .find((found) => !spans.some((span) => mapped.offsets[found.start]! < span.end && span.start < mapped.offsets[found.end]!));
    if (!match) return { status: 'lost' };
    spans.push({ start: mapped.offsets[match.start]!, end: mapped.offsets[match.end]!, target: item.target });
  }
  let text = output;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) text = text.slice(0, span.start) + span.target + text.slice(span.end);
  return { status: 'corrected', text, replacements: spans.length };
}

export interface LoadGlossaryOptions {
  signal?: AbortSignal;
  /** Tests: the service-role client and the clock, passed to the 4.1.1 loader. */
  client?: RpcClient;
  now?: () => number;
}

/**
 * D-14: the scope's translation pairs with a target, from the 4.1.1 per-tenant loader (keyed by scopeKey, workspace rows win),
 * whatever RAG_TERMINOLOGY says. Null when the dictionary cannot be loaded or belongs to another tenant; never throws, logs no term.
 */
export async function loadTenantGlossary(scope: TenantScope, options: LoadGlossaryOptions = {}): Promise<TenantGlossary | null> {
  try {
    const tenantKey = scopeKey(scope);
    const lexicon = await getTerminologyLexicon(scope, { kinds: ['translation'], includeTranslations: true }, options);
    const pairs: GlossaryPair[] = lexicon.translations.map((pair) => ({
      entryId: pair.entry_id,
      sourceLanguage: pair.source_language,
      targetLanguage: pair.target_language,
      sources: pair.sources,
      target: pair.target,
    }));
    return { tenantKey, version: lexicon.version, pairs };
  } catch {
    return null;
  }
}

/**
 * D-14 (rewriting): the glossary source surfaces present in `text`, as written there, for every target language of the pairs whose
 * source is `sourceLanguage` (requiredTranslations over all targets). The post-checks require them verbatim in a same-language
 * rewrite; they are never protected tokens of the gate, so the semantic-cache bypass set is unchanged. Pure; logs nothing.
 */
export function glossarySourceSurfaces(text: string, sourceLanguage: string, glossary: GlossaryInput): string[] {
  const pairs = pairsOf(glossary);
  if (pairs.length === 0 || text === '') return [];
  const targets = [...new Set(pairs.filter((pair) => pair.sourceLanguage === sourceLanguage).map((pair) => pair.targetLanguage))];
  if (targets.length === 0) return [];
  const mapped = normalizedWithOffsets(text);
  const spans: Array<{ start: number; end: number }> = [];
  for (const target of targets) {
    if (!mapped) continue;
    for (const match of sourceMatcher(pairs, sourceLanguage, target).match(mapped.normalized)) {
      spans.push({ start: mapped.offsets[match.start]!, end: mapped.offsets[match.end]! });
    }
  }
  if (!mapped) {
    // No offset map: keep only the surfaces that appear verbatim, so the check never asks for a spelling the text lacks.
    const verbatim = requiredFor(text, sourceLanguage, targets, pairs).flatMap((item) => item.sources.filter((source) => text.includes(source)));
    return [...new Set(verbatim)];
  }
  const out: string[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const surface = text.slice(span.start, span.end);
    if (surface.trim() !== '' && !out.includes(surface)) out.push(surface);
  }
  return out;
}

function requiredFor(text: string, sourceLanguage: string, targets: readonly string[], pairs: readonly GlossaryPair[]): RequiredTranslation[] {
  return targets.flatMap((target) => requiredTranslations(text, sourceLanguage, target, pairs));
}
