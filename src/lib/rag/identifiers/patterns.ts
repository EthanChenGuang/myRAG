import type { TenantScope } from '../tenant/scope';
import type { CompiledIdentifierFlags, IdentifierPatternFinding, IdentifierPatternFlags } from './validate';

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

export async function checkIdentifierPattern(
  _pattern: string,
  _flags: string,
  _options: { signal?: AbortSignal } = {},
): Promise<{ ok: true; compiledFlags: CompiledIdentifierFlags; storedFlags: IdentifierPatternFlags } | { ok: false; findings: IdentifierPatternFinding[] }> {
  throw new Error('not implemented');
}
export function resetIdentifierPatternCacheForTests(): void {}

export async function loadTenantIdentifierPatterns(_scope: TenantScope, _options: Partial<IdentifierPatternCallOptions> = {}): Promise<TenantIdentifierPatterns> {
  throw new Error('not implemented');
}
export async function listIdentifierPatterns(_scope: TenantScope, _options: IdentifierPatternCallOptions): Promise<IdentifierPatternRow[]> {
  throw new Error('not implemented');
}
export async function createIdentifierPattern(_scope: TenantScope, _input: CreateIdentifierPatternInput, _options: IdentifierPatternCallOptions): Promise<IdentifierPatternRow> {
  throw new Error('not implemented');
}
export async function updateIdentifierPattern(_scope: TenantScope, _id: string, _input: UpdateIdentifierPatternInput, _options: IdentifierPatternCallOptions): Promise<IdentifierPatternRow> {
  throw new Error('not implemented');
}
export async function deleteIdentifierPattern(_scope: TenantScope, _id: string, _options: IdentifierPatternCallOptions): Promise<void> {
  throw new Error('not implemented');
}
export async function testIdentifierPatterns(
  _scope: TenantScope,
  _sample: string,
  _draft: IdentifierPatternDraft | null | undefined,
  _options: IdentifierPatternCallOptions,
): Promise<IdentifierTestResult> {
  throw new Error('not implemented');
}
