import { buildEmbeddingText } from '../text/embedding-text';
import { countTokens } from '../text/tokens';
import type { ChunkDraft, ChunkResult } from '../types';
import { chunkSection, splitSections, type MarkdownChunkOptions } from './markdown-sections';
import { splitTableBlocks, type TableBlock } from './markdown-tables';

/** A piece of a section that is packed into chunks as a whole. */
export interface Segment {
  text: string;
  table: boolean;
  /** A piece of a table that had to be split; it keeps its own chunk so it starts with the header. */
  solo: boolean;
}

export function tableSegments(
  block: TableBlock,
  fits: (_content: string) => boolean,
  repeatHeader: boolean,
  warnings: Set<string>,
): Segment[] {
  const { header, rows } = block;
  const whole = [...(header === null ? [] : [header]), ...rows].join('\n');
  if (rows.length === 0 || fits(whole)) return [{ text: whole, table: true, solo: false }];

  const pieces: string[] = [];
  let lead = header ?? '';
  let body: string[] = [];
  const render = (list: string[]): string => (lead === '' ? list : [lead, ...list]).join('\n');
  const emit = (): void => {
    pieces.push(render(body));
    body = [];
    lead = repeatHeader ? (header ?? '') : '';
  };

  for (const row of rows) {
    if (body.length > 0 && !fits(render([...body, row]))) emit();
    body.push(row);
    if (body.length === 1 && !fits(render(body))) {
      warnings.add('oversized_table_row');
      emit();
    }
  }
  if (body.length > 0) emit();
  return pieces.map((text) => ({ text, table: true, solo: true }));
}

/** Chunks the body lines of one section: tables by rows under their header, text as markdown_sections does. */
export function chunkTableSection(
  path: string[],
  lines: readonly string[],
  options: MarkdownChunkOptions,
  warnings: Set<string>,
): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  const fits = (content: string): boolean =>
    countTokens(buildEmbeddingText({ section_path: path, content })) <= options.maxTokens;

  const segments: Segment[] = [];
  for (const block of splitTableBlocks(lines)) {
    if (block.kind === 'table') {
      segments.push(...tableSegments(block, fits, options.repeatTableHeader, warnings));
      continue;
    }
    for (const draft of chunkSection(path, block.lines, options)) {
      segments.push({ text: draft.content, table: false, solo: false });
    }
  }

  let current: Segment[] = [];
  const flush = (): void => {
    const content = current.map((segment) => segment.text).join('\n\n').trim();
    if (content !== '') {
      chunks.push({
        content,
        section_path: path.slice(),
        chunk_kind: current.every((segment) => segment.table) ? 'table' : 'text',
        page_start: null,
        page_end: null,
        metadata: {},
      });
    }
    current = [];
  };
  for (const segment of segments) {
    const last = current[current.length - 1];
    const mergeable = last !== undefined && !last.solo && !segment.solo && (last.table || segment.table);
    if (mergeable && fits([...current, segment].map((part) => part.text).join('\n\n'))) {
      current.push(segment);
      continue;
    }
    flush();
    current = [segment];
  }
  flush();
  return chunks;
}

/**
 * Chunks Markdown so that a table row is never cut. A table that fits the budget stays whole and may share a
 * chunk with the paragraphs around it; a larger table is split by rows and every piece starts with the header
 * and separator rows (when the profile repeats headers). Text outside tables is chunked as markdown_sections
 * does, and overlap applies to that text only.
 */
export function chunkTableAware(markdown: string, options: MarkdownChunkOptions): ChunkResult {
  const chunks: ChunkDraft[] = [];
  const warnings = new Set<string>();
  for (const section of splitSections(markdown)) chunks.push(...chunkTableSection(section.path, section.lines, options, warnings));
  return { chunks, warnings: [...warnings] };
}
