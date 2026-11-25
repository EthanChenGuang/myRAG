import lexicon from './rewrite-gate.lexicon.json';
import { countCjkChars, detectGateLanguage, type GateLang } from './gate-language';
import { scanProtected } from './protected';

export type Lang = GateLang;
export type Transform = 'condense_history' | 'normalize_dates' | 'decompose' | 'expand' | 'translate';

export const GATE_RULE_IDS = [
  'R0_TOO_SHORT',
  'R1_PRONOUN',
  'R2_RELATIVE_TIME',
  'R3_COMPARISON',
  'R4_EXACT_CODE',
  'R5_ELLIPTICAL',
  'R6_COMPOUND',
  'R7_PROTECTED_LITERAL',
  'R8_LANGUAGE_MISMATCH',
  'R9_KEYWORDS',
  'R10_VAGUE',
  'R11_LONG_COMPLETE',
  'R12_SMALL_TALK',
] as const;

export type GateRuleId = (typeof GATE_RULE_IDS)[number];

export interface GateResult {
  rewrite: boolean;
  transforms: Transform[];
  reasons: GateRuleId[];
  lang: Lang;
  protectedTokens: string[];
  skipRetrieval?: boolean;
}

export interface GateContext {
  hasHistory: boolean;
  kbLang?: Lang;
  now: Date;
  /** Knowledge-base language shares (D-23); when given, R8 uses the 20% rule instead of kbLang. */
  kbShares?: Partial<Record<Lang, number>>;
}

export type RelativeTimeMatch = { term: string; unit: string; offset: number | null; n?: number };

const SHORT_ZH_MAX_UNITS = 6;
const SHORT_WORDS_MAX = 3;
const LONG_ZH_MIN_UNITS = 30;
const LONG_WORDS_MIN = 15;
const TRANSLATE_MAX_SHARE = 0.2;

const TRANSFORM_ORDER: readonly Transform[] = ['condense_history', 'normalize_dates', 'decompose', 'expand', 'translate'];
const LLM_TRANSFORMS: ReadonlySet<Transform> = new Set(['condense_history', 'decompose', 'expand', 'translate']);

type Langs<T> = { zh: T; en: T; it: T };

const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}_])';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lowercase, NFC, curly apostrophes to ', Italian elisions split (l'anno -> l' anno). */
function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/(\p{L})'(?=\p{L})/gu, "$1' ");
}

function latinTermSource(term: string): string {
  return escapeRegex(normalizeText(term)).replace(/\s+/g, '\\s+');
}

function byLengthDesc(a: string, b: string): number {
  return b.length - a.length;
}

function zhRegex(terms: readonly string[], extra: readonly string[] = []): RegExp | null {
  const parts = [...[...terms].sort(byLengthDesc).map(escapeRegex), ...extra];
  return parts.length === 0 ? null : new RegExp(parts.join('|'), 'u');
}

function latinRegex(terms: readonly string[], extra: readonly string[] = []): RegExp | null {
  const words = [...terms].sort(byLengthDesc).map(latinTermSource);
  const parts: string[] = [];
  if (words.length > 0) parts.push(`${NOT_WORD_BEFORE}(?:${words.join('|')})${NOT_WORD_AFTER}`);
  parts.push(...extra);
  return parts.length === 0 ? null : new RegExp(parts.join('|'), 'iu');
}

function leadingRegex(terms: readonly string[]): RegExp {
  const words = [...terms].sort(byLengthDesc).map(latinTermSource);
  return new RegExp(`^\\s*(?:${words.join('|')})${NOT_WORD_AFTER}`, 'iu');
}

type RuleMatcher = { zh: RegExp | null; latin: RegExp[] };

function rule(lists: Langs<readonly string[]>, extra: Partial<Langs<readonly string[]>> = {}): RuleMatcher {
  const latin = [latinRegex(lists.en, extra.en), latinRegex(lists.it, extra.it)].filter(
    (regex): regex is RegExp => regex !== null
  );
  return { zh: zhRegex(lists.zh, extra.zh), latin };
}

function fires(matcher: RuleMatcher, text: string): boolean {
  if (matcher.zh !== null && matcher.zh.test(text)) return true;
  return matcher.latin.some((regex) => regex.test(text));
}

const P = lexicon.patterns;

const R1 = rule(lexicon.pronouns, { zh: [P.zh_gai] });
const R3 = rule(lexicon.comparison, { en: [P.comparison_between.en], it: [P.comparison_between.it] });
const R5 = rule(lexicon.elliptical, { zh: P.zh_elliptical });
const R5_LEADING: readonly RegExp[] = [
  leadingRegex(lexicon.elliptical_leading.en),
  leadingRegex(lexicon.elliptical_leading.it),
];
const R6 = rule(lexicon.compound);
const R10 = rule(lexicon.vague);
const QUESTION_WORDS = rule({
  zh: lexicon.question_markers.zh.question_words,
  en: lexicon.question_markers.en.question_words,
  it: lexicon.question_markers.it.question_words,
});
const VERB_MARKERS = rule({
  zh: lexicon.question_markers.zh.verb_markers,
  en: lexicon.question_markers.en.verb_markers,
  it: lexicon.question_markers.it.verb_markers,
});

const SMALL_TALK: ReadonlySet<string> = new Set(
  [...lexicon.small_talk.zh, ...lexicon.small_talk.en, ...lexicon.small_talk.it].map((term) =>
    normalizeText(term).replace(/\s+/g, ' ')
  )
);

type RelativeEntry = (typeof lexicon.relative_time.zh)[number];
type FixedEntry = { term: string; unit: string; offset: number | null };

const FIXED_RELATIVE = new Map<string, FixedEntry>();
const N_RELATIVE: { regex: RegExp; entry: { term: string; unit: string } }[] = [];

for (const lang of ['zh', 'en', 'it'] as const) {
  for (const entry of lexicon.relative_time[lang] as readonly RelativeEntry[]) {
    if ('n_placeholder' in entry && entry.n_placeholder) continue;
    const offset = 'offset' in entry ? (entry.offset ?? null) : null;
    FIXED_RELATIVE.set(normalizeText(entry.term), { term: entry.term, unit: entry.unit, offset });
  }
  const nEntries = (lexicon.relative_time[lang] as readonly RelativeEntry[]).filter(
    (entry) => 'n_placeholder' in entry && entry.n_placeholder
  );
  for (const { pattern, unit } of P.relative_time_n[lang]) {
    const entry = nEntries.find((candidate) => candidate.unit === unit);
    if (entry) N_RELATIVE.push({ regex: new RegExp(pattern, 'giu'), entry: { term: entry.term, unit } });
  }
}

const FIXED_RELATIVE_REGEX = (() => {
  const zhTerms: string[] = [];
  const latinTerms: string[] = [];
  for (const key of FIXED_RELATIVE.keys()) {
    if (countCjkChars(key) > 0) zhTerms.push(escapeRegex(key));
    else latinTerms.push(escapeRegex(key).replace(/\s+/g, '\\s+'));
  }
  zhTerms.sort(byLengthDesc);
  latinTerms.sort(byLengthDesc);
  return new RegExp(
    `(${zhTerms.join('|')})|${NOT_WORD_BEFORE}(${latinTerms.join('|')})${NOT_WORD_AFTER}`,
    'giu'
  );
})();

const ZH_NUMERALS: Readonly<Record<string, number>> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function parseCount(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === '十') return 10;
  const tenIndex = raw.indexOf('十');
  if (tenIndex === -1) return ZH_NUMERALS[raw] ?? Number.NaN;
  const tens = tenIndex === 0 ? 1 : (ZH_NUMERALS[raw.slice(0, tenIndex)] ?? Number.NaN);
  const ones = tenIndex === raw.length - 1 ? 0 : (ZH_NUMERALS[raw.slice(tenIndex + 1)] ?? Number.NaN);
  return tens * 10 + ones;
}

type Span = { index: number; length: number; match: RelativeTimeMatch };

function scanRelativeTime(normalized: string): Span[] {
  const spans: Span[] = [];
  FIXED_RELATIVE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FIXED_RELATIVE_REGEX.exec(normalized)) !== null) {
    const key = (match[1] ?? match[2] ?? '').replace(/\s+/g, ' ');
    const entry = FIXED_RELATIVE.get(key);
    if (entry) spans.push({ index: match.index, length: match[0].length, match: { ...entry } });
  }
  for (const { regex, entry } of N_RELATIVE) {
    regex.lastIndex = 0;
    while ((match = regex.exec(normalized)) !== null) {
      const n = parseCount(match[1] ?? '');
      spans.push({
        index: match.index,
        length: match[0].length,
        match: { term: entry.term, unit: entry.unit, offset: null, ...(Number.isFinite(n) ? { n } : {}) },
      });
    }
  }
  return spans.sort((a, b) => a.index - b.index);
}

function maskSpans(text: string, spans: readonly Span[]): string {
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.index < cursor) continue;
    out += text.slice(cursor, span.index) + ' '.repeat(span.length);
    cursor = span.index + span.length;
  }
  return out + text.slice(cursor);
}

/** R2 phrases as structured lexicon entries (unit, offset or n); of overlapping spans only the longest is kept. */
export function matchRelativeTime(q: string): RelativeTimeMatch[] {
  const spans = scanRelativeTime(normalizeText(q));
  return spans
    .filter(
      (span) =>
        !spans.some(
          (other) =>
            other !== span &&
            other.length > span.length &&
            other.index < span.index + span.length &&
            span.index < other.index + other.length
        )
    )
    .map((span) => span.match);
}

const WORD = /[\p{L}\p{N}_]+/gu;
const LATIN_OR_DIGIT_RUN = /[\p{Script=Latin}\p{N}_]+/gu;
const QUESTION_MARK = /[?？]/g;
const SMALL_TALK_STRIP = /[\s\p{P}\p{S}]+/gu;

function countRegex(text: string, regex: RegExp): number {
  regex.lastIndex = 0;
  let count = 0;
  while (regex.exec(text) !== null) count += 1;
  return count;
}

/** zh: CJK characters plus non-CJK word runs; en/it: words. */
function lengthUnits(text: string, lang: Lang): number {
  if (lang === 'zh') return countCjkChars(text) + countRegex(text, LATIN_OR_DIGIT_RUN);
  return countRegex(text, WORD);
}

function isSmallTalk(normalized: string): boolean {
  const compact = normalized.replace(SMALL_TALK_STRIP, ' ').trim();
  return compact.length > 0 && SMALL_TALK.has(compact);
}

function translateNeeded(lang: Lang, ctx: GateContext): boolean {
  if (ctx.kbShares !== undefined) {
    const known = Object.values(ctx.kbShares).some((share) => typeof share === 'number');
    if (!known) return false;
    return (ctx.kbShares[lang] ?? 0) <= TRANSLATE_MAX_SHARE;
  }
  return ctx.kbLang !== undefined && ctx.kbLang !== lang;
}

/**
 * LAT-03 rewrite gate (.planning/specs/query-rewrite-gate.md). Pure and synchronous: evaluates every
 * rule, returns all that fired and the transforms they map to. No LLM call, no I/O.
 */
export function needsRewrite(q: string, ctx: GateContext): GateResult {
  const lang = detectGateLanguage(q);
  const normalized = normalizeText(q);

  if (isSmallTalk(normalized)) {
    return { rewrite: false, transforms: [], reasons: ['R12_SMALL_TALK'], lang, protectedTokens: [], skipRetrieval: true };
  }

  const fired = new Set<GateRuleId>();
  const transforms = new Set<Transform>();
  const scan = scanProtected(q);

  const relative = scanRelativeTime(normalized);
  const withoutTime = maskSpans(normalized, relative);

  const r1 = ctx.hasHistory && fires(R1, withoutTime);
  const r5 = ctx.hasHistory && (fires(R5, withoutTime) || R5_LEADING.some((regex) => regex.test(withoutTime)));
  const condense = r1 || r5;
  const units = lengthUnits(q, lang);
  const short = lang === 'zh' ? units < SHORT_ZH_MAX_UNITS : units < SHORT_WORDS_MAX;
  const long = lang === 'zh' ? units >= LONG_ZH_MIN_UNITS : units >= LONG_WORDS_MIN;

  const r0 = short && !condense;
  const r2 = relative.length > 0;
  const r3 = fires(R3, normalized);
  const r4 = scan.hasExactCode;
  const r6 = fires(R6, normalized) || countRegex(q, QUESTION_MARK) >= 2;
  const r7 = scan.hasLiteral;
  const r8 = translateNeeded(lang, ctx);
  const termCount = normalized.split(/\s+/).filter((term) => /[\p{L}\p{N}]/u.test(term)).length;
  const r9 =
    termCount >= 2 &&
    countRegex(q, QUESTION_MARK) === 0 &&
    !fires(QUESTION_WORDS, normalized) &&
    !fires(VERB_MARKERS, normalized);
  const r10 = !r3 && !r4 && !r6 && fires(R10, normalized);
  const r11 = long && !r1 && !r2 && !r3 && !r5 && !r6 && !r8;
  const r4Complete = r4 && !short && !condense;

  if (r0) fired.add('R0_TOO_SHORT');
  if (r1) fired.add('R1_PRONOUN');
  if (r2) fired.add('R2_RELATIVE_TIME');
  if (r3) fired.add('R3_COMPARISON');
  if (r4) fired.add('R4_EXACT_CODE');
  if (r5) fired.add('R5_ELLIPTICAL');
  if (r6) fired.add('R6_COMPOUND');
  if (r7) fired.add('R7_PROTECTED_LITERAL');
  if (r8) fired.add('R8_LANGUAGE_MISMATCH');
  if (r9) fired.add('R9_KEYWORDS');
  if (r10) fired.add('R10_VAGUE');
  if (r11) fired.add('R11_LONG_COMPLETE');

  if (condense) transforms.add('condense_history');
  if (r2) transforms.add('normalize_dates');
  if (r3 || r6) transforms.add('decompose');
  if (r0 || r9 || r10) transforms.add('expand');
  if (r8) transforms.add('translate');

  if (r11 || r4Complete) {
    transforms.delete('expand');
    transforms.delete('decompose');
  }

  const ordered = TRANSFORM_ORDER.filter((transform) => transforms.has(transform));
  return {
    rewrite: ordered.some((transform) => LLM_TRANSFORMS.has(transform)),
    transforms: ordered,
    reasons: GATE_RULE_IDS.filter((id) => fired.has(id)),
    lang,
    protectedTokens: scan.tokens,
  };
}
