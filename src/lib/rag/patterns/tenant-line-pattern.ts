import type { CompiledIdentifierFlags, IdentifierPatternFindingCode, IdentifierPatternFlags } from '../identifiers/validate';

export const TENANT_LINE_PATTERN_KINDS = ['heading', 'boilerplate_line'] as const;
export type TenantLinePatternKind = (typeof TENANT_LINE_PATTERN_KINDS)[number];
export const TENANT_LINE_PATTERN_LIMITS = { maxPatternLength: 0 } as const;
export type TenantLineFindingCode = Exclude<IdentifierPatternFindingCode, 'no_alphanumeric'> | 'heading_not_anchored';
export const TENANT_LINE_FINDING_CODES: readonly TenantLineFindingCode[] = [];
export interface TenantLineFinding {
  code: TenantLineFindingCode;
}
export type TenantLinePatternValidation =
  | { ok: true; storedFlags: IdentifierPatternFlags; compiledFlags: CompiledIdentifierFlags }
  | { ok: false; findings: TenantLineFinding[] };

export function validateTenantLinePattern(_kind: TenantLinePatternKind, _pattern: string, _flags: string): TenantLinePatternValidation {
  return { ok: false, findings: [] };
}

export async function checkTenantLinePattern(
  _kind: TenantLinePatternKind,
  _pattern: string,
  _flags: string,
  _options: { signal?: AbortSignal } = {},
): Promise<TenantLinePatternValidation> {
  return { ok: false, findings: [] };
}
