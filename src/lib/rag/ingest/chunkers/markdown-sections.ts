import {
  CJK_SENTENCE_END,
  SENTENCE_END,
  hardSplit,
  legacyBlockSplitter,
  legacySplitter,
  packPieces,
  type BlockSplitter,
} from '@/lib/rag/lang/sentences';
import { buildEmbeddingText } from '../text/embedding-text';
import { countTokens } from '../text/tokens';
import type { ChunkDraft } from '../types';

export { CJK_SENTENCE_END, SENTENCE_END, hardSplit };

export interface MarkdownChunkOptions {
  maxTokens: number;
  overlapTokens: number;
  minChunkTokens: number;
  repeatTableHeader: boolean;
  /** The sentence splitter of each over-long block (D-15); the legacy shared set when absent. */
  sentences?: BlockSplitter;
}

type UnitKind = 'paragraph' | 'list' | 'fence' | 'row';

interface Unit {
  text: string;
  kind: UnitKind;
  /** Separator that precedes this unit when it follows another one. */
  sep: string;
  /** Header and separator rows of the table this row belongs to. */
  tableHeader?: string;
}

export interface Section {
  path: string[];
  lines: string[];
}

interface PackedChunk {
  units: Unit[];
  newStart: number;
}

export const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
export const FENCE = /^ {0,3}(```|~~~)/;
const LIST_ITEM = /^ {0,6}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const MAX_ATOMIC_TOKENS = 4000;

const isTableRow = (line: string): boolean => line.trim().startsWith('|');

export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [{ path: [], lines: [] }];
  const stack: Array<{ level: number; title: string }> = [];
  let fence: string | null = null;

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '```';
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    }
    const heading = fence === null && !fenceMatch ? HEADING.exec(line) : null;
    const title = heading ? (heading[2] ?? '').trim() : '';
    if (heading && title !== '') {
      const level = (heading[1] ?? '#').length;
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      stack.push({ level, title });
      sections.push({ path: stack.map((entry) => entry.title), lines: [] });
      continue;
    }
    if (heading) continue;
    sections[sections.length - 1]?.lines.push(line);
  }
  return sections;
}

function toUnits(lines: string[]): Unit[] {
  const units: Unit[] = [];
  let blankBefore = false;
  let i = 0;

  const separator = (): string => (units.length === 0 ? '' : blankBefore ? '\n\n' : '\n');
  const push = (text: string, kind: UnitKind, tableHeader?: string): void => {
    const unit: Unit = { text, kind, sep: separator() };
    if (tableHeader !== undefined) unit.tableHeader = tableHeader;
    units.push(unit);
    blankBefore = false;
  };
  const startsBlock = (line: string): boolean => FENCE.test(line) || isTableRow(line) || LIST_ITEM.test(line);

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      blankBefore = true;
      i += 1;
      continue;
    }
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '```';
      const block = [line];
      i += 1;
      while (i < lines.length) {
        const inner = lines[i] ?? '';
        block.push(inner);
        i += 1;
        if (FENCE.exec(inner)?.[1] === marker) break;
      }
      push(block.join('\n'), 'fence');
      continue;
    }
    if (isTableRow(line)) {
      const rows: string[] = [];
      while (i < lines.length && isTableRow(lines[i] ?? '')) {
        rows.push(lines[i] ?? '');
        i += 1;
      }
      const hasHeader = rows.length >= 2 && TABLE_SEPARATOR.test(rows[1] ?? '');
      const header = hasHeader ? `${rows[0]}\n${rows[1]}` : undefined;
      const body = hasHeader ? rows.slice(2) : rows;
      if (header !== undefined) {
        // The header travels with the first body row so a chunk never ends on a header alone.
        const first = body.shift();
        push(first === undefined ? header : `${header}\n${first}`, 'row', header);
      }
      for (const row of body) push(row, 'row', header);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const item = [line];
      i += 1;
      while (i < lines.length && (lines[i] ?? '').trim() !== '' && !startsBlock(lines[i] ?? '')) {
        item.push(lines[i] ?? '');
        i += 1;
      }
      push(item.join('\n'), 'list');
      continue;
    }
    const paragraph = [line];
    i += 1;
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !startsBlock(lines[i] ?? '')) {
      paragraph.push(lines[i] ?? '');
      i += 1;
    }
    push(paragraph.join('\n'), 'paragraph');
  }
  return units;
}

export function chunkMarkdownSections(markdown: string, options: MarkdownChunkOptions): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  for (const section of splitSections(markdown)) drafts.push(...chunkSection(section.path, section.lines, options));
  return drafts;
}

/** Chunks the body lines of one section under a fixed section path. */
export function chunkSection(path: string[], lines: string[], options: MarkdownChunkOptions): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  const units = toUnits(lines);
  if (units.length === 0) return drafts;
  const prefixTokens = countTokens(buildEmbeddingText({ section_path: path, content: '' }));
  const contentBudget = Math.max(1, options.maxTokens - prefixTokens);
  const sentencesOf = options.sentences ?? legacyBlockSplitter;

  const render = (list: Unit[]): string => {
    let out = '';
    list.forEach((unit, index) => {
      out += index === 0 ? unit.text : `${unit.sep}${unit.text}`;
    });
    const first = list[0];
    if (options.repeatTableHeader && first?.tableHeader !== undefined && !first.text.startsWith(first.tableHeader)) {
      out = `${first.tableHeader}\n${out}`;
    }
    return out;
  };
  const fits = (list: Unit[]): boolean =>
    countTokens(buildEmbeddingText({ section_path: path, content: render(list) })) <= options.maxTokens;

  const expand = (unit: Unit): Unit[] => {
    if (fits([unit])) return [unit];
    const tokens = countTokens(unit.text);
    if ((unit.kind === 'list' || unit.kind === 'row') && tokens <= MAX_ATOMIC_TOKENS) return [unit];
    const splitter = unit.kind === 'paragraph' ? sentencesOf(unit.text) : null;
    const parts =
      unit.kind === 'fence' ? unit.text.split('\n') : splitter !== null ? splitter.split(unit.text) : [unit.text];
    const join = unit.kind === 'fence' ? (): string => '\n' : (splitter ?? legacySplitter).join;
    const cut = splitter?.hardSplit ?? hardSplit;
    return packPieces(parts, join, cut, contentBudget).map((piece, index) => ({
      text: piece.text,
      kind: unit.kind,
      sep: index === 0 ? unit.sep : piece.sep,
    }));
  };

  const packed: PackedChunk[] = [];
  let current: Unit[] = [];
  let newStart = 0;
  for (const unit of units.flatMap(expand)) {
    if (current.length === 0) {
      current = [unit];
      newStart = 0;
      continue;
    }
    if (fits([...current, unit])) {
      current.push(unit);
      continue;
    }
    packed.push({ units: current, newStart });
    let overlap: Unit[] = [];
    if (options.overlapTokens > 0) {
      for (let k = current.length - 1; k > newStart - 1 && k >= 0; k -= 1) {
        const candidate = current.slice(k);
        if (countTokens(render(candidate)) > options.overlapTokens) break;
        overlap = candidate;
      }
      if (overlap.length === current.length) overlap = overlap.slice(1);
    }
    if (overlap.length > 0 && !fits([...overlap, unit])) overlap = [];
    current = [...overlap, unit];
    newStart = overlap.length;
  }
  if (current.length > 0) packed.push({ units: current, newStart });

  const last = packed[packed.length - 1];
  const before = packed[packed.length - 2];
  if (last && before && countTokens(render(last.units.slice(last.newStart))) < options.minChunkTokens) {
    const merged = [...before.units, ...last.units.slice(last.newStart)];
    if (fits(merged)) {
      packed.splice(packed.length - 2, 2, { units: merged, newStart: before.newStart });
    }
  }

  for (const chunk of packed) {
    const content = render(chunk.units).trim();
    if (content === '') continue;
    const added = chunk.units.slice(chunk.newStart);
    drafts.push({
      content,
      section_path: path.slice(),
      chunk_kind: added.length > 0 && added.every((unit) => unit.kind === 'row') ? 'table' : 'text',
      page_start: null,
      page_end: null,
      metadata: {},
    });
  }
  return drafts;
}
