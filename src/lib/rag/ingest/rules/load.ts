import { createHash } from 'node:crypto';
import { rpcRows, type RpcClient } from '../../backend/supabase-rpc';
import { validateTenantLinePattern } from '../../patterns/tenant-line-pattern';
import { assertTenantScope, scopeKey, type TenantScope } from '../../tenant/scope';
import { canonicalJson } from '@/lib/rag-eval/trace';
import { getIngestDeps } from '../deps';

/**
 * Per-tenant, per-binding rule loader for ingestion (TPL-01, TPL-02, TPL-08; D-11, D-18). One read of rag_tenant_rules_for with
 * scopeKey(scope) as the only tenant input; the rows are kept as plain data in a cache keyed by the tenant key. Patterns are returned as
 * source text and flags and never compiled here: they run only in the worker (tenant-line-pattern). A stored pattern that no longer passes
 * the static check is left out. A load failure answers no rules with loadFailed set, so ingestion continues on the unruled path.
 * Logs carry the rpc name, codes and counts only.
 */

export interface LoadedHeadingPattern {
  pattern: string;
  flags: 'u' | 'iu';
  name: string;
  level: number;
  required: boolean;
  restart: boolean;
}

export interface LoadedSectionRuleSet {
  id: string;
  version: number;
  docType: string | null;
  source: string | null;
  headings: readonly LoadedHeadingPattern[];
  requireIncreasingNumbers: boolean;
  skipToc: boolean;
  tocMinRun: number;
}

export interface LoadedBoilerplateRule {
  id: string;
  version: number;
  kind: 'line' | 'fragment';
  pattern: string | null;
  flags: 'u' | 'iu' | null;
  maxLength: number | null;
  minPageShare: number | null;
  docType: string | null;
  source: string | null;
}

export interface LoadedRuleId {
  kind: 'rule_set' | 'boilerplate_rule';
  id: string;
  version: number;
}

export interface TenantRules {
  /** The one enabled rule set the D-18 precedence chose, or null. */
  ruleSet: LoadedSectionRuleSet | null;
  /** Every enabled boilerplate rule whose binding matches, by precedence then creation. */
  boilerplateRules: readonly LoadedBoilerplateRule[];
  ruleIds: readonly LoadedRuleId[];
  /** SHA-256 (hex) over the canonical JSON of ruleSet and boilerplateRules. */
  fingerprint: string;
  loadFailed: boolean;
  /** Stored rows left out because a pattern no longer passes the static check. */
  skipped: number;
}

export interface TenantRuleBinding {
  docType: string | null;
  source: string | null;
}

export const TENANT_RULE_CACHE = {
  ttlMs: 60_000,
  failureTtlMs: 5_000,
  maxTenants: 256,
  maxBindingsPerTenant: 64,
} as const;

const LOG = '[RAG Rules]';
const RPC = 'rag_tenant_rules_for';
const BINDING = /^[a-z][a-z0-9_-]{0,63}$/;

type Row = Record<string, unknown>;

function validBindingValue(value: string | null): boolean {
  return value === null || BINDING.test(value);
}

function fingerprintOf(ruleSet: LoadedSectionRuleSet | null, boilerplateRules: readonly LoadedBoilerplateRule[]): string {
  return createHash('sha256').update(canonicalJson({ ruleSet, boilerplateRules })).digest('hex');
}

function freeze(ruleSet: LoadedSectionRuleSet | null, boilerplateRules: LoadedBoilerplateRule[], loadFailed: boolean, skipped: number): TenantRules {
  const ruleIds: LoadedRuleId[] = [
    ...(ruleSet ? [{ kind: 'rule_set' as const, id: ruleSet.id, version: ruleSet.version }] : []),
    ...boilerplateRules.map((rule) => ({ kind: 'boilerplate_rule' as const, id: rule.id, version: rule.version })),
  ];
  return Object.freeze({
    ruleSet: ruleSet ? Object.freeze({ ...ruleSet, headings: Object.freeze(ruleSet.headings.map((h) => Object.freeze({ ...h }))) }) : null,
    boilerplateRules: Object.freeze(boilerplateRules.map((rule) => Object.freeze(rule))),
    ruleIds: Object.freeze(ruleIds.map((entry) => Object.freeze(entry))),
    fingerprint: fingerprintOf(ruleSet, boilerplateRules),
    loadFailed,
    skipped,
  });
}

const FAILED: TenantRules = freeze(null, [], true, 0);

class MalformedRow extends Error {
  constructor() {
    super(`${LOG} malformed row`);
    this.name = 'MalformedRow';
  }
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new MalformedRow();
  return value;
}

function int(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new MalformedRow();
  return value;
}

function flagsOf(value: unknown): 'u' | 'iu' {
  if (value !== 'u' && value !== 'iu') throw new MalformedRow();
  return value;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new MalformedRow();
  return value;
}

function headingOf(value: unknown): LoadedHeadingPattern {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new MalformedRow();
  const h = value as Row;
  if (typeof h.pattern !== 'string' || typeof h.name !== 'string') throw new MalformedRow();
  return {
    pattern: h.pattern,
    flags: flagsOf(h.flags ?? 'u'),
    name: h.name,
    level: int(h.level, 1, 6),
    required: bool(h.required, false),
    restart: bool(h.restart, false),
  };
}

function idOf(row: Row): string {
  const id = text(row, 'id');
  if (id === null) throw new MalformedRow();
  return id;
}

function ruleSetOf(row: Row): LoadedSectionRuleSet {
  const rules = row.rules;
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) throw new MalformedRow();
  const r = rules as Row;
  if (!Array.isArray(r.headings) || r.headings.length < 1) throw new MalformedRow();
  return {
    id: idOf(row),
    version: int(row.version, 1, Number.MAX_SAFE_INTEGER),
    docType: text(row, 'doc_type'),
    source: text(row, 'source'),
    headings: r.headings.map(headingOf),
    requireIncreasingNumbers: bool(r.require_increasing_numbers, false),
    skipToc: bool(r.skip_toc, true),
    tocMinRun: r.toc_min_run === undefined ? 3 : int(r.toc_min_run, 2, 20),
  };
}

function boilerplateRuleOf(row: Row): LoadedBoilerplateRule {
  const kind = row.kind;
  if (kind !== 'line' && kind !== 'fragment') throw new MalformedRow();
  const base = { id: idOf(row), version: int(row.version, 1, Number.MAX_SAFE_INTEGER), docType: text(row, 'doc_type'), source: text(row, 'source') };
  if (kind === 'line') {
    const pattern = text(row, 'pattern');
    if (pattern === null) throw new MalformedRow();
    return { ...base, kind, pattern, flags: flagsOf(row.flags), maxLength: null, minPageShare: null };
  }
  const share = row.min_page_share;
  if (typeof share !== 'number' || !(share > 0 && share <= 1)) throw new MalformedRow();
  return { ...base, kind, pattern: null, flags: null, maxLength: int(row.max_length, 1, 200), minPageShare: share };
}

function build(rows: Row[]): TenantRules {
  let ruleSet: LoadedSectionRuleSet | null = null;
  const boilerplateRules: LoadedBoilerplateRule[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (row === null || typeof row !== 'object') throw new MalformedRow();
    if (row.entry === 'rule_set') {
      if (ruleSet !== null) throw new MalformedRow();
      const candidate = ruleSetOf(row);
      if (candidate.headings.every((h) => validateTenantLinePattern('heading', h.pattern, h.flags).ok)) ruleSet = candidate;
      else skipped += 1;
    } else if (row.entry === 'boilerplate_rule') {
      const rule = boilerplateRuleOf(row);
      if (rule.kind === 'line' && !validateTenantLinePattern('boilerplate_line', rule.pattern ?? '', rule.flags ?? '').ok) skipped += 1;
      else boilerplateRules.push(rule);
    } else {
      throw new MalformedRow();
    }
  }
  return freeze(ruleSet, boilerplateRules, false, skipped);
}

// --- Cache ---------------------------------------------------------------------------------------------------------------------------

interface BindingEntry {
  value: TenantRules;
  expiresAt: number;
}

const cache = new Map<string, Map<string, BindingEntry>>();
const generations = new Map<string, number>();

function touchTenant(tenantKey: string): Map<string, BindingEntry> {
  const existing = cache.get(tenantKey);
  const bindings = existing ?? new Map<string, BindingEntry>();
  cache.delete(tenantKey);
  cache.set(tenantKey, bindings);
  while (cache.size > TENANT_RULE_CACHE.maxTenants) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return bindings;
}

function store(tenantKey: string, bindingKey: string, entry: BindingEntry): void {
  const bindings = touchTenant(tenantKey);
  bindings.delete(bindingKey);
  bindings.set(bindingKey, entry);
  while (bindings.size > TENANT_RULE_CACHE.maxBindingsPerTenant) {
    const oldest = bindings.keys().next().value;
    if (oldest === undefined) break;
    bindings.delete(oldest);
  }
}

/** Drops every cached binding of the tenant; a load already in flight for it does not store its result. */
export function invalidateTenantRules(tenantKey: string): void {
  const key = tenantKey.toLowerCase();
  cache.delete(key);
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

export function resetTenantRuleCacheForTests(): void {
  cache.clear();
  generations.clear();
}

/**
 * The rules of one tenant for one document binding. A second call within 60 s answers from the cache without a database call; a failure is
 * cached for 5 s. An aborted signal rethrows.
 */
export async function loadTenantRules(
  scope: TenantScope,
  binding: TenantRuleBinding,
  options: { signal?: AbortSignal } = {},
): Promise<TenantRules> {
  assertTenantScope(scope);
  const tenantKey = scopeKey(scope).toLowerCase();
  const signal = options.signal;
  signal?.throwIfAborted();
  const typeValue = binding.docType ?? null;
  const sourceValue = binding.source ?? null;
  if (!validBindingValue(typeValue) || !validBindingValue(sourceValue)) {
    console.warn(`${LOG} invalid binding; no rules`, { rpc: RPC });
    return FAILED;
  }
  const bindingKey = `${typeValue ?? ''}|${sourceValue ?? ''}`;
  const deps = getIngestDeps();
  const now = deps.now();
  const hit = cache.get(tenantKey)?.get(bindingKey);
  if (hit && hit.expiresAt > now) {
    store(tenantKey, bindingKey, hit);
    return hit.value;
  }

  const generation = generations.get(tenantKey) ?? 0;
  let value: TenantRules;
  let ttl: number = TENANT_RULE_CACHE.ttlMs;
  try {
    const db: RpcClient | null = deps.db();
    if (!db) throw new Error('db_unavailable');
    const request = db.rpc(RPC, { p_tenant_key: tenantKey, p_doc_type: typeValue, p_source: sourceValue });
    const response = await (signal ? request.abortSignal(signal) : request);
    signal?.throwIfAborted();
    if (response.error) {
      console.warn(`${LOG} load failed; no rules`, { rpc: RPC, code: response.error.code ?? null });
      value = FAILED;
      ttl = TENANT_RULE_CACHE.failureTtlMs;
    } else {
      value = build(rpcRows(response.data) as Row[]);
      if (value.skipped > 0) console.warn(`${LOG} skipped stored rules that fail validation`, { rpc: RPC, count: value.skipped });
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn(`${LOG} load failed; no rules`, { rpc: RPC, error: error instanceof Error ? error.name : 'unknown' });
    value = FAILED;
    ttl = TENANT_RULE_CACHE.failureTtlMs;
  }
  if ((generations.get(tenantKey) ?? 0) === generation) store(tenantKey, bindingKey, { value, expiresAt: now + ttl });
  return value;
}
