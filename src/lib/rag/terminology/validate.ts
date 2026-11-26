import type { TerminologyEntry, TerminologyValidationIssue } from '@/lib/rag-eval/contracts.generated';
import { normalizeLexical, queryLexicalTokens } from '../lexical/tokenize';
import { terminologyParams } from './expand';
import { termKey } from './matcher';

type IssueCode = TerminologyValidationIssue['code'];

/**
 * What a write is validated against (D-24): the layer written, its current entries (a candidate with the id of a current entry
 * replaces it), for a workspace layer the shared layer, and the enabled languages. Callers pass the enabled languages from the
 * Phase 3.2 settings module; this module reads no environment and holds no language list (D-35).
 */
export interface TerminologyValidationContext {
  layer: TerminologyEntry['layer'];
  current: readonly TerminologyEntry[];
  shared?: readonly TerminologyEntry[];
  enabledLanguages: readonly string[];
  minHanChars?: number;
}

const ANY = 'any';
const MAX_VARIANTS = 16;
const MAX_TERM_CHARS = 64;
const MAX_MESSAGE_CHARS = 500;
const MAX_QUOTED_CHARS = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HAN = /\p{Script=Han}/u;
const NON_WORD = /[^\p{L}\p{N}]/gu;

interface Item {
  row: number | null;
  id: string | null;
  canonical: string;
  canonicalKey: string;
  variantKeys: string[];
  language: string;
  kind: string;
  mode: string;
  enabled: boolean;
  source: string | null;
  target: string | null;
  suppression: boolean;
}

interface Pending {
  code: IssueCode;
  severity: TerminologyValidationIssue['severity'];
  message: string;
  items: Item[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function quote(value: string): string {
  const chars = [...value];
  return `"${chars.length > MAX_QUOTED_CHARS ? `${chars.slice(0, MAX_QUOTED_CHARS).join('')}…` : value}"`;
}

function collide(a: Item, b: Item): boolean {
  return a.language === b.language || a.language === ANY || b.language === ANY;
}

function isTranslation(item: Item): boolean {
  return item.kind === 'translation';
}

function tooShortHan(variant: string, minHanChars: number): boolean {
  const letters = [...normalizeLexical(variant).replace(NON_WORD, '')];
  return letters.length > 0 && letters.length < minHanChars && letters.every((char) => HAN.test(char));
}

function rawVariants(raw: Partial<TerminologyEntry>): unknown[] {
  return Array.isArray(raw.variants) ? raw.variants : [];
}

/** Per-entry rules: shape and limits, duplicates (rule 4), variants (rule 5), languages (rule 7), translation shape (rule 8). */
function checkEntry(raw: Partial<TerminologyEntry>, item: Item, enabled: ReadonlySet<string>, minHanChars: number, push: (pending: Pending) => void): void {
  const one = (code: IssueCode, message: string, severity: Pending['severity'] = 'error') => push({ code, severity, message, items: [item] });
  if (typeof raw.canonical !== 'string' || raw.canonical.trim() === '') one('invalid_variant', 'The canonical term is missing or not text.');
  else if (raw.canonical.length > MAX_TERM_CHARS) one('limit', `The canonical term is longer than ${MAX_TERM_CHARS} characters.`);
  if (raw.variants !== undefined && !Array.isArray(raw.variants)) one('invalid_variant', 'Variants must be a list of terms.');

  const variants = rawVariants(raw);
  if (variants.length > MAX_VARIANTS) one('limit', `An entry has at most ${MAX_VARIANTS} variants; this one has ${variants.length}.`);
  if (!item.suppression && variants.length === 0) one('invalid_variant', 'An entry needs at least one variant.');

  const identifier = item.kind === 'identifier';
  const seen = new Set<string>();
  for (const value of variants) {
    if (typeof value !== 'string') {
      one('invalid_variant', 'A variant is not text.');
      continue;
    }
    if (value.length > MAX_TERM_CHARS) {
      one('limit', `The variant ${quote(value)} is longer than ${MAX_TERM_CHARS} characters.`);
      continue;
    }
    const key = termKey(value, identifier);
    if (key !== '' && key === item.canonicalKey) {
      one('duplicate', `The variant ${quote(value)} equals the canonical term and is dropped.`, 'warning');
      continue;
    }
    if (key !== '' && seen.has(key)) {
      one('duplicate', `The variant ${quote(value)} is listed twice and is dropped.`, 'warning');
      continue;
    }
    seen.add(key);
    if (tooShortHan(value, minHanChars)) one('invalid_variant', `The Han variant ${quote(value)} has fewer than ${minHanChars} characters.`);
    else if (key === '' || queryLexicalTokens(value).length === 0) one('invalid_variant', `The variant ${quote(value)} has no searchable token (stopwords or punctuation only).`);
  }

  if (isTranslation(item)) {
    if (item.language === ANY) one('invalid_translation', 'A translation pair needs a concrete language, not any.');
    else if (!enabled.has(item.language)) one('invalid_language', `The language ${quote(item.language)} is not enabled.`);
    if (item.source === null || item.target === null) one('invalid_translation', 'A translation pair needs both a source and a target language.');
    else if (item.source === item.target) one('invalid_translation', 'The source and target languages of a translation pair must differ.');
    if (item.source !== null && item.language !== ANY && item.language !== item.source) {
      one('invalid_translation', 'The language of a translation pair must equal its source language.');
    }
    if (item.mode !== 'one_way') one('invalid_translation', 'A translation pair is always one_way.');
  } else {
    if (item.language !== ANY && !enabled.has(item.language)) one('invalid_language', `The language ${quote(item.language)} is not enabled.`);
    if (item.source !== null || item.target !== null) one('invalid_translation', 'Only translation pairs carry source and target languages.');
  }
  for (const [label, code] of [
    ['source', item.source],
    ['target', item.target],
  ] as const) {
    if (code !== null && !enabled.has(code)) one('invalid_language', `The ${label} language ${quote(code)} is not enabled.`);
  }
}

function toItem(raw: Partial<TerminologyEntry>, row: number | null): Item {
  const kind = text(raw.kind);
  const identifier = kind === 'identifier';
  const canonical = text(raw.canonical);
  const variantKeys = rawVariants(raw)
    .filter((value): value is string => typeof value === 'string' && value.length <= MAX_TERM_CHARS)
    .map((value) => termKey(value, identifier))
    .filter((key) => key !== '');
  return {
    row,
    id: optionalText(raw.id),
    canonical,
    canonicalKey: termKey(canonical, identifier),
    variantKeys: [...new Set(variantKeys)],
    language: text(raw.language),
    kind,
    mode: text(raw.mode) || 'one_way',
    enabled: raw.enabled !== false,
    source: optionalText(raw.source_language),
    target: optionalText(raw.target_language),
    suppression: optionalText(raw.suppresses_entry_id) !== null,
  };
}

function index(items: readonly Item[], keysOf: (item: Item) => readonly string[]): Map<string, Item[]> {
  const out = new Map<string, Item[]>();
  for (const item of items) {
    for (const key of new Set(keysOf(item))) {
      if (key === '') continue;
      const list = out.get(key);
      if (list) list.push(item);
      else out.set(key, [item]);
    }
  }
  return out;
}

function pairKey(a: Item, b: Item, items: readonly Item[]): string {
  return `${items.indexOf(a)}:${items.indexOf(b)}`;
}

/** Strongly connected components of the variant → canonical graph (iterative Tarjan); each with two or more terms is a cycle. */
function cycles(items: readonly Item[]): Item[][] {
  const edges = new Map<string, { to: string; item: Item }[]>();
  for (const item of items) {
    for (const variant of item.variantKeys) {
      if (variant === item.canonicalKey || item.canonicalKey === '') continue;
      const list = edges.get(variant) ?? [];
      list.push({ to: item.canonicalKey, item });
      edges.set(variant, list);
    }
  }
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  for (const start of edges.keys()) {
    if (order.has(start)) continue;
    const work: { node: string; next: number }[] = [{ node: start, next: 0 }];
    order.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const out = edges.get(frame.node) ?? [];
      if (frame.next < out.length) {
        const to = out[frame.next]!.to;
        frame.next += 1;
        if (!order.has(to)) {
          order.set(to, counter);
          low.set(to, counter);
          counter += 1;
          stack.push(to);
          onStack.add(to);
          work.push({ node: to, next: 0 });
        } else if (onStack.has(to)) low.set(frame.node, Math.min(low.get(frame.node)!, order.get(to)!));
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === order.get(frame.node)) {
        const component: string[] = [];
        let node: string;
        do {
          node = stack.pop()!;
          onStack.delete(node);
          component.push(node);
        } while (node !== frame.node);
        if (component.length > 1) components.push(component);
      }
    }
  }
  return components.map((component) => {
    const members = new Set(component);
    const owners: Item[] = [];
    for (const node of component) {
      for (const edge of edges.get(node) ?? []) if (members.has(edge.to) && !owners.includes(edge.item)) owners.push(edge.item);
    }
    return owners;
  });
}

/** Cross-entry rules of one layer: conflicts (1, 6, 9), chains (2) and cycles (3); translation pairs only take part in rule 9. */
function checkLayer(pool: readonly Item[], enabledLanguages: readonly string[], push: (pending: Pending) => void): void {
  const terms = pool.filter((item) => !isTranslation(item));
  const reported = new Set<string>();
  const pairOnce = (code: IssueCode, a: Item, b: Item, message: string) => {
    if (a.row === null && b.row === null) return;
    const [x, y] = pool.indexOf(a) < pool.indexOf(b) ? [a, b] : [b, a];
    const key = `${code}|${pairKey(x, y, pool)}`;
    if (reported.has(key)) return;
    reported.add(key);
    push({ code, severity: 'error', message, items: [x, y] });
  };

  for (const [variant, items] of index(terms, (item) => item.variantKeys)) {
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i]!;
        const b = items[j]!;
        if (a.canonicalKey === b.canonicalKey || !collide(a, b)) continue;
        pairOnce('conflict', a, b, `The variant ${quote(variant)} maps to two canonical terms, ${quote(a.canonical)} and ${quote(b.canonical)}.`);
      }
    }
  }

  const equivalent = terms.filter((item) => item.mode === 'equivalent');
  for (const [member, items] of index(equivalent, (item) => [item.canonicalKey, ...item.variantKeys])) {
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        if (!collide(items[i]!, items[j]!)) continue;
        pairOnce('conflict', items[i]!, items[j]!, `Two equivalent sets share the term ${quote(member)}; merge them into one entry.`);
      }
    }
  }

  const byCanonical = index(terms, (item) => [item.canonicalKey]);
  for (const a of terms) {
    for (const variant of a.variantKeys) {
      for (const b of byCanonical.get(variant) ?? []) {
        if (a === b || !collide(a, b) || (a.mode === 'equivalent' && b.mode === 'equivalent')) continue;
        pairOnce('chain', a, b, `The variant ${quote(variant)} of ${quote(a.canonical)} is the canonical term of another entry; expansion is one hop, so merge these entries.`);
      }
    }
  }

  const buckets = enabledLanguages.length > 0 ? [...new Set(enabledLanguages)] : [ANY];
  const cycleSeen = new Set<string>();
  for (const language of buckets) {
    const bucket = terms.filter((item) => item.language === language || item.language === ANY);
    for (const owners of cycles(bucket)) {
      if (owners.every((item) => item.row === null)) continue;
      const key = owners
        .map((item) => pool.indexOf(item))
        .sort((x, y) => x - y)
        .join(',');
      if (cycleSeen.has(key)) continue;
      cycleSeen.add(key);
      push({
        code: 'cycle',
        severity: 'error',
        message: `These entries form a loop through their canonical terms and variants: ${owners.map((item) => quote(item.canonical)).join(', ')}.`.slice(0, MAX_MESSAGE_CHARS),
        items: owners,
      });
    }
  }

  const translations = pool.filter(isTranslation);
  for (const [, items] of index(translations, (item) => item.variantKeys.map((variant) => `${item.source ?? ''}\u0000${item.target ?? ''}\u0000${variant}`))) {
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i]!;
        const b = items[j]!;
        if (a.canonicalKey === b.canonicalKey) continue;
        pairOnce('conflict', a, b, `One source term has two required targets for the same language pair: ${quote(a.canonical)} and ${quote(b.canonical)}.`);
      }
    }
  }
}

/** Cross-layer collisions are not errors: a workspace entry that shares a term with a shared entry is reported as an override. */
function checkOverrides(candidates: readonly Item[], shared: readonly Item[], push: (pending: Pending) => void): void {
  const surfaces = (item: Item) => [item.canonicalKey, ...item.variantKeys];
  const byTerm = index(shared, surfaces);
  for (const item of candidates) {
    const hits: Item[] = [];
    for (const key of new Set(surfaces(item))) {
      for (const other of byTerm.get(key) ?? []) {
        if (isTranslation(other) !== isTranslation(item) || !collide(item, other) || hits.includes(other)) continue;
        hits.push(other);
      }
    }
    for (const other of hits) {
      push({ code: 'override', severity: 'warning', message: `This entry overrides the shared entry ${quote(other.canonical)} for this workspace.`, items: [item, other] });
    }
  }
}

function toIssue(pending: Pending): TerminologyValidationIssue {
  const rows = pending.items.map((item) => item.row).filter((row): row is number => row !== null);
  const ids = [...new Set(pending.items.map((item) => item.id).filter((id): id is string => id !== null && UUID.test(id)))];
  const issue: TerminologyValidationIssue = {
    code: pending.code,
    severity: pending.severity,
    message: pending.message.slice(0, MAX_MESSAGE_CHARS) || pending.code,
    row: rows.length > 0 ? Math.max(...rows) : null,
  };
  if (ids.length > 0) issue.entry_ids = ids;
  return issue;
}

function compareIssues(a: TerminologyValidationIssue, b: TerminologyValidationIssue): number {
  const rowA = a.row ?? Number.MAX_SAFE_INTEGER;
  const rowB = b.row ?? Number.MAX_SAFE_INTEGER;
  if (rowA !== rowB) return rowA - rowB;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  if (a.message !== b.message) return a.message < b.message ? -1 : 1;
  const idsA = (a.entry_ids ?? []).join(',');
  const idsB = (b.entry_ids ?? []).join(',');
  return idsA < idsB ? -1 : idsA > idsB ? 1 : 0;
}

/**
 * Validates candidate entries before any write (D-24): pure and deterministic, never throws on user input. Rows are the
 * 1-based positions of the candidates; issues are sorted by row, then code.
 */
export function validateEntries(candidates: readonly TerminologyEntry[], context: TerminologyValidationContext): TerminologyValidationIssue[] {
  const enabledLanguages = Array.isArray(context?.enabledLanguages) ? context.enabledLanguages.filter((code) => typeof code === 'string') : [];
  const enabled = new Set(enabledLanguages);
  const minHanChars = context?.minHanChars ?? terminologyParams().min_han_chars;
  const pending: Pending[] = [];
  const push = (value: Pending) => pending.push(value);

  const list = Array.isArray(candidates) ? candidates : [];
  const items: Item[] = [];
  list.forEach((value, position) => {
    const raw = (value !== null && typeof value === 'object' ? value : {}) as Partial<TerminologyEntry>;
    const item = toItem(raw, position + 1);
    items.push(item);
    checkEntry(raw, item, enabled, minHanChars, push);
  });

  const replaced = new Set(items.map((item) => item.id).filter((id): id is string => id !== null));
  const current = (Array.isArray(context?.current) ? context.current : [])
    .map((value) => toItem((value ?? {}) as Partial<TerminologyEntry>, null))
    .filter((item) => item.id === null || !replaced.has(item.id));
  const active = (item: Item) => item.enabled && !item.suppression && item.canonicalKey !== '';
  checkLayer([...items, ...current].filter(active), enabledLanguages, push);

  if (context?.layer === 'workspace' && Array.isArray(context.shared)) {
    const shared = context.shared.map((value) => toItem((value ?? {}) as Partial<TerminologyEntry>, null)).filter(active);
    checkOverrides(items.filter(active), shared, push);
  }

  const seen = new Set<string>();
  const issues: TerminologyValidationIssue[] = [];
  for (const issue of pending.map(toIssue)) {
    const key = `${issue.row}|${issue.code}|${issue.message}|${(issue.entry_ids ?? []).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  return issues.sort(compareIssues);
}
