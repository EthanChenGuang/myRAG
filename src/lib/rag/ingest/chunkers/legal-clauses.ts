import { buildEmbeddingText } from '../text/embedding-text';
import { countTokens, truncateToTokens } from '../text/tokens';
import type { ChunkDraft, ChunkResult } from '../types';
import {
  CJK_SENTENCE_END,
  FENCE,
  HEADING,
  SENTENCE_END,
  chunkSection,
  hardSplit,
  type MarkdownChunkOptions,
} from './markdown-sections';

export interface LegalChunkOptions extends MarkdownChunkOptions {
  /** Clause heading patterns from the profile data; applied to the start of each line. */
  clause_patterns?: readonly string[];
  /** Phrases that make a line ending in a colon an exception lead-in bound to the list after it. */
  lead_in_phrases?: readonly string[];
}

type UnitKind = 'heading' | 'para' | 'lead' | 'item';

interface Unit {
  text: string;
  /** Separator that precedes this unit when it follows another one. */
  sep: string;
  kind: UnitKind;
  /** Index of the lead-in unit an item belongs to. */
  lead?: number;
}

interface ClauseSpan {
  kind: 'clause';
  outer: string[];
  label: string;
  firstLine: string;
  body: string[];
}

interface TextSpan {
  kind: 'text';
  path: string[];
  lines: string[];
}

type Span = ClauseSpan | TextSpan;

const CHAPTER = /^ {0,3}第[一二三四五六七八九十百零〇\d]+章/u;
const ITEM =
  /^[ \t]{0,6}(?:[-*+•·][ \t]+\S|\d{1,3}(?:[.)][ \t]+|、[ \t]*)\S|[（(][一二三四五六七八九十\da-zA-Z]{1,4}[)）][ \t]*\S|[a-zA-Z][.)][ \t]+\S)/u;
const MATCH_WINDOW = 200;
const MIN_PART_BUDGET = 24;
const COMPILED = new Map<string, RegExp>();

function compile(patterns: readonly string[]): RegExp[] {
  return patterns.map((source) => {
    let pattern = COMPILED.get(source);
    if (!pattern) {
      pattern = new RegExp(source, 'u');
      COMPILED.set(source, pattern);
    }
    return pattern;
  });
}

/** The text a clause pattern matched at the very start of the line, or null. */
function matchClause(text: string, patterns: readonly RegExp[]): string | null {
  const start = text.replace(/^ {0,3}/, '').slice(0, MATCH_WINDOW);
  for (const pattern of patterns) {
    const match = pattern.exec(start);
    if (match && match.index === 0 && match[0].trim() !== '') return match[0].trim();
  }
  return null;
}

/**
 * Lower numbers rank higher: article-like markers (第X条, Art., Article, Articolo) above numbered
 * (1. then 1.1 then 1.1.1) above bracketed (（一）). A heading ranked below the open clause is an item of it.
 */
function rankOf(marker: string): number {
  if (/^[（(]/u.test(marker)) return 300;
  if (/^\d/.test(marker)) return 200 + Math.min(marker.match(/\d+/g)?.length ?? 1, 9);
  return 100;
}

const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function scan(markdown: string, patterns: readonly RegExp[], labelCap: number): Span[] {
  const spans: Span[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let text: TextSpan | null = { kind: 'text', path: [], lines: [] };
  let clause: (ClauseSpan & { rank: number }) | null = null;
  let fence: string | null = null;

  const outerPath = (): string[] => stack.map((entry) => entry.title);
  const closeAll = (): void => {
    if (text && text.lines.some((line) => line.trim() !== '')) spans.push(text);
    text = null;
    if (clause) spans.push(clause);
    clause = null;
  };
  const outerHeading = (level: number, title: string): void => {
    closeAll();
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    stack.push({ level, title });
    text = { kind: 'text', path: outerPath(), lines: [] };
  };
  const append = (line: string): void => {
    if (clause) clause.body.push(line);
    else text?.lines.push(line);
  };

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '```';
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      append(line);
      continue;
    }
    if (fence !== null) {
      append(line);
      continue;
    }

    let candidate: { display: string; marker: string } | null = null;
    const heading = HEADING.exec(line);
    if (heading) {
      const title = (heading[2] ?? '').trim();
      if (title === '') continue;
      const marker = matchClause(title, patterns);
      if (marker === null) {
        outerHeading((heading[1] ?? '#').length, title);
        continue;
      }
      candidate = { display: title, marker };
    } else if (CHAPTER.test(line)) {
      outerHeading(2, line.trim());
      continue;
    } else {
      const marker = matchClause(line, patterns);
      if (marker !== null) candidate = { display: line.trim(), marker };
    }
    if (!candidate) {
      append(line);
      continue;
    }

    const rank = rankOf(candidate.marker);
    if (clause && rank > clause.rank) {
      clause.body.push(line);
      continue;
    }
    const outer = outerPath();
    closeAll();
    const label =
      countTokens(candidate.display) <= labelCap ? candidate.display : truncateToTokens(candidate.marker, labelCap);
    clause = { kind: 'clause', outer, label, firstLine: candidate.display, body: [], rank };
  }
  closeAll();
  return spans;
}

function toUnits(
  heading: string | null,
  body: readonly string[],
  isItemStart: (_line: string) => boolean,
  isLead: (_line: string) => boolean,
): Unit[] {
  const units: Unit[] = [];
  if (heading !== null) units.push({ text: heading, sep: '', kind: 'heading' });
  let blank = false;
  let group: number | undefined;
  const push = (text: string, kind: UnitKind): void => {
    const unit: Unit = { text, sep: blank ? '\n\n' : '\n', kind };
    if (kind === 'item' && group !== undefined) unit.lead = group;
    units.push(unit);
    blank = false;
  };

  let i = 0;
  while (i < body.length) {
    const line = body[i] ?? '';
    if (line.trim() === '') {
      blank = true;
      i += 1;
      continue;
    }
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '```';
      const block = [line];
      i += 1;
      while (i < body.length) {
        const inner = body[i] ?? '';
        block.push(inner);
        i += 1;
        if (FENCE.exec(inner)?.[1] === marker) break;
      }
      push(block.join('\n'), 'para');
      group = undefined;
      continue;
    }
    const stopsContinuation = (candidate: string): boolean =>
      candidate.trim() === '' || isItemStart(candidate) || isLead(candidate) || FENCE.test(candidate);
    if (isItemStart(line)) {
      const item = [line];
      i += 1;
      while (i < body.length && !stopsContinuation(body[i] ?? '')) {
        item.push(body[i] ?? '');
        i += 1;
      }
      push(item.join('\n'), 'item');
      continue;
    }
    if (isLead(line)) {
      push(line, 'lead');
      group = units.length - 1;
      i += 1;
      continue;
    }
    const paragraph = [line];
    i += 1;
    while (i < body.length && !stopsContinuation(body[i] ?? '')) {
      paragraph.push(body[i] ?? '');
      i += 1;
    }
    push(paragraph.join('\n'), 'para');
    group = undefined;
  }
  return units;
}

function chunkClause(span: ClauseSpan, options: LegalChunkOptions, patterns: readonly RegExp[], phrases: readonly string[]): ChunkDraft[] {
  const { label, firstLine } = span;
  const path = [...span.outer, label];
  const headingInUnits = label !== firstLine;
  const isItemStart = (line: string): boolean => ITEM.test(line) || matchClause(line, patterns) !== null;
  const isLead = (line: string): boolean => {
    const normalized = normalize(line);
    return normalized.endsWith(':') && phrases.some((phrase) => normalized.includes(phrase));
  };
  const units = toUnits(headingInUnits ? firstLine : null, span.body, isItemStart, isLead);
  const bodyFirst = units.find((unit) => unit.kind !== 'heading');

  const fits = (content: string): boolean =>
    countTokens(buildEmbeddingText({ section_path: path, content })) <= options.maxTokens;
  const bodyOf = (list: readonly Unit[]): string =>
    list.map((unit, index) => (index === 0 ? unit.text : `${unit.sep}${unit.text}`)).join('');
  const compose = (head: string | null, lead: string | null, body: string, headSep: string): string => {
    let out = head ?? '';
    const add = (part: string, sep: string): void => {
      if (part !== '') out = out === '' ? part : `${out}${sep}${part}`;
    };
    add(lead ?? '', '\n');
    add(body, lead === null ? headSep : '\n');
    return out;
  };
  const composeUnits = (head: string | null, lead: string | null, list: readonly Unit[]): string =>
    compose(head, lead, bodyOf(list), list[0] !== undefined && list[0] === bodyFirst ? bodyFirst.sep : '\n');
  const draft = (content: string): ChunkDraft => ({
    content,
    section_path: path.slice(),
    chunk_kind: 'text',
    page_start: null,
    page_end: null,
    metadata: {},
  });

  const whole = composeUnits(headingInUnits ? null : label, null, units);
  if (fits(whole)) return [draft(whole)];

  const atoms: Unit[][] = [];
  for (let k = 0; k < units.length; k += 1) {
    const unit = units[k];
    const next = units[k + 1];
    if (unit?.kind === 'lead' && next?.kind === 'item' && next.lead === k) {
      atoms.push([unit, next]);
      k += 1;
    } else if (unit) {
      atoms.push([unit]);
    }
  }

  const begin = (atom: Unit[], first: boolean): { head: string | null; lead: string | null } => {
    const firstUnit = atom[0];
    const leadUnit = firstUnit?.kind === 'item' && firstUnit.lead !== undefined ? units[firstUnit.lead] : undefined;
    return { head: first && headingInUnits ? null : label, lead: leadUnit?.text ?? null };
  };

  const splitAtom = (atom: Unit[], head: string | null, lead: string | null): string[] => {
    const first = atom[0];
    let leadText = lead;
    let text = bodyOf(atom);
    const headSep = first !== undefined && first === bodyFirst ? first.sep : '\n';
    if (first?.kind === 'lead' && atom.length === 2) {
      leadText = first.text;
      text = atom[1]?.text ?? '';
    }
    const budgetWith = (leadPart: string | null): number =>
      options.maxTokens - countTokens(buildEmbeddingText({ section_path: path, content: compose(label, leadPart, '', '\n') })) - 2;
    if (leadText !== null && budgetWith(leadText) < MIN_PART_BUDGET) {
      leadText = null;
      text = bodyOf(atom);
    }
    const hardBudget = Math.max(1, budgetWith(leadText));
    const headFor = (n: number): string | null => (n === 0 ? head : label);
    const sepFor = (n: number): string => (n === 0 ? headSep : '\n');

    const out: string[] = [];
    let current = '';
    const emit = (): void => {
      out.push(compose(headFor(out.length), leadText, current, sepFor(out.length)));
      current = '';
    };
    const fitsPart = (body: string): boolean => fits(compose(headFor(out.length), leadText, body, sepFor(out.length)));
    for (const part of text.split(SENTENCE_END).filter((piece) => piece !== '')) {
      const candidate = current === '' ? part : `${current}${CJK_SENTENCE_END.test(current) ? '' : ' '}${part}`;
      if (fitsPart(candidate)) {
        current = candidate;
        continue;
      }
      if (current !== '') emit();
      if (fitsPart(part)) {
        current = part;
        continue;
      }
      const pieces = hardSplit(part, hardBudget);
      pieces.forEach((piece, index) => {
        current = piece;
        if (index < pieces.length - 1) emit();
      });
    }
    if (current !== '') emit();
    return out;
  };

  const pieces: string[] = [];
  let current: { head: string | null; lead: string | null; list: Unit[] } | null = null;
  let first = true;
  const flush = (): void => {
    if (current && current.list.length > 0) pieces.push(composeUnits(current.head, current.lead, current.list));
    current = null;
    first = false;
  };
  for (const atom of atoms) {
    if (current) {
      const trial = [...current.list, ...atom];
      if (fits(composeUnits(current.head, current.lead, trial))) {
        current.list = trial;
        continue;
      }
      flush();
    }
    const { head, lead } = begin(atom, first);
    if (fits(composeUnits(head, lead, atom))) {
      current = { head, lead, list: [...atom] };
      continue;
    }
    pieces.push(...splitAtom(atom, head, lead));
    first = false;
  }
  if (current) flush();
  return pieces.filter((piece) => piece.trim() !== '').map((piece) => draft(piece.trim()));
}

/**
 * Chunks a contract by clause. Chapter headings (第X章 and Markdown headings) form the outer section_path and
 * the clause heading is its last element. A clause that fits max_tokens, measured on the embedding text, is one
 * chunk including an exception lead-in and its list. A longer clause is split at item boundaries; every piece
 * starts with the clause heading and repeats the lead-in when it holds items of that list; a single item that
 * is too long is split at sentence ends. Text outside any clause is chunked as markdown_sections does.
 */
export function chunkLegalClauses(markdown: string, options: LegalChunkOptions): ChunkResult {
  const patterns = compile(options.clause_patterns ?? []);
  const phrases = (options.lead_in_phrases ?? []).map(normalize).filter((phrase) => phrase !== '');
  const labelCap = Math.max(8, Math.floor(options.maxTokens / 4));

  const chunks: ChunkDraft[] = [];
  for (const span of scan(markdown, patterns, labelCap)) {
    if (span.kind === 'text') chunks.push(...chunkSection(span.path, span.lines, options));
    else chunks.push(...chunkClause(span, options, patterns, phrases));
  }
  return { chunks, warnings: [] };
}
