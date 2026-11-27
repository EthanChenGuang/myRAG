import crypto from 'node:crypto';
import type { AttributeFilterConfig } from '@/lib/rag-eval/contracts.generated';
import { RetrievalBackendError, rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import { lexicalRegistryRules, normalizeLexical } from '../lexical/tokenize';
import { terminologyParams } from '../terminology/expand';
import { terminologyMatcherFor } from '../terminology/load';
import { buildMatcher, termKey, type TermEntry, type TerminologyMatcher } from '../terminology/matcher';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import { ATTRIBUTE_LEXICON_ROW_CAP, attributeFilterConfig } from './attribute-filter-config';

export type AttributeType = 'text' | 'text_list' | 'code';

/** One filterable (key, value) a current, ready document of the tenant carries (rag_attribute_filter_values). */
export interface AttributeLexiconValue {
  key: string;
  value: string;
  type: AttributeType;
  soft: boolean;
}

export interface AttributeLexicon {
  tenantKey: string;
  values: readonly AttributeLexiconValue[];
  /** More rows than the cap: automatic matching is off for this tenant (D-29). */
  truncated: boolean;
  keys: ReadonlySet<string>;
  matcher(minHanChars: number): TerminologyMatcher;
}

/** D-29, D-30: the resolved state the attribute stage applies. Ids are ascending; no field carries a value or the query. */
export interface AttributeResolution {
  /** Documents of the explicit filter; null without one, or when it is too broad. */
  explicitIds: string[] | null;
  /** The first id-cap documents of an explicit filter that is too broad; null otherwise. The stage still narrows to them (D-29). */
  explicitCappedIds: string[] | null;
  /** Documents of the automatic matches on attributes not flagged soft; null when there are none or they are too broad. */
  hardIds: string[] | null;
  /** Documents of soft attributes, ambiguous values and too-broad sets (at most the id cap). */
  softIds: string[];
  counts: { explicitKeys: number; matchedKeys: number; aliasMatches: number; ambiguous: number; softKeys: number };
  tooBroad: boolean;
  lexiconTruncated: boolean;
  lexiconUnavailable: boolean;
  aliasUnavailable: boolean;
  /** SHA-256 hex over the canonical resolved state; null when nothing was named and nothing explicit was given. */
  stateDigest: string | null;
}

export type AttributeFilterErrorCode = 'unknown_attribute';

/** An explicit attributes filter the request may not use; routes answer `status` with `{ success: false, error: code, details }`. */
export class AttributeFilterError extends Error {
  readonly code: AttributeFilterErrorCode;
  readonly status: number;
  readonly details: { path: string; message: string }[];

  constructor(code: AttributeFilterErrorCode, status: number, message: string, details: { path: string; message: string }[] = []) {
    super(message);
    this.name = 'AttributeFilterError';
    this.code = code;
    this.status = status;
    this.details = details.length > 0 ? details : [{ path: 'attributes', message }];
  }
}

type TerminologyLoader = typeof terminologyMatcherFor;

export interface AttributeOptions {
  signal?: AbortSignal;
  /** Tests: the service-role client, the clock, the config numbers and the terminology loader. */
  client?: RpcClient;
  now?: () => number;
  config?: AttributeFilterConfig;
  /** The effective RAG_TERMINOLOGY switch; read from the RAG config when omitted. */
  terminology?: boolean;
  terminologyLoader?: TerminologyLoader;
  minHanChars?: number;
}

export const ATTRIBUTE_LEXICON_CACHE_MAX = 256;
export const ATTRIBUTE_LEXICON_TTL_MS = 60_000;
export const ATTRIBUTE_LEXICON_FAILURE_TTL_MS = 10_000;

const VALUES_RPC = 'rag_attribute_filter_values';
const DOCUMENTS_RPC = 'rag_attribute_documents';
const WORD_CHAR = /[\p{L}\p{N}]/gu;

interface CacheEntry {
  loadedAt: number;
  lexicon: AttributeLexicon | null;
}

const cache = new Map<string, CacheEntry>();

function serviceClient(options: AttributeOptions): RpcClient {
  if (options.client) return options.client;
  const admin = getRagDeps().adminClient() as unknown as RpcClient | null;
  if (!admin) throw new RetrievalBackendError(VALUES_RPC, 'admin_client_unavailable');
  return admin;
}

function toValue(raw: unknown): AttributeLexiconValue | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.key !== 'string' || typeof row.value !== 'string') return null;
  const type = row.type === 'code' || row.type === 'text_list' || row.type === 'text' ? row.type : null;
  if (!type) return null;
  return { key: row.key, value: row.value, type, soft: row.soft === true };
}

const STOPWORDS = (() => {
  const rules = lexicalRegistryRules();
  return new Set<string>([...rules.stopwords, ...rules.hanStopwords]);
})();

/** D-29: values the automatic matcher never uses: fewer than two letters or digits, or a lexical stop word. */
function automaticallyMatchable(value: string): boolean {
  if ((value.match(WORD_CHAR)?.length ?? 0) < 2) return false;
  const normalized = normalizeLexical(value).trim();
  return !STOPWORDS.has(normalized);
}

function makeLexicon(tenantKey: string, values: AttributeLexiconValue[], truncated: boolean): AttributeLexicon {
  const matchers = new Map<number, TerminologyMatcher>();
  const entries: TermEntry[] = [];
  values.forEach((item, index) => {
    if (!automaticallyMatchable(item.value)) return;
    entries.push({
      entryId: String(index),
      layer: 'workspace',
      canonical: item.value,
      variants: [item.value],
      normalizedVariants: [normalizeLexical(item.value)],
      language: 'und',
      kind: item.type === 'code' ? 'identifier' : 'alias',
      mode: 'one_way',
      sourceLanguage: null,
      targetLanguage: null,
    });
  });
  return {
    tenantKey,
    values,
    truncated,
    keys: new Set(values.map((item) => item.key)),
    matcher(minHanChars: number): TerminologyMatcher {
      let matcher = matchers.get(minHanChars);
      if (!matcher) {
        matcher = buildMatcher(truncated ? [] : entries, { minHanChars });
        matchers.set(minHanChars, matcher);
      }
      return matcher;
    },
  };
}

async function fetchLexicon(tenantKey: string, options: AttributeOptions): Promise<AttributeLexicon> {
  let request = serviceClient(options).rpc(VALUES_RPC, { p_tenant_key: tenantKey, p_limit: ATTRIBUTE_LEXICON_ROW_CAP + 1 });
  if (options.signal) request = request.abortSignal(options.signal);
  const { data, error } = await request;
  if (error) throw new RetrievalBackendError(VALUES_RPC, error.code ?? null);
  const values = rpcRows(data)
    .map(toValue)
    .filter((item): item is AttributeLexiconValue => item !== null);
  const truncated = values.length > ATTRIBUTE_LEXICON_ROW_CAP;
  return makeLexicon(tenantKey, truncated ? values.slice(0, ATTRIBUTE_LEXICON_ROW_CAP) : values, truncated);
}

function cached(tenantKey: string, now: number): CacheEntry | null {
  const entry = cache.get(tenantKey);
  if (!entry) return null;
  const ttl = entry.lexicon ? ATTRIBUTE_LEXICON_TTL_MS : ATTRIBUTE_LEXICON_FAILURE_TTL_MS;
  if (now - entry.loadedAt >= ttl) {
    cache.delete(tenantKey);
    return null;
  }
  cache.delete(tenantKey);
  cache.set(tenantKey, entry);
  return entry;
}

function store(tenantKey: string, entry: CacheEntry): void {
  cache.delete(tenantKey);
  cache.set(tenantKey, entry);
  while (cache.size > ATTRIBUTE_LEXICON_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * The scope's filterable values and their matcher, cached per tenant key: 256 tenants, 60 s, 10 s after a failed load (D-29). The only tenant
 * input is the minted scope; its key is both the RPC argument and the cache key. A failed load throws (RetrievalBackendError, code only).
 */
export async function attributeLexiconFor(scope: TenantScope, options: AttributeOptions = {}): Promise<AttributeLexicon> {
  assertTenantScope(scope);
  const tenantKey = scopeKey(scope);
  const now = (options.now ?? getRagDeps().now)();
  const hit = cached(tenantKey, now);
  if (hit) {
    if (hit.lexicon) return hit.lexicon;
    throw new RetrievalBackendError(VALUES_RPC, 'cached_failure');
  }
  try {
    const lexicon = await fetchLexicon(tenantKey, options);
    store(tenantKey, { loadedAt: now, lexicon });
    return lexicon;
  } catch (error) {
    if (!options.signal?.aborted) store(tenantKey, { loadedAt: now, lexicon: null });
    throw error;
  }
}

/** Drops one tenant key's lexicon, or every lexicon; writers of attribute values or definitions call it. */
export function invalidateAttributeLexicon(tenantKey: string | 'all'): void {
  if (tenantKey === 'all') cache.clear();
  else cache.delete(tenantKey);
}

export function resetAttributeLexiconForTests(): void {
  cache.clear();
}

export function attributeLexiconSizeForTests(): number {
  return cache.size;
}

type ValueSets = Map<string, Set<string>>;

function addValue(target: ValueSets, key: string, value: string): boolean {
  let set = target.get(key);
  if (!set) {
    set = new Set();
    target.set(key, set);
  }
  if (set.has(value)) return false;
  set.add(value);
  return true;
}

function canonical(sets: ValueSets): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of [...sets.keys()].sort()) out[key] = [...sets.get(key)!].sort();
  return out;
}

function normalizeExplicit(explicit: Record<string, readonly string[]> | null | undefined): ValueSets {
  const sets: ValueSets = new Map();
  if (!explicit) return sets;
  for (const [key, values] of Object.entries(explicit)) {
    for (const value of values ?? []) addValue(sets, key, value);
    if (sets.get(key)?.size === 0) sets.delete(key);
  }
  return sets;
}

function unknownAttribute(explicit: ValueSets, lexicon: AttributeLexicon | null): AttributeFilterError {
  const keys = [...explicit.keys()].sort();
  const suspects = lexicon ? keys.filter((key) => !lexicon.keys.has(key)) : [];
  const details = suspects.map((key) => ({ path: `attributes.${key}`, message: 'unknown_attribute' }));
  return new AttributeFilterError('unknown_attribute', 400, 'an attribute key is not a filterable attribute', details);
}

interface DocumentsCall {
  ids: string[];
  tooBroad: boolean;
}

async function documentsFor(
  scope: TenantScope,
  filters: Record<string, string[]>,
  idCap: number,
  options: AttributeOptions,
  onUnknown: () => AttributeFilterError,
): Promise<DocumentsCall> {
  options.signal?.throwIfAborted();
  let request = serviceClient(options).rpc(DOCUMENTS_RPC, { p_tenant_key: scopeKey(scope), p_filters: filters, p_limit: idCap + 1 });
  if (options.signal) request = request.abortSignal(options.signal);
  const { data, error } = await request;
  options.signal?.throwIfAborted();
  if (error) {
    if (typeof error.message === 'string' && error.message.startsWith('unknown_attribute')) throw onUnknown();
    throw new RetrievalBackendError(DOCUMENTS_RPC, error.code ?? null);
  }
  const ids = rpcRows(data)
    .map((row) => (typeof row === 'object' && row !== null ? (row as Record<string, unknown>).document_id : null))
    .filter((id): id is string => typeof id === 'string')
    .sort();
  if (ids.length > idCap) return { ids: ids.slice(0, idCap), tooBroad: true };
  return { ids, tooBroad: false };
}

function digest(state: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function terminologyOn(options: AttributeOptions): boolean {
  if (options.terminology !== undefined) return options.terminology;
  return loadRagConfig(getRagDeps().ragEnv()).v2.terminology;
}

interface Matched {
  hard: ValueSets;
  soft: ValueSets;
  /** Ambiguous values: the keys each one is stored under. */
  ambiguous: Map<string, Set<string>>;
  aliasMatches: number;
  aliasUnavailable: boolean;
}

/** D-01, F-17: values found in the query by the shared matcher, aliases mapped through the tenant's TERM dictionary. */
async function automaticMatches(scope: TenantScope, query: string, lexicon: AttributeLexicon, skip: ReadonlySet<string>, options: AttributeOptions): Promise<Matched> {
  const minHanChars = options.minHanChars ?? terminologyParams().min_han_chars;
  const keysByValue = new Map<string, Set<string>>();
  for (const item of lexicon.values) addValue(keysByValue, item.value, item.key);
  const byTermKey = new Map<string, AttributeLexiconValue[]>();
  for (const item of lexicon.values) {
    if (!automaticallyMatchable(item.value)) continue;
    const forms = new Set([termKey(item.value), ...(item.type === 'code' ? [termKey(item.value, true)] : [])]);
    for (const form of forms) {
      if (!form) continue;
      const list = byTermKey.get(form);
      if (list) list.push(item);
      else byTermKey.set(form, [item]);
    }
  }

  const found = new Map<string, AttributeLexiconValue>();
  const foundKey = (item: AttributeLexiconValue) => `${item.key}\u0000${item.value}`;
  for (const match of lexicon.matcher(minHanChars).match(query)) {
    const item = lexicon.values[Number(match.entry.entryId)];
    if (item) found.set(foundKey(item), item);
  }

  let aliasMatches = 0;
  let aliasUnavailable = false;
  if (!lexicon.truncated && byTermKey.size > 0 && terminologyOn(options)) {
    try {
      const loader = options.terminologyLoader ?? terminologyMatcherFor;
      const { matcher } = await loader(scope, { minHanChars, signal: options.signal });
      for (const match of matcher.match(query)) {
        const forms = new Set([termKey(match.entry.canonical), termKey(match.entry.canonical, true)]);
        for (const form of forms) {
          for (const item of byTermKey.get(form) ?? []) {
            if (found.has(foundKey(item))) continue;
            found.set(foundKey(item), item);
            aliasMatches += 1;
          }
        }
      }
    } catch {
      if (options.signal?.aborted) throw options.signal.reason;
      aliasUnavailable = true;
    }
  }

  const matched: Matched = { hard: new Map(), soft: new Map(), ambiguous: new Map(), aliasMatches, aliasUnavailable };
  for (const item of found.values()) {
    if (skip.has(item.key)) continue;
    const keys = [...(keysByValue.get(item.value) ?? [])].filter((key) => !skip.has(key));
    if (keys.length > 1) {
      matched.ambiguous.set(item.value, new Set(keys));
      continue;
    }
    addValue(item.soft ? matched.soft : matched.hard, item.key, item.value);
  }
  return matched;
}

/**
 * D-29, D-30: turns the standalone query and an explicit attributes filter into document id lists of the scope's tenant. A key of the explicit
 * filter is not resolved automatically; the explicit filter is resolved even when the lexicon cannot be loaded or is truncated. A set above the
 * id cap of config/rag/attribute-filter.json is never a hard list: it is too broad and its first ids go to softIds. Nothing named and nothing
 * explicit costs no document call. Logs and errors carry codes and counts only.
 */
export async function resolveAttributeFilter(
  scope: TenantScope,
  query: string,
  explicit: Record<string, readonly string[]> | null | undefined,
  options: AttributeOptions = {},
): Promise<AttributeResolution> {
  assertTenantScope(scope);
  const config = options.config ?? attributeFilterConfig();
  const idCap = config.id_cap;
  const explicitSets = normalizeExplicit(explicit);

  let lexicon: AttributeLexicon | null = null;
  let lexiconUnavailable = false;
  try {
    lexicon = await attributeLexiconFor(scope, options);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (!(error instanceof RetrievalBackendError)) throw error;
    lexiconUnavailable = true;
    console.warn('[Document Search] attribute lexicon unavailable:', { code: error.code });
  }

  const matched: Matched =
    lexicon && !lexicon.truncated
      ? await automaticMatches(scope, query, lexicon, new Set(explicitSets.keys()), options)
      : { hard: new Map(), soft: new Map(), ambiguous: new Map(), aliasMatches: 0, aliasUnavailable: false };

  const counts = {
    explicitKeys: explicitSets.size,
    matchedKeys: new Set([...matched.hard.keys(), ...matched.soft.keys()]).size,
    aliasMatches: matched.aliasMatches,
    ambiguous: matched.ambiguous.size,
    softKeys: matched.soft.size,
  };
  const base = {
    lexiconTruncated: lexicon?.truncated ?? false,
    lexiconUnavailable,
    aliasUnavailable: matched.aliasUnavailable,
  };

  if (explicitSets.size === 0 && matched.hard.size === 0 && matched.soft.size === 0 && matched.ambiguous.size === 0) {
    return { explicitIds: null, explicitCappedIds: null, hardIds: null, softIds: [], counts, tooBroad: false, ...base, stateDigest: null };
  }

  const onUnknown = () => unknownAttribute(explicitSets, lexicon);
  let tooBroad = false;
  const soft = new Set<string>();

  let explicitIds: string[] | null = null;
  let explicitCappedIds: string[] | null = null;
  if (explicitSets.size > 0) {
    const call = await documentsFor(scope, canonical(explicitSets), idCap, options, onUnknown);
    if (call.tooBroad) {
      tooBroad = true;
      explicitCappedIds = call.ids;
      call.ids.forEach((id) => soft.add(id));
    } else explicitIds = call.ids;
  }

  let hardIds: string[] | null = null;
  if (matched.hard.size > 0) {
    const call = await documentsFor(scope, canonical(matched.hard), idCap, options, onUnknown);
    if (call.tooBroad) {
      tooBroad = true;
      call.ids.forEach((id) => soft.add(id));
    } else hardIds = call.ids;
  }

  if (matched.soft.size > 0) {
    const call = await documentsFor(scope, canonical(matched.soft), idCap, options, onUnknown);
    if (call.tooBroad) tooBroad = true;
    call.ids.forEach((id) => soft.add(id));
  }

  for (const value of [...matched.ambiguous.keys()].sort()) {
    for (const key of [...matched.ambiguous.get(value)!].sort()) {
      const call = await documentsFor(scope, { [key]: [value] }, idCap, options, onUnknown);
      if (call.tooBroad) tooBroad = true;
      call.ids.forEach((id) => soft.add(id));
    }
  }

  const softIds = [...soft].sort();
  if (softIds.length > idCap) {
    tooBroad = true;
    softIds.length = idCap;
  }

  const ambiguousState: Record<string, string[]> = {};
  for (const value of [...matched.ambiguous.keys()].sort()) ambiguousState[value] = [...matched.ambiguous.get(value)!].sort();
  const stateDigest = digest({
    explicit: canonical(explicitSets),
    hard: canonical(matched.hard),
    soft: canonical(matched.soft),
    ambiguous: ambiguousState,
    tooBroad,
  });

  return { explicitIds, explicitCappedIds, hardIds, softIds, counts, tooBroad, ...base, stateDigest };
}
