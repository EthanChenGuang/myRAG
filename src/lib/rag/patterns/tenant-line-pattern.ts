import { checkIdentifierPattern } from '../identifiers/patterns';
import { runPatternInWorker, type WorkerPattern } from '../identifiers/probe-worker';
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

/** Lines are matched within their first 200 UTF-16 code units (one fewer when the cut would split a surrogate pair). */
export const TENANT_LINE_MATCH_WINDOW = 200;
export const TENANT_LINE_DEFAULT_DEADLINE_MS = 3000;

const MIN_DEADLINE_MS = 100;
const MAX_DEADLINE_MS = 30_000;
const MAX_PATTERNS_PER_CALL = 100;
const MAX_LINES_PER_CALL = 20_000;
const MAX_PATTERN_ID_LENGTH = 64;

export interface TenantLinePatternEntry {
  id: string;
  kind: TenantLinePatternKind;
  pattern: string;
  flags: string;
}

export interface TenantLineHit {
  inputIndex: number;
  patternId: string;
  /** UTF-16 offsets into the line. */
  start: number;
  end: number;
}

export type TenantLineMatchError = 'too_many_patterns' | 'too_many_lines' | 'invalid_pattern_id' | 'invalid_regex' | 'worker_failed';

export type TenantLineMatchVerdict =
  | { kind: 'ok'; hits: TenantLineHit[]; skipped: string[] }
  | { kind: 'timeout' }
  | { kind: 'error'; error: TenantLineMatchError };

export interface TenantLineMatchOptions {
  deadlineMs?: number;
  signal?: AbortSignal;
}

function clampDeadline(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TENANT_LINE_DEFAULT_DEADLINE_MS;
  return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, Math.floor(value)));
}

function cutToWindow(line: string): string {
  const text = typeof line === 'string' ? line : '';
  if (text.length <= TENANT_LINE_MATCH_WINDOW) return text;
  const last = text.charCodeAt(TENANT_LINE_MATCH_WINDOW - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? TENANT_LINE_MATCH_WINDOW - 1 : TENANT_LINE_MATCH_WINDOW;
  return text.slice(0, end);
}

function validIds(patterns: readonly TenantLinePatternEntry[]): boolean {
  const seen = new Set<string>();
  for (const entry of patterns) {
    const id = entry?.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PATTERN_ID_LENGTH || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * Run-time match for one document: every entry that passes the static re-check goes to the 04.2-14 worker in one call, with the
 * lines cut to the match window. Reports at most the first hit per line and pattern; callers decide what a hit means.
 */
export async function matchTenantLinePatterns(
  request: { patterns: readonly TenantLinePatternEntry[]; lines: readonly string[] },
  options: TenantLineMatchOptions = {},
): Promise<TenantLineMatchVerdict> {
  options.signal?.throwIfAborted();
  const patterns = Array.isArray(request?.patterns) ? request.patterns : [];
  const lines = Array.isArray(request?.lines) ? request.lines : [];
  if (patterns.length > MAX_PATTERNS_PER_CALL) return { kind: 'error', error: 'too_many_patterns' };
  if (lines.length > MAX_LINES_PER_CALL) return { kind: 'error', error: 'too_many_lines' };
  if (!validIds(patterns)) return { kind: 'error', error: 'invalid_pattern_id' };

  const sent: WorkerPattern[] = [];
  const skipped: string[] = [];
  for (const entry of patterns) {
    const validation = validateTenantLinePattern(entry.kind, entry.pattern, entry.flags);
    if (validation.ok) sent.push({ id: entry.id, source: entry.pattern, flags: validation.compiledFlags });
    else skipped.push(entry.id);
  }
  if (sent.length === 0 || lines.length === 0) return { kind: 'ok', hits: [], skipped };

  const inputs = lines.map(cutToWindow);
  const result = await runPatternInWorker({ patterns: sent, inputs, maxSpans: 1 }, { deadlineMs: clampDeadline(options.deadlineMs), signal: options.signal });
  if (result.kind === 'timeout') return { kind: 'timeout' };
  if (result.kind === 'error') {
    if (result.error === 'aborted') {
      options.signal?.throwIfAborted();
      return { kind: 'error', error: 'worker_failed' };
    }
    return { kind: 'error', error: result.error };
  }

  const order = new Map(sent.map((pattern, index) => [pattern.id, index]));
  const kept = new Map<string, TenantLineHit>();
  for (const span of result.spans) {
    const rank = order.get(span.patternId);
    const input = inputs[span.inputIndex];
    if (rank === undefined || input === undefined) continue;
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > input.length) continue;
    const key = `${span.inputIndex}\u0000${rank}`;
    const previous = kept.get(key);
    if (!previous || span.start < previous.start) {
      kept.set(key, { inputIndex: span.inputIndex, patternId: span.patternId, start: span.start, end: span.end });
    }
  }
  const hits = [...kept.values()].sort((a, b) => a.inputIndex - b.inputIndex || (order.get(a.patternId) ?? 0) - (order.get(b.patternId) ?? 0));
  return { kind: 'ok', hits, skipped };
}
