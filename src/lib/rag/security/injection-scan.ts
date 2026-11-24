import { InjectionRuleSetSchema, type InjectionRuleSet } from '@/lib/rag-eval/contracts.generated';
import rawRules from '../../../../config/rag/injection-rules.json';

export interface InjectionScanResult {
  matched: boolean;
  rule_ids: string[];
  snippets: string[];
}

type InjectionRule = InjectionRuleSet['rules'][number];

interface CompiledRule {
  id: string;
  /** Normalised phrase, and the same phrase with every space removed; null for a regex rule. */
  phrase: string | null;
  phraseCompact: string | null;
  regex: RegExp | null;
  /** Also matched on the text with every space removed, because OCR puts spaces between Chinese characters. */
  compact: boolean;
}

interface LoadedRules {
  set: InjectionRuleSet;
  compiled: CompiledRule[];
}

interface Span {
  index: number;
  length: number;
}

const MAX_SNIPPETS = 3;
const SNIPPET_LENGTH = 80;
const WINDOW_LENGTH = 20_000;
const WINDOW_OVERLAP = 512;

const INVISIBLE_GLOBAL = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;
const INVISIBLE_ANY = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const CJK = /[㐀-鿿]/u;
const CONTROL = /\p{Cc}/gu;

/**
 * NFKC, invisible and bidi control characters replaced, lowercase, whitespace runs collapsed. Phrase rules and
 * the scanned text go through the same function; regex rules keep their source and match with the iu flags.
 */
function normalise(text: string, invisible: '' | ' '): string {
  return text.normalize('NFKC').replace(INVISIBLE_GLOBAL, invisible).toLowerCase().replace(/\s+/g, ' ').trim();
}

function ruleProblem(id: string, reason: string): never {
  throw new Error(`[Ingest Config] injection rule ${id}: ${reason}`);
}

function hasBackreference(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      const following = pattern[index + 1] ?? '';
      if (following >= '1' && following <= '9') return true;
      if (following === 'k' && pattern[index + 2] === '<') return true;
      index += 1;
    } else if (pattern.startsWith('(?P=', index)) {
      return true;
    }
  }
  return false;
}

interface GroupState {
  innerQuantifier: boolean;
  alternation: boolean;
}

/**
 * A single pass over the pattern. Rejects a quantified group that holds a `*`, `+` or `{}` quantifier (the `(a+)+`
 * shape, at any depth) and an unbounded repeat of a group with alternatives (`(a|aa)+`), the two shapes that make a
 * backtracking engine take exponential time. Character classes and escapes are skipped.
 */
function repetitionProblem(pattern: string): string | null {
  const stack: GroupState[] = [];
  let lastGroup: GroupState | null = null;
  let inClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (inClass) {
      if (char === '\\') index += 1;
      else if (char === ']') {
        inClass = false;
        lastGroup = null;
      }
      continue;
    }
    if (char === '\\') {
      index += 1;
      lastGroup = null;
    } else if (char === '[') {
      inClass = true;
    } else if (char === '(') {
      stack.push({ innerQuantifier: false, alternation: false });
      if (pattern[index + 1] === '?') {
        index += 1;
        const kind = pattern[index + 1];
        if (kind === ':' || kind === '=' || kind === '!') {
          index += 1;
        } else if (kind === '<') {
          const after = pattern[index + 2];
          if (after === '=' || after === '!') {
            index += 2;
          } else {
            const close = pattern.indexOf('>', index);
            if (close < 0) return 'unterminated group name';
            index = close;
          }
        }
      }
      lastGroup = null;
    } else if (char === ')') {
      const group = stack.pop();
      if (!group) return 'unbalanced parenthesis';
      const parent = stack[stack.length - 1];
      if (parent && group.innerQuantifier) parent.innerQuantifier = true;
      lastGroup = group;
    } else if (char === '|') {
      const top = stack[stack.length - 1];
      if (top) top.alternation = true;
      lastGroup = null;
    } else if (char === '*' || char === '+' || char === '?' || char === '{') {
      let unbounded = char === '*' || char === '+';
      if (char === '{') {
        const close = pattern.indexOf('}', index);
        if (close < 0) return 'unterminated quantifier';
        unbounded = /^\{\d+,\}$/u.test(pattern.slice(index, close + 1));
        index = close;
      }
      if (lastGroup) {
        if (char !== '?' && lastGroup.innerQuantifier) return 'nested quantifier';
        if (unbounded && lastGroup.alternation) return 'repeated alternation';
      }
      if (char !== '?') {
        const top = stack[stack.length - 1];
        if (top) top.innerQuantifier = true;
      }
      lastGroup = null;
    } else {
      lastGroup = null;
    }
  }
  return stack.length > 0 ? 'unbalanced parenthesis' : null;
}

function compileRule(rule: InjectionRule): CompiledRule {
  const { id } = rule;
  const compact = rule.language === 'zh' || CJK.test(rule.pattern);
  if (rule.kind === 'phrase') {
    const phrase = normalise(rule.pattern, '');
    if (phrase === '') return ruleProblem(id, 'phrase is empty after normalisation');
    return { id, phrase, phraseCompact: phrase.replace(/ /g, ''), regex: null, compact };
  }
  if (rule.pattern.length > 200) return ruleProblem(id, 'pattern is longer than 200 characters');
  if (hasBackreference(rule.pattern)) return ruleProblem(id, 'back-references are not allowed');
  const problem = repetitionProblem(rule.pattern);
  if (problem) return ruleProblem(id, problem);
  let regex: RegExp;
  try {
    regex = new RegExp(rule.pattern, 'iu');
  } catch {
    return ruleProblem(id, 'pattern does not compile');
  }
  if (regex.test('')) return ruleProblem(id, 'pattern matches empty text');
  return { id, phrase: null, phraseCompact: null, regex, compact };
}

function issueRuleId(raw: unknown, path: ReadonlyArray<string | number>): string | null {
  if (path[0] !== 'rules' || typeof path[1] !== 'number') return null;
  const rules = (raw as { rules?: unknown } | null)?.rules;
  const entry = Array.isArray(rules) ? (rules[path[1]] as { id?: unknown } | undefined) : undefined;
  return typeof entry?.id === 'string' ? entry.id : null;
}

function build(raw: unknown): LoadedRules {
  const parsed = InjectionRuleSetSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const id = issue ? issueRuleId(raw, issue.path) : null;
    const where = issue ? issue.path.join('.') : 'file';
    throw new Error(`[Ingest Config] injection rules invalid: ${id ? `rule ${id} ` : ''}(${where}): ${issue?.message ?? 'schema mismatch'}`);
  }
  const seen = new Set<string>();
  const compiled = parsed.data.rules.map((rule) => {
    if (seen.has(rule.id)) ruleProblem(rule.id, 'id is used more than once');
    seen.add(rule.id);
    return compileRule(rule);
  });
  return { set: parsed.data, compiled };
}

const NOT_SET = Symbol('injection-rules-not-set');
let override: unknown = NOT_SET;
let loaded: LoadedRules | null = null;

function current(): LoadedRules {
  if (!loaded) loaded = build(override === NOT_SET ? rawRules : override);
  return loaded;
}

/**
 * Validates a rule file with the generated schema and the limits the schema cannot express: no back-references, no
 * nested or ambiguous repetition, nothing that matches empty text, every pattern compiles. A failure names the rule.
 */
export function parseInjectionRuleSet(raw: unknown): InjectionRuleSet {
  return build(raw).set;
}

/** The rules in config/rag/injection-rules.json, validated and compiled once. Throws when the file is invalid. */
export function loadInjectionRules(): InjectionRuleSet {
  return current().set;
}

export function resetInjectionRulesForTests(): void {
  override = NOT_SET;
  loaded = null;
}

export function setInjectionRulesForTests(raw: unknown): void {
  override = raw;
  loaded = null;
}

function findRegex(regex: RegExp, view: string): Span | null {
  for (let start = 0; ; start += WINDOW_LENGTH - WINDOW_OVERLAP) {
    const end = Math.min(view.length, start + WINDOW_LENGTH);
    const found = regex.exec(view.slice(start, end));
    if (found) return { index: start + found.index, length: found[0].length };
    if (end >= view.length) return null;
  }
}

function findRule(rule: CompiledRule, view: string, compactView: boolean): Span | null {
  const phrase = compactView ? rule.phraseCompact : rule.phrase;
  if (phrase !== null) {
    const index = view.indexOf(phrase);
    return index < 0 ? null : { index, length: phrase.length };
  }
  return rule.regex ? findRegex(rule.regex, view) : null;
}

function snippetOf(view: string, span: Span): string {
  const centre = span.index + Math.floor(span.length / 2);
  const end = Math.min(view.length, Math.max(0, centre - SNIPPET_LENGTH / 2) + SNIPPET_LENGTH);
  const start = Math.max(0, end - SNIPPET_LENGTH);
  let slice = view.slice(start, end);
  const first = slice.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) slice = slice.slice(1);
  const last = slice.charCodeAt(slice.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1);
  return slice.replace(CONTROL, ' ').trim();
}

/**
 * Scans text for prompt-injection phrasing with the rules in config/rag/injection-rules.json. It takes a string and
 * returns the ids of every rule that matched and at most three snippets of at most 80 characters, cut from the
 * normalised text around a match. Snippets are document text: store them, never log them. Throws when the rule file
 * is invalid, so a caller decides whether to fail closed.
 */
export function scanText(text: string): InjectionScanResult {
  const { compiled } = current();
  if (typeof text !== 'string' || text.length === 0) return { matched: false, rule_ids: [], snippets: [] };

  const variants = [normalise(text, '')];
  if (INVISIBLE_ANY.test(text)) variants.push(normalise(text, ' '));
  const compacts = variants.map((variant) => variant.replace(/ /g, ''));

  const ruleIds: string[] = [];
  const snippets: string[] = [];
  for (const rule of compiled) {
    let found: { view: string; span: Span } | null = null;
    for (const [position, variant] of variants.entries()) {
      const plain = findRule(rule, variant, false);
      if (plain) {
        found = { view: variant, span: plain };
        break;
      }
      if (!rule.compact) continue;
      const compactView = compacts[position] as string;
      const spaced = findRule(rule, compactView, true);
      if (spaced) {
        found = { view: compactView, span: spaced };
        break;
      }
    }
    if (!found) continue;
    ruleIds.push(rule.id);
    if (snippets.length < MAX_SNIPPETS) {
      const snippet = snippetOf(found.view, found.span);
      if (snippet !== '' && !snippets.includes(snippet)) snippets.push(snippet);
    }
  }
  return { matched: ruleIds.length > 0, rule_ids: ruleIds, snippets };
}
