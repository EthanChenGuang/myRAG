/**
 * Static checks for an admin-supplied identifier pattern (D-29, D-52). The pattern is attacker-shaped input: nothing here executes it.
 * The only use of the source as a regular expression is `new RegExp(source, 'u')` for the compile check, which never runs a match.
 */

export const IDENTIFIER_PATTERN_LIMITS = {
  maxPatterns: 20,
  maxPatternLength: 200,
  maxNameLength: 80,
  maxSampleLength: 10_000,
  maxMatches: 500,
} as const;

export const IDENTIFIER_PATTERN_FINDING_CODES = [
  'too_long',
  'invalid_regex',
  'invalid_flags',
  'backreference',
  'lookbehind',
  'nested_unbounded_quantifier',
  'matches_empty',
  'probe_too_slow',
  'no_alphanumeric',
] as const;
export type IdentifierPatternFindingCode = (typeof IDENTIFIER_PATTERN_FINDING_CODES)[number];

/** Stored flags (the database accepts only these two). */
export type IdentifierPatternFlags = 'u' | 'iu';
/** Flags an accepted pattern is compiled with: `g` and `u` forced, `i` kept. */
export type CompiledIdentifierFlags = 'gu' | 'giu';

export interface IdentifierPatternFinding {
  code: IdentifierPatternFindingCode;
}

export type IdentifierPatternValidation =
  | { ok: true; flags: CompiledIdentifierFlags; storedFlags: IdentifierPatternFlags; probeChars: string[]; witnesses: string[] }
  | { ok: false; findings: IdentifierPatternFinding[] };

interface Node {
  kind: 'atom' | 'group' | 'assertion';
  /** Minimum and maximum repetitions of the quantifier on this term (1, 1 when it has none). */
  min: number;
  max: number;
  quantified: boolean;
  /** Atom: one character the atom accepts, used for probe runs and witnesses (null when unknown). */
  rep: string | null;
  /** Group or lookahead: alternatives of sequences. */
  alternatives?: Node[][];
  lookahead?: boolean;
}

interface ScanState {
  source: string;
  pos: number;
  findings: Set<IdentifierPatternFindingCode>;
  literals: Set<string>;
}

const CLASS_ESCAPE_REP: Record<string, string> = { d: '0', D: 'a', w: 'a', W: '-', s: ' ', S: 'a' };
const NEGATED_CLASS_CANDIDATES = ['a', 'A', '0', 'x', 'X', '5', 'z', '-', '.'];

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function codePointAt(state: ScanState): string {
  const cp = state.source.codePointAt(state.pos);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

function readHex(state: ScanState, length: number): string | null {
  const hex = state.source.slice(state.pos, state.pos + length);
  if (hex.length !== length || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  state.pos += length;
  return String.fromCodePoint(Number.parseInt(hex, 16));
}

/** Reads one escape after the backslash. Returns the character it stands for, or a class representative; sets findings. */
function readEscape(state: ScanState, inClass: boolean): { rep: string | null; assertion: boolean } {
  const ch = state.source[state.pos];
  state.pos += 1;
  if (ch === undefined) return { rep: null, assertion: false };
  if (!inClass && (ch === 'b' || ch === 'B')) return { rep: null, assertion: true };
  if (inClass && ch === 'b') return { rep: '\b', assertion: false };
  if (ch in CLASS_ESCAPE_REP) return { rep: CLASS_ESCAPE_REP[ch] as string, assertion: false };
  if (!inClass && isDigit(ch) && ch !== '0') {
    state.findings.add('backreference');
    while (isDigit(state.source[state.pos])) state.pos += 1;
    return { rep: null, assertion: false };
  }
  if (!inClass && ch === 'k') {
    state.findings.add('backreference');
    const close = state.source.indexOf('>', state.pos);
    state.pos = close === -1 ? state.source.length : close + 1;
    return { rep: null, assertion: false };
  }
  if (ch === 'p' || ch === 'P') {
    const close = state.source.indexOf('}', state.pos);
    const body = close === -1 ? '' : state.source.slice(state.pos + 1, close);
    state.pos = close === -1 ? state.source.length : close + 1;
    const value = body.includes('=') ? body.slice(body.indexOf('=') + 1) : body;
    if (ch === 'P') return { rep: /^N/.test(value) ? 'a' : '0', assertion: false };
    return { rep: /^(N|Nd|Number|Decimal_Number|Digit)/.test(value) ? '0' : 'a', assertion: false };
  }
  if (ch === 'u') {
    if (state.source[state.pos] === '{') {
      const close = state.source.indexOf('}', state.pos);
      const hex = close === -1 ? '' : state.source.slice(state.pos + 1, close);
      state.pos = close === -1 ? state.source.length : close + 1;
      const cp = /^[0-9a-fA-F]{1,6}$/.test(hex) ? Number.parseInt(hex, 16) : Number.NaN;
      return { rep: Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : null, assertion: false };
    }
    return { rep: readHex(state, 4), assertion: false };
  }
  if (ch === 'x') return { rep: readHex(state, 2), assertion: false };
  if (ch === 'c') {
    const letter = state.source[state.pos];
    state.pos += 1;
    return { rep: letter ? String.fromCharCode(letter.charCodeAt(0) % 32) : null, assertion: false };
  }
  if (ch === '0') return { rep: '\0', assertion: false };
  const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' };
  return { rep: map[ch] ?? ch, assertion: false };
}

/** Reads a character class after `[`. Picks a member for a positive class and a non-member for a negated one. */
function readClass(state: ScanState): string | null {
  const negated = state.source[state.pos] === '^';
  if (negated) state.pos += 1;
  const ranges: Array<[number, number]> = [];
  let first: string | null = null;
  let pending: string | null = null;
  while (state.pos < state.source.length && state.source[state.pos] !== ']') {
    let item: string | null;
    let isSet = false;
    if (state.source[state.pos] === '\\') {
      state.pos += 1;
      const before = state.source[state.pos];
      item = readEscape(state, true).rep;
      isSet = before !== undefined && /[dDwWsSpP]/.test(before);
    } else {
      item = codePointAt(state);
      state.pos += item.length;
    }
    if (pending !== null && item === '-' && state.source[state.pos] !== ']') {
      let end: string | null;
      if (state.source[state.pos] === '\\') {
        state.pos += 1;
        end = readEscape(state, true).rep;
      } else {
        end = codePointAt(state);
        state.pos += end.length;
      }
      const from = pending.codePointAt(0) ?? 0;
      const to = end?.codePointAt(0) ?? from;
      ranges.push([from, to]);
      first ??= pending;
      pending = null;
      continue;
    }
    if (pending !== null) {
      const cp = pending.codePointAt(0) ?? 0;
      ranges.push([cp, cp]);
      first ??= pending;
      pending = null;
    }
    if (item === null) continue;
    if (isSet) {
      first ??= item;
      const cp = item.codePointAt(0) ?? 0;
      ranges.push([cp, cp]);
      if (item === '0') ranges.push([48, 57]);
      if (item === 'a') ranges.push([97, 122], [65, 90]);
    } else {
      pending = item;
    }
  }
  if (pending !== null) {
    const cp = pending.codePointAt(0) ?? 0;
    ranges.push([cp, cp]);
    first ??= pending;
  }
  state.pos += 1;
  if (!negated) return first;
  const inside = (ch: string) => ranges.some(([from, to]) => (ch.codePointAt(0) ?? 0) >= from && (ch.codePointAt(0) ?? 0) <= to);
  return NEGATED_CLASS_CANDIDATES.find((ch) => !inside(ch)) ?? null;
}

function readQuantifier(state: ScanState): { min: number; max: number } | null {
  const ch = state.source[state.pos];
  let result: { min: number; max: number } | null = null;
  if (ch === '*') result = { min: 0, max: Number.POSITIVE_INFINITY };
  else if (ch === '+') result = { min: 1, max: Number.POSITIVE_INFINITY };
  else if (ch === '?') result = { min: 0, max: 1 };
  else if (ch === '{') {
    const match = /^\{(\d+)(,(\d*))?\}/.exec(state.source.slice(state.pos));
    if (!match) return null;
    const min = Number(match[1]);
    const max = match[2] === undefined ? min : match[3] === '' ? Number.POSITIVE_INFINITY : Number(match[3]);
    state.pos += match[0].length - 1;
    result = { min, max };
  }
  if (!result) return null;
  state.pos += 1;
  if (state.source[state.pos] === '?') state.pos += 1;
  return result;
}

function parseAlternatives(state: ScanState): Node[][] {
  const alternatives: Node[][] = [[]];
  while (state.pos < state.source.length) {
    const ch = state.source[state.pos];
    if (ch === ')') break;
    if (ch === '|') {
      state.pos += 1;
      alternatives.push([]);
      continue;
    }
    const node = parseTerm(state);
    if (node) (alternatives[alternatives.length - 1] as Node[]).push(node);
  }
  return alternatives;
}

function parseTerm(state: ScanState): Node | null {
  const ch = state.source[state.pos];
  let node: Node;
  if (ch === '^' || ch === '$') {
    state.pos += 1;
    return { kind: 'assertion', min: 1, max: 1, quantified: false, rep: null };
  }
  if (ch === '(') {
    state.pos += 1;
    let lookahead = false;
    if (state.source.startsWith('?<=', state.pos) || state.source.startsWith('?<!', state.pos)) {
      state.findings.add('lookbehind');
      state.pos += 3;
      lookahead = true;
    } else if (state.source.startsWith('?=', state.pos) || state.source.startsWith('?!', state.pos)) {
      state.pos += 2;
      lookahead = true;
    } else if (state.source.startsWith('?<', state.pos)) {
      const close = state.source.indexOf('>', state.pos);
      state.pos = close === -1 ? state.source.length : close + 1;
    } else if (state.source[state.pos] === '?') {
      const colon = state.source.indexOf(':', state.pos);
      state.pos = colon === -1 ? state.source.length : colon + 1;
    }
    const alternatives = parseAlternatives(state);
    state.pos += 1;
    node = lookahead
      ? { kind: 'assertion', min: 1, max: 1, quantified: false, rep: null, alternatives, lookahead: true }
      : { kind: 'group', min: 1, max: 1, quantified: false, rep: null, alternatives };
  } else if (ch === '[') {
    state.pos += 1;
    node = { kind: 'atom', min: 1, max: 1, quantified: false, rep: readClass(state) };
  } else if (ch === '\\') {
    state.pos += 1;
    const escape = readEscape(state, false);
    if (escape.assertion) return { kind: 'assertion', min: 1, max: 1, quantified: false, rep: null };
    node = { kind: 'atom', min: 1, max: 1, quantified: false, rep: escape.rep };
  } else if (ch === '.') {
    state.pos += 1;
    node = { kind: 'atom', min: 1, max: 1, quantified: false, rep: 'a' };
  } else {
    const literal = codePointAt(state);
    state.pos += literal.length;
    node = { kind: 'atom', min: 1, max: 1, quantified: false, rep: literal };
  }
  if (node.kind === 'atom' && node.rep !== null) state.literals.add(node.rep);
  const quantifier = readQuantifier(state);
  if (quantifier) {
    node.min = quantifier.min;
    node.max = quantifier.max;
    node.quantified = true;
  }
  return node;
}

function containsQuantifier(alternatives: Node[][]): boolean {
  return alternatives.some((sequence) => sequence.some((node) => node.quantified || (node.alternatives !== undefined && containsQuantifier(node.alternatives))));
}

/** A repeating group (maximum above 1) that contains any quantifier at any depth. An optional group (`?`, `{0,1}`) does not repeat. */
function findNestedQuantifier(alternatives: Node[][]): boolean {
  for (const sequence of alternatives) {
    for (const node of sequence) {
      if (!node.alternatives) continue;
      if (node.quantified && node.max > 1 && containsQuantifier(node.alternatives)) return true;
      if (findNestedQuantifier(node.alternatives)) return true;
    }
  }
  return false;
}

function nullable(node: Node): boolean {
  if (node.kind === 'assertion') return true;
  if (node.min === 0) return true;
  if (node.kind === 'group' && node.alternatives) return node.alternatives.some((sequence) => sequence.every(nullable));
  return false;
}

/** One string the pattern should match: the first alternative, each term repeated max(min, 1) times (capped), lookaheads skipped. */
function witnessOf(sequence: Node[]): string {
  let out = '';
  for (const node of sequence) {
    if (node.kind === 'assertion') continue;
    const times = Math.min(Math.max(node.min, 1), 64);
    const piece = node.kind === 'group' ? witnessOf(node.alternatives?.[0] ?? []) : (node.rep ?? 'a');
    out += piece.repeat(times);
  }
  return out;
}

/**
 * Static checks (D-29, D-52): length, the flags u or iu, compiles with u, no backreference, no lookbehind, no repeating group that
 * contains a quantifier, cannot match the empty string. On success the result also carries probe characters and witness strings
 * for the worker probe, which applies the remaining two rules (probe_too_slow, no_alphanumeric).
 */
export function validateIdentifierPattern(pattern: string, flags: string): IdentifierPatternValidation {
  const findings = new Set<IdentifierPatternFindingCode>();
  const source = typeof pattern === 'string' ? pattern : '';
  if (source.length > IDENTIFIER_PATTERN_LIMITS.maxPatternLength) findings.add('too_long');
  if (flags !== 'u' && flags !== 'iu') findings.add('invalid_flags');
  if (source.length === 0) findings.add('matches_empty');
  if (findings.has('too_long') || source.length === 0) return { ok: false, findings: [...findings].map((code) => ({ code })) };

  try {
    new RegExp(source, 'u');
  } catch {
    findings.add('invalid_regex');
    return { ok: false, findings: [...findings].map((code) => ({ code })) };
  }

  const state: ScanState = { source, pos: 0, findings, literals: new Set() };
  const alternatives = parseAlternatives(state);
  if (findNestedQuantifier(alternatives)) findings.add('nested_unbounded_quantifier');
  if (alternatives.some((sequence) => sequence.every(nullable))) findings.add('matches_empty');
  if (findings.size > 0) return { ok: false, findings: IDENTIFIER_PATTERN_FINDING_CODES.filter((code) => findings.has(code)).map((code) => ({ code })) };

  const storedFlags: IdentifierPatternFlags = flags === 'iu' ? 'iu' : 'u';
  const witnesses = alternatives.slice(0, 8).map(witnessOf).filter((value) => value.length > 0);
  const probeChars = [...state.literals].filter((ch) => ch.length > 0).slice(0, 12);
  return { ok: true, flags: storedFlags === 'iu' ? 'giu' : 'gu', storedFlags, probeChars, witnesses };
}
