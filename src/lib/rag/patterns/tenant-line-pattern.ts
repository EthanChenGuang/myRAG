import { checkIdentifierPattern } from '../identifiers/patterns';
import {
  IDENTIFIER_PATTERN_FINDING_CODES,
  validateIdentifierPattern,
  type CompiledIdentifierFlags,
  type IdentifierPatternFindingCode,
  type IdentifierPatternFlags,
} from '../identifiers/validate';

/**
 * Tenant line patterns (TPL-08, D-11): heading patterns of section rule sets and boilerplate line patterns. Built only on the
 * 04.2-14 validator, probe and worker; this module adds the heading anchoring rule, drops the punctuation-only refusal and owns
 * the request limits. A tenant pattern is never matched on the calling thread, and nothing here writes a log line.
 */

export const TENANT_LINE_PATTERN_KINDS = ['heading', 'boilerplate_line'] as const;
export type TenantLinePatternKind = (typeof TENANT_LINE_PATTERN_KINDS)[number];

export const TENANT_LINE_PATTERN_LIMITS = Object.freeze({
  maxPatternLength: 200,
});

export type TenantLineFindingCode = Exclude<IdentifierPatternFindingCode, 'no_alphanumeric'> | 'heading_not_anchored';

export const TENANT_LINE_FINDING_CODES: readonly TenantLineFindingCode[] = Object.freeze(
  IDENTIFIER_PATTERN_FINDING_CODES.flatMap((code): TenantLineFindingCode[] => {
    if (code === 'no_alphanumeric') return [];
    if (code === 'probe_too_slow') return ['heading_not_anchored', code];
    return [code];
  }),
);

export interface TenantLineFinding {
  code: TenantLineFindingCode;
}

export type TenantLinePatternValidation =
  | { ok: true; storedFlags: IdentifierPatternFlags; compiledFlags: CompiledIdentifierFlags }
  | { ok: false; findings: TenantLineFinding[] };

function ordered(found: Set<TenantLineFindingCode>): TenantLineFinding[] {
  return TENANT_LINE_FINDING_CODES.filter((code) => found.has(code)).map((code) => ({ code }));
}

/**
 * True when the source begins with a caret and so does every top-level alternative. A character walk over the text: a backslash
 * skips the next code point, a class runs to its unescaped closing bracket, parentheses track depth, a bar at depth zero splits.
 */
function isAnchoredAtLineStart(source: string): boolean {
  let depth = 0;
  let inClass = false;
  let alternativeStart = true;
  let index = 0;
  while (index < source.length) {
    const cp = source.codePointAt(index) ?? 0;
    const ch = String.fromCodePoint(cp);
    if (alternativeStart) {
      if (ch !== '^') return false;
      alternativeStart = false;
      index += 1;
      continue;
    }
    if (ch === '\\') {
      const next = source.codePointAt(index + 1);
      index += 1 + (next === undefined ? 0 : String.fromCodePoint(next).length);
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === '|' && depth === 0) {
      alternativeStart = true;
    }
    index += ch.length;
  }
  return !alternativeStart;
}

/**
 * Synchronous static check, used at save time before the probe and at run time before every match: the 04.2-14 static rules, a
 * 200-character limit held here, and for headings the anchoring rule. Compiles the pattern once (the validator's compile check)
 * and runs no match.
 */
export function validateTenantLinePattern(kind: TenantLinePatternKind, pattern: string, flags: string): TenantLinePatternValidation {
  const source = typeof pattern === 'string' ? pattern : '';
  const found = new Set<TenantLineFindingCode>();
  const needsAnchor = kind !== 'boilerplate_line';
  if (needsAnchor && !isAnchoredAtLineStart(source)) found.add('heading_not_anchored');
  if (source.length > TENANT_LINE_PATTERN_LIMITS.maxPatternLength) {
    found.add('too_long');
    return { ok: false, findings: ordered(found) };
  }
  const validation = validateIdentifierPattern(source, typeof flags === 'string' ? flags : '');
  if (!validation.ok) {
    for (const finding of validation.findings) {
      if (finding.code !== 'no_alphanumeric') found.add(finding.code);
    }
  }
  if (found.size > 0 || !validation.ok) return { ok: false, findings: ordered(found) };
  return { ok: true, storedFlags: validation.storedFlags, compiledFlags: validation.flags };
}

/**
 * Save-time check: the static check, then the 04.2-14 probe in the worker. probe_too_slow and invalid_regex refuse; a sole
 * no_alphanumeric is acceptance, so a boilerplate line may match punctuation only.
 */
export async function checkTenantLinePattern(
  kind: TenantLinePatternKind,
  pattern: string,
  flags: string,
  options: { signal?: AbortSignal } = {},
): Promise<TenantLinePatternValidation> {
  options.signal?.throwIfAborted();
  const validation = validateTenantLinePattern(kind, pattern, flags);
  if (!validation.ok) return validation;
  const probed = await checkIdentifierPattern(pattern, flags, { signal: options.signal });
  options.signal?.throwIfAborted();
  if (probed.ok) return validation;
  const found = new Set<TenantLineFindingCode>();
  for (const finding of probed.findings) {
    if (finding.code !== 'no_alphanumeric') found.add(finding.code);
  }
  if (found.size === 0) return validation;
  return { ok: false, findings: ordered(found) };
}
