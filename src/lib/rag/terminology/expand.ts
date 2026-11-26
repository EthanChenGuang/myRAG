import { TerminologyParamsSchema, type TerminologyMatch, type TerminologyParams } from '@/lib/rag-eval/contracts.generated';
import { normalizeLexical, queryLexicalTokens } from '../lexical/tokenize';
import type { RawTermMatch } from './matcher';

let defaults: TerminologyParams | null = null;

/** D-17: the committed defaults of the Pydantic contract; tuned only through the sweep tool. */
export function terminologyParams(): TerminologyParams {
  defaults ??= TerminologyParamsSchema.parse({});
  return defaults;
}

export interface TermExpansion {
  matches: TerminologyMatch[];
  tokens: string[];
  capped: boolean;
}

/** One hop (D-13): one_way adds the canonical; equivalent adds the canonical and the other members; nothing is re-matched. */
function termsFor(match: RawTermMatch): string[] {
  const { entry } = match;
  if (entry.mode === 'one_way') return [entry.canonical];
  const members = [entry.canonical, ...entry.variants];
  return members.filter((member) => normalizeLexical(member).trim() !== match.surface);
}

function toContractMatch(match: RawTermMatch): TerminologyMatch {
  return {
    entry_id: match.entry.entryId,
    layer: match.entry.layer,
    canonical: match.entry.canonical,
    kind: match.entry.kind,
    language: match.entry.language as TerminologyMatch['language'],
    surface: match.surface,
    start: match.start,
    end: match.end,
  };
}

/**
 * Matches → capped lexical expansion tokens (D-13, D-17). Tokens already in the original query's token set are removed; a cap
 * that cuts anything sets capped.
 */
export function expandMatches(query: string, raw: readonly RawTermMatch[], params: TerminologyParams = terminologyParams()): TermExpansion {
  let capped = raw.length > params.max_matches;
  const kept = raw.slice(0, params.max_matches);
  const seen = new Set(queryLexicalTokens(query));
  const tokens: string[] = [];
  for (const match of kept) {
    const terms = termsFor(match);
    if (terms.length > params.max_terms_per_match) capped = true;
    for (const term of terms.slice(0, params.max_terms_per_match)) {
      for (const token of queryLexicalTokens(term)) {
        if (seen.has(token)) continue;
        if (tokens.length >= params.max_expansion_tokens) {
          capped = true;
          break;
        }
        seen.add(token);
        tokens.push(token);
      }
    }
  }
  return { matches: kept.map(toContractMatch), tokens, capped };
}

/** D-18: the standalone query (normalized) with each matched surface replaced by its canonical. */
export function substituteCanonicals(normalizedQuery: string, _matches: readonly TerminologyMatch[]): string {
  return normalizedQuery;
}
