import { RetrievalBackendError, rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { extractChunkIdentifiers, MAX_IDENTIFIER_CHARS } from '../identifiers/extract';
import { damerauLevenshtein, isNearMissIdentifier, MAX_IDENTIFIER_INPUT_CHARS, normalizeIdentifier } from '../ids/normalize';
import { splitAtIdentifiers } from '../ids/shapes';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';

/** rag_identifier_resolve takes at most 16 forms (0858). */
export const MAX_QUERY_IDENTIFIERS = 16;
export const MAX_IDENTIFIER_SUGGESTIONS = 3;
const CANDIDATE_LIMIT = 10;
const RESOLVE_RPC = 'rag_identifier_resolve';
const CANDIDATES_RPC = 'rag_identifier_candidates';
const HAS_LETTER = /\p{L}/u;
const HAS_DIGIT = /\d/u;
const MIN_BUILT_IN_NORM_CHARS = 3;

export interface AskedIdentifier {
  /** The spelling in the question after NFKC. */
  raw: string;
  norm: string;
}

export interface QueryIdentifiers {
  asked: AskedIdentifier[];
  /** Normalized forms that exist in the caller's tenant. */
  found: string[];
  /** Normalized forms asked for that the tenant does not have. */
  missing: string[];
}

export interface IdentifierCallOptions {
  client: RpcClient;
  signal: AbortSignal;
}

/**
 * The identifiers a question names (D-31): every tenant-pattern match, and built-in matches that mix a letter and a digit, so years,
 * amounts and counts never turn a question into an identifier question. De-duplicated by normalized form, at most 16.
 */
export function queryIdentifierEntries(query: string, patterns: readonly RegExp[]): AskedIdentifier[] {
  return shapedIdentifierEntries(query, patterns, MAX_QUERY_IDENTIFIERS);
}

function shapedIdentifierEntries(text: string, patterns: readonly RegExp[], limit: number): AskedIdentifier[] {
  const input = text.slice(0, MAX_IDENTIFIER_INPUT_CHARS).normalize('NFKC');
  const seen = new Set<string>();
  const out: AskedIdentifier[] = [];
  for (const piece of splitAtIdentifiers(input, patterns.length > 0 ? patterns : undefined)) {
    if (!piece.identifier) continue;
    const norm = normalizeIdentifier(piece.text);
    if (norm === '' || norm.length > MAX_IDENTIFIER_CHARS || seen.has(norm)) continue;
    if (!piece.extra && (norm.length < MIN_BUILT_IN_NORM_CHARS || !HAS_LETTER.test(norm) || !HAS_DIGIT.test(norm))) continue;
    seen.add(norm);
    out.push({ raw: piece.text, norm });
    if (out.length >= limit) break;
  }
  return out;
}

function tenantKeyOf(scope: TenantScope): string {
  assertTenantScope(scope);
  return scopeKey(scope).toLowerCase();
}

function stringField(row: unknown, key: string): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const value = (row as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * D-31: the question's identifiers, resolved in the caller's tenant only (the key is the scope's). A question with none costs no call;
 * a failed call raises RetrievalBackendError with the RPC name and code only.
 */
export async function resolveQueryIdentifiers(
  scope: TenantScope,
  query: string,
  patterns: readonly RegExp[],
  options: IdentifierCallOptions,
): Promise<QueryIdentifiers> {
  const tenantKey = tenantKeyOf(scope);
  const asked = queryIdentifierEntries(query, patterns);
  if (asked.length === 0) return { asked: [], found: [], missing: [] };
  const { client, signal } = options;
  signal.throwIfAborted();
  const response = await client.rpc(RESOLVE_RPC, { p_tenant_key: tenantKey, p_norm: asked.map((entry) => entry.norm) }).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new RetrievalBackendError(RESOLVE_RPC, response.error.code ?? null);
  const existing = new Set(rpcRows(response.data).map((row) => stringField(row, 'norm')).filter((norm): norm is string => norm !== null));
  const found = asked.filter((entry) => existing.has(entry.norm)).map((entry) => entry.norm);
  const missing = asked.filter((entry) => !existing.has(entry.norm)).map((entry) => entry.norm);
  return { asked, found, missing };
}

/**
 * D-31, D-51: drops each item that carries an identifier within the near-miss distance of an asked one and carries none of the asked
 * ones. Identifiers are read from the content in memory with the ingestion extractor (built-in rule plus the tenant's patterns), so a
 * separator or case variant of an asked identifier counts as that identifier. A look-alike has the same shape as an asked identifier
 * (a tenant-pattern match, or letters and digits), so a plain number never removes a passage. Items without identifiers are kept.
 */
export function guardNearMisses<T>(
  items: readonly T[],
  askedNorms: readonly string[],
  options: { contentOf: (item: T) => string; patterns?: readonly RegExp[] },
): { kept: T[]; dropped: number } {
  if (askedNorms.length === 0) return { kept: [...items], dropped: 0 };
  const asked = new Set(askedNorms);
  const patterns = options.patterns ?? [];
  const kept: T[] = [];
  let dropped = 0;
  for (const item of items) {
    const content = options.contentOf(item);
    const carriesAsked = extractChunkIdentifiers(content, patterns).norm.some((norm) => asked.has(norm));
    const nearMiss =
      !carriesAsked &&
      shapedIdentifierEntries(content, patterns, Number.POSITIVE_INFINITY).some((entry) =>
        askedNorms.some((wanted) => isNearMissIdentifier(wanted, entry.norm)),
      );
    if (nearMiss) {
      dropped += 1;
      continue;
    }
    kept.push(item);
  }
  return { kept, dropped };
}

interface Suggestion {
  raw: string;
  norm: string;
  distance: number;
}

/**
 * D-31, D-51: at most 3 existing identifiers of the caller's tenant closest to the missing ones: rag_identifier_candidates per missing
 * form, ranked by Damerau-Levenshtein distance then raw spelling, one per normalized form, never an asked form. Any failure returns none.
 */
export async function identifierSuggestions(scope: TenantScope, missing: readonly string[], options: IdentifierCallOptions): Promise<string[]> {
  const forms = [...new Set(missing.filter((norm) => norm.length > 0 && norm.length <= MAX_IDENTIFIER_CHARS))].slice(0, MAX_QUERY_IDENTIFIERS);
  if (forms.length === 0) return [];
  const { client, signal } = options;
  try {
    const tenantKey = tenantKeyOf(scope);
    signal.throwIfAborted();
    const lists = await Promise.all(
      forms.map(async (norm) => {
        const response = await client.rpc(CANDIDATES_RPC, { p_tenant_key: tenantKey, p_norm: norm, p_limit: CANDIDATE_LIMIT }).abortSignal(signal);
        if (response.error) throw new RetrievalBackendError(CANDIDATES_RPC, response.error.code ?? null);
        return rpcRows(response.data).flatMap((row): Suggestion[] => {
          const raw = stringField(row, 'raw');
          const candidate = stringField(row, 'norm');
          return raw && candidate ? [{ raw, norm: candidate, distance: damerauLevenshtein(norm, candidate) }] : [];
        });
      }),
    );
    signal.throwIfAborted();
    const asked = new Set(forms);
    const best = new Map<string, Suggestion>();
    for (const entry of lists.flat()) {
      if (asked.has(entry.norm)) continue;
      const known = best.get(entry.norm);
      if (!known || entry.distance < known.distance || (entry.distance === known.distance && entry.raw < known.raw)) best.set(entry.norm, entry);
    }
    return [...best.values()]
      .sort((a, b) => a.distance - b.distance || (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0))
      .slice(0, MAX_IDENTIFIER_SUGGESTIONS)
      .map((entry) => entry.raw);
  } catch {
    return [];
  }
}
