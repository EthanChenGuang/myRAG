import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { IDENTIFIER_PATTERN } from '../ids/shapes';
import { normalizeIdentifier } from '../ids/normalize';
import { getIngestDeps } from '../ingest/deps';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import { runPatternInWorker, type WorkerPattern } from './probe-worker';
import {
  IDENTIFIER_PATTERN_LIMITS,
  validateIdentifierPattern,
  type CompiledIdentifierFlags,
  type IdentifierPatternFinding,
  type IdentifierPatternFlags,
} from './validate';

/**
 * Tenant identifier patterns (RET-15, D-29, D-52): storage through the 0858 service-role functions with scopeKey(scope) as the only
 * tenant input, validation and probing before any write, the test operation, and the per-tenant compiled pattern loader that
 * ingestion and retrieval use. Admin patterns run only in the probe worker here; logs carry ids, counts and error names only.
 */

export { IDENTIFIER_PATTERN_LIMITS } from './validate';
export type { IdentifierPatternFinding, IdentifierPatternFindingCode, IdentifierPatternFlags } from './validate';

export const IDENTIFIER_PATTERN_ERROR_CODES = [
  'invalid_identifier_pattern',
  'invalid_argument',
  'sample_too_long',
  'limit_reached',
  'name_exists',
  'pattern_not_found',
  'db_unavailable',
  'backend_error',
  'test_unavailable',
] as const;
export type IdentifierPatternErrorCode = (typeof IDENTIFIER_PATTERN_ERROR_CODES)[number];

/** A refused or failed pattern call. Carries the rpc name, a code and pattern findings only: never the pattern or the sample. */
export class IdentifierPatternError extends Error {
  readonly rpc: string | null;
  readonly code: IdentifierPatternErrorCode;
  readonly sqlState: string | null;
  readonly findings: IdentifierPatternFinding[];
  /** The field an invalid_argument refers to. */
  readonly field: 'name' | 'pattern' | 'flags' | 'sample' | 'id' | null;

  constructor(
    code: IdentifierPatternErrorCode,
    options: { rpc?: string | null; sqlState?: string | null; findings?: IdentifierPatternFinding[]; field?: IdentifierPatternError['field'] } = {},
  ) {
    super(`[Identifier Patterns] ${options.rpc ?? 'call'} refused: ${code}`);
    this.name = 'IdentifierPatternError';
    this.code = code;
    this.rpc = options.rpc ?? null;
    this.sqlState = options.sqlState ?? null;
    this.findings = options.findings ?? [];
    this.field = options.field ?? null;
  }
}

export interface IdentifierPatternRow {
  id: string;
  name: string;
  pattern: string;
  flags: IdentifierPatternFlags;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CreateIdentifierPatternInput {
  name: string;
  pattern: string;
  flags: string;
  enabled?: boolean;
  /** The admin user id from the route's admin guard. */
  createdBy?: string | null;
}

export interface UpdateIdentifierPatternInput {
  name?: string;
  pattern?: string;
  flags?: string;
  enabled?: boolean;
}

export interface IdentifierPatternDraft {
  /** When set, the draft replaces that saved pattern in the test. */
  id?: string;
  pattern: string;
  flags: string;
}

export type IdentifierMatchSource = 'built_in' | 'draft' | string;

export interface IdentifierTestMatch {
  raw: string;
  normalized: string;
  /** `built_in`, `draft` or a saved pattern id. */
  source: IdentifierMatchSource;
  /** UTF-16 offsets into the sample as received. */
  start: number;
  end: number;
}

export interface IdentifierTestResult {
  matches: IdentifierTestMatch[];
  tested: { patternIds: string[] };
  truncated: boolean;
  total: number;
}

export interface TenantIdentifierPatterns {
  /** Compiled with `gu` or `giu`, in creation order; pass them as extraPatterns. */
  expressions: readonly RegExp[];
  patternIds: readonly string[];
  /** True when the tenant's patterns could not be loaded; callers continue with the built-in rule only. */
  loadFailed: boolean;
}

export interface IdentifierPatternCallOptions {
  signal: AbortSignal;
}

const LOG = '[Identifier Patterns]';
const PROBE_RUN_LENGTH = 10_000;
const PROBE_LIMIT_MS = 50;
const PROBE_DEADLINE_MS = 1_000;
const TEST_DEADLINE_MS = 2_000;
const BASE_PROBE_CHARS = ['A', 'a', '0', '-', ' '];
const CACHE_TTL_MS = 60_000;
const FAILURE_TTL_MS = 5_000;
const CACHE_MAX_TENANTS = 256;
const SQL_CODE_WORDS = new Set<IdentifierPatternErrorCode>(['limit_reached', 'name_exists', 'pattern_not_found']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;

function tenantKeyOf(scope: TenantScope): string {
  assertTenantScope(scope);
  return scopeKey(scope).toLowerCase();
}

function db(rpc: string): RpcClient {
  const client = getIngestDeps().db();
  if (!client) throw new IdentifierPatternError('db_unavailable', { rpc });
  return client;
}

async function callRpc(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Row[]> {
  const client = db(rpc);
  signal.throwIfAborted();
  const response = await client.rpc(rpc, args).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) {
    const word = /^[a-z_]+/.exec(response.error.message ?? '')?.[0] as IdentifierPatternErrorCode | undefined;
    const sqlState = response.error.code ?? null;
    if (word !== undefined && SQL_CODE_WORDS.has(word)) throw new IdentifierPatternError(word, { rpc, sqlState });
    if (sqlState === '22023') throw new IdentifierPatternError('invalid_argument', { rpc, sqlState });
    throw new IdentifierPatternError('backend_error', { rpc, sqlState });
  }
  return rpcRows(response.data) as Row[];
}

function parseRow(row: Row): IdentifierPatternRow | null {
  const { id, name, pattern, flags, enabled } = row;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof pattern !== 'string' || (flags !== 'u' && flags !== 'iu') || typeof enabled !== 'boolean') {
    return null;
  }
  return {
    id,
    name,
    pattern,
    flags,
    enabled,
    createdAt: typeof row.created_at === 'string' ? row.created_at : null,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  };
}

function rowsOf(rows: Row[]): IdentifierPatternRow[] {
  const out: IdentifierPatternRow[] = [];
  for (const row of rows) {
    const parsed = parseRow(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

function checkName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 1 || trimmed.length > IDENTIFIER_PATTERN_LIMITS.maxNameLength) throw new IdentifierPatternError('invalid_argument', { field: 'name' });
  return trimmed;
}

function checkId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new IdentifierPatternError('pattern_not_found', { field: 'id' });
  return id;
}

function fillRun(seed: string): string {
  if (seed.length === 0) return '';
  return seed.repeat(Math.ceil(PROBE_RUN_LENGTH / seed.length)).slice(0, PROBE_RUN_LENGTH);
}

/**
 * Static checks, then the probe in the worker: runs of 10000 characters of each class the pattern names (plus letters, digits and
 * separators), a mixed run of witness strings, and the witnesses alone. Over 50 ms measured inside the worker, or killed at the outer
 * deadline: probe_too_slow. No match with a letter or digit: no_alphanumeric.
 */
export async function checkIdentifierPattern(
  pattern: string,
  flags: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ ok: true; compiledFlags: CompiledIdentifierFlags; storedFlags: IdentifierPatternFlags } | { ok: false; findings: IdentifierPatternFinding[] }> {
  const validation = validateIdentifierPattern(pattern, flags);
  if (!validation.ok) return validation;
  const chars = [...new Set([...validation.probeChars, ...BASE_PROBE_CHARS])];
  const mixedSeed = [...validation.witnesses, chars.join('')].join(' ') + ' ';
  const inputs = [...chars.map(fillRun), fillRun(mixedSeed), ...validation.witnesses];
  const result = await runPatternInWorker(
    { patterns: [{ id: 'probe', source: pattern, flags: validation.flags }], inputs, maxSpans: 1 },
    { deadlineMs: PROBE_DEADLINE_MS, signal: options.signal },
  );
  if (result.kind === 'timeout') return { ok: false, findings: [{ code: 'probe_too_slow' }] };
  if (result.kind === 'error') {
    if (result.error === 'aborted') options.signal?.throwIfAborted();
    if (result.error === 'invalid_regex') return { ok: false, findings: [{ code: 'invalid_regex' }] };
    return { ok: false, findings: [{ code: 'probe_too_slow' }] };
  }
  if (result.elapsedMs > PROBE_LIMIT_MS) return { ok: false, findings: [{ code: 'probe_too_slow' }] };
  if (!result.alphanumeric.probe) return { ok: false, findings: [{ code: 'no_alphanumeric' }] };
  return { ok: true, compiledFlags: validation.flags, storedFlags: validation.storedFlags };
}

async function requireAcceptedPattern(pattern: string, flags: string, signal: AbortSignal): Promise<IdentifierPatternFlags> {
  const checked = await checkIdentifierPattern(pattern, flags, { signal });
  if (!checked.ok) throw new IdentifierPatternError('invalid_identifier_pattern', { findings: checked.findings, field: 'pattern' });
  return checked.storedFlags;
}

// --- Per-tenant compiled pattern cache -----------------------------------------------------------------------------------------------

interface CacheEntry {
  value: TenantIdentifierPatterns;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const generations = new Map<string, number>();

function invalidate(tenantKey: string): void {
  cache.delete(tenantKey);
  generations.set(tenantKey, (generations.get(tenantKey) ?? 0) + 1);
}

function store(tenantKey: string, entry: CacheEntry): void {
  cache.delete(tenantKey);
  cache.set(tenantKey, entry);
  while (cache.size > CACHE_MAX_TENANTS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function resetIdentifierPatternCacheForTests(): void {
  cache.clear();
  generations.clear();
}

const EMPTY_FAILED: TenantIdentifierPatterns = Object.freeze({ expressions: Object.freeze([]), patternIds: Object.freeze([]), loadFailed: true });

/**
 * The tenant's enabled patterns, compiled, from a least-recently-used map keyed by the tenant key (256 tenants, 60 s). A load failure
 * answers an empty list with loadFailed set, so ingestion and retrieval continue with the built-in rule. A stored row that no longer
 * passes the static checks is skipped.
 */
export async function loadTenantIdentifierPatterns(scope: TenantScope, options: Partial<IdentifierPatternCallOptions> = {}): Promise<TenantIdentifierPatterns> {
  const tenantKey = tenantKeyOf(scope);
  const now = getIngestDeps().now();
  const hit = cache.get(tenantKey);
  if (hit && hit.expiresAt > now) {
    cache.delete(tenantKey);
    cache.set(tenantKey, hit);
    return hit.value;
  }
  const generation = generations.get(tenantKey) ?? 0;
  let value: TenantIdentifierPatterns;
  let ttl = CACHE_TTL_MS;
  try {
    const rows = rowsOf(await callRpc('rag_identifier_patterns_list', { p_tenant_key: tenantKey }, options.signal ?? new AbortController().signal));
    const expressions: RegExp[] = [];
    const patternIds: string[] = [];
    let skipped = 0;
    for (const row of rows) {
      if (!row.enabled) continue;
      const validation = validateIdentifierPattern(row.pattern, row.flags);
      if (!validation.ok) {
        skipped += 1;
        continue;
      }
      expressions.push(new RegExp(row.pattern, validation.flags));
      patternIds.push(row.id);
    }
    if (skipped > 0) console.warn(`${LOG} skipped stored patterns that fail validation`, { count: skipped });
    value = Object.freeze({ expressions: Object.freeze(expressions), patternIds: Object.freeze(patternIds), loadFailed: false });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const e = error as Partial<IdentifierPatternError>;
    console.warn(`${LOG} load failed; built-in rule only`, { code: e.code ?? 'unknown', sqlState: e.sqlState ?? null });
    value = EMPTY_FAILED;
    ttl = FAILURE_TTL_MS;
  }
  if ((generations.get(tenantKey) ?? 0) === generation) store(tenantKey, { value, expiresAt: now + ttl });
  return value;
}

// --- Admin operations ----------------------------------------------------------------------------------------------------------------

/** Every pattern of the caller's tenant in creation order. */
export async function listIdentifierPatterns(scope: TenantScope, options: IdentifierPatternCallOptions): Promise<IdentifierPatternRow[]> {
  const tenantKey = tenantKeyOf(scope);
  return rowsOf(await callRpc('rag_identifier_patterns_list', { p_tenant_key: tenantKey }, options.signal));
}

/** Validates and probes the pattern, then stores it. Only a route that passed the admin guard may call this. */
export async function createIdentifierPattern(
  scope: TenantScope,
  input: CreateIdentifierPatternInput,
  options: IdentifierPatternCallOptions,
): Promise<IdentifierPatternRow> {
  const tenantKey = tenantKeyOf(scope);
  const name = checkName(input.name);
  const flags = await requireAcceptedPattern(input.pattern, input.flags, options.signal);
  const rows = rowsOf(
    await callRpc(
      'rag_identifier_pattern_create',
      {
        p_tenant_key: tenantKey,
        p_name: name,
        p_pattern: input.pattern,
        p_flags: flags,
        p_enabled: input.enabled ?? true,
        p_created_by: input.createdBy ?? null,
      },
      options.signal,
    ),
  );
  invalidate(tenantKey);
  const row = rows[0];
  if (!row) throw new IdentifierPatternError('backend_error', { rpc: 'rag_identifier_pattern_create' });
  console.info(`${LOG} created`, { id: row.id });
  return row;
}

/** Changes only the given fields. A new pattern or new flags are validated and probed together with the stored counterpart. */
export async function updateIdentifierPattern(
  scope: TenantScope,
  id: string,
  input: UpdateIdentifierPatternInput,
  options: IdentifierPatternCallOptions,
): Promise<IdentifierPatternRow> {
  const tenantKey = tenantKeyOf(scope);
  const patternId = checkId(id);
  const name = input.name === undefined ? null : checkName(input.name);
  let flags: IdentifierPatternFlags | null = null;
  if (input.pattern !== undefined || input.flags !== undefined) {
    let pattern = input.pattern;
    let rawFlags = input.flags;
    if (pattern === undefined || rawFlags === undefined) {
      const current = (await listIdentifierPatterns(scope, options)).find((row) => row.id === patternId);
      if (!current) throw new IdentifierPatternError('pattern_not_found', { rpc: 'rag_identifier_patterns_list' });
      pattern ??= current.pattern;
      rawFlags ??= current.flags;
    }
    flags = await requireAcceptedPattern(pattern, rawFlags, options.signal);
  }
  const rows = rowsOf(
    await callRpc(
      'rag_identifier_pattern_update',
      {
        p_tenant_key: tenantKey,
        p_id: patternId,
        p_name: name,
        p_pattern: input.pattern ?? null,
        p_flags: flags,
        p_enabled: input.enabled ?? null,
      },
      options.signal,
    ),
  );
  invalidate(tenantKey);
  const row = rows[0];
  if (!row) throw new IdentifierPatternError('pattern_not_found', { rpc: 'rag_identifier_pattern_update' });
  console.info(`${LOG} updated`, { id: row.id });
  return row;
}

export async function deleteIdentifierPattern(scope: TenantScope, id: string, options: IdentifierPatternCallOptions): Promise<void> {
  const tenantKey = tenantKeyOf(scope);
  const patternId = checkId(id);
  await callRpc('rag_identifier_pattern_delete', { p_tenant_key: tenantKey, p_id: patternId }, options.signal);
  invalidate(tenantKey);
  console.info(`${LOG} deleted`, { id: patternId });
}

interface Candidate {
  start: number;
  end: number;
  source: IdentifierMatchSource;
  /** Lower wins a tie: built-in 0, saved patterns in order, the draft last. */
  rank: number;
}

/**
 * Matches of an admin-supplied sample (at most 10000 characters): the built-in rule, the tenant's enabled patterns and the draft
 * (replacing its saved version when it has an id), merged leftmost-longest. Tenant and draft patterns run in the worker. The sample is
 * neither stored nor logged, and every returned match is a slice of it.
 */
export async function testIdentifierPatterns(
  scope: TenantScope,
  sample: string,
  draft: IdentifierPatternDraft | null | undefined,
  options: IdentifierPatternCallOptions,
): Promise<IdentifierTestResult> {
  tenantKeyOf(scope);
  if (typeof sample !== 'string') throw new IdentifierPatternError('invalid_argument', { field: 'sample' });
  if (sample.length > IDENTIFIER_PATTERN_LIMITS.maxSampleLength) throw new IdentifierPatternError('sample_too_long', { field: 'sample' });

  let draftPattern: WorkerPattern | null = null;
  if (draft) {
    const checked = await checkIdentifierPattern(draft.pattern, draft.flags, { signal: options.signal });
    if (!checked.ok) throw new IdentifierPatternError('invalid_identifier_pattern', { findings: checked.findings, field: 'pattern' });
    draftPattern = { id: 'draft', source: draft.pattern, flags: checked.compiledFlags };
  }

  const saved = (await listIdentifierPatterns(scope, options)).filter((row) => row.enabled && row.id !== draft?.id);
  const workerPatterns: WorkerPattern[] = [];
  for (const row of saved) {
    const validation = validateIdentifierPattern(row.pattern, row.flags);
    if (validation.ok) workerPatterns.push({ id: row.id, source: row.pattern, flags: validation.flags });
  }
  if (draftPattern) workerPatterns.push(draftPattern);

  const candidates: Candidate[] = [];
  for (const match of sample.matchAll(IDENTIFIER_PATTERN)) {
    if (match[0].length === 0) continue;
    const start = match.index ?? 0;
    candidates.push({ start, end: start + match[0].length, source: 'built_in', rank: 0 });
  }
  if (workerPatterns.length > 0 && sample.length > 0) {
    const result = await runPatternInWorker({ patterns: workerPatterns, inputs: [sample], maxSpans: 5000 }, { deadlineMs: TEST_DEADLINE_MS, signal: options.signal });
    if (result.kind !== 'ok') {
      if (result.kind === 'error' && result.error === 'aborted') options.signal.throwIfAborted();
      console.warn(`${LOG} test run failed`, { result: result.kind, patterns: workerPatterns.length });
      throw new IdentifierPatternError('test_unavailable');
    }
    const rankOf = new Map(workerPatterns.map((p, index) => [p.id, index + 1]));
    for (const span of result.spans) {
      if (span.start < 0 || span.end > sample.length || span.end <= span.start) continue;
      candidates.push({ start: span.start, end: span.end, source: span.patternId, rank: rankOf.get(span.patternId) ?? workerPatterns.length + 1 });
    }
  }

  candidates.sort((a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank);
  const merged: IdentifierTestMatch[] = [];
  let last = 0;
  let total = 0;
  for (const candidate of candidates) {
    if (candidate.start < last) continue;
    last = candidate.end;
    total += 1;
    if (merged.length >= IDENTIFIER_PATTERN_LIMITS.maxMatches) continue;
    const raw = sample.slice(candidate.start, candidate.end);
    merged.push({ raw, normalized: normalizeIdentifier(raw), source: candidate.source, start: candidate.start, end: candidate.end });
  }
  return {
    matches: merged,
    tested: { patternIds: workerPatterns.filter((p) => p.id !== 'draft').map((p) => p.id) },
    truncated: total > merged.length,
    total,
  };
}
