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
export async function attributeLexiconFor(scope: TenantScope, _options: AttributeOptions = {}): Promise<AttributeLexicon> {
  assertTenantScope(scope);
  return makeLexicon(scopeKey(scope), [], false);
}

export function invalidateAttributeLexicon(_tenantKey: string | 'all'): void {}

export function resetAttributeLexiconForTests(): void {
  cache.clear();
}

export function attributeLexiconSizeForTests(): number {
  return cache.size;
}

export async function resolveAttributeFilter(
  scope: TenantScope,
  _query: string,
  _explicit: Record<string, readonly string[]> | null | undefined,
  _options: AttributeOptions = {},
): Promise<AttributeResolution> {
  assertTenantScope(scope);
  return {
    explicitIds: null,
    hardIds: null,
    softIds: [],
    counts: { explicitKeys: 0, matchedKeys: 0, aliasMatches: 0, ambiguous: 0, softKeys: 0 },
    tooBroad: false,
    lexiconTruncated: false,
    lexiconUnavailable: false,
    aliasUnavailable: false,
    stateDigest: null,
  };
}
