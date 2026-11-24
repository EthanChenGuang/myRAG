import { buildEmbeddingText } from '../text/embedding-text';
import { countTokens } from '../text/tokens';
import type { ChunkDraft, ChunkResult } from '../types';
import { chunkSection, splitSections, type MarkdownChunkOptions } from './markdown-sections';
import { splitTableBlocks, type MarkdownBlock, type TableBlock } from './markdown-tables';
import { chunkTableSection, tableSegments } from './table-aware';

const draft = (path: string[], content: string, kind: ChunkDraft['chunk_kind']): ChunkDraft => ({
  content,
  section_path: path.slice(),
  chunk_kind: kind,
  page_start: null,
  page_end: null,
  metadata: {},
});

const tableText = (block: TableBlock): string => [...(block.header === null ? [] : [block.header]), ...block.rows].join('\n');

function blockLines(blocks: readonly MarkdownBlock[]): string[] {
  return blocks.flatMap((block) => (block.kind === 'text' ? block.lines : [...(block.header === null ? [] : block.header.split('\n')), ...block.rows]));
}

const trimBlankEdges = (lines: readonly string[]): string[] => {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start += 1;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return lines.slice(start, end);
};

/**
 * Chunks an invoice. In the first section that holds a table, the header block before the table and the line-item table (with its
 * header row) form one invoice_header chunk when they fit the budget. A table too large for that is split by rows under its repeated
 * header (kind table) and the header block keeps a chunk of its own. Everything else follows the table-aware rules, so text after the
 * table is chunked as markdown_sections does.
 */
export function chunkInvoice(markdown: string, options: MarkdownChunkOptions): ChunkResult {
  const chunks: ChunkDraft[] = [];
  const warnings = new Set<string>();
  let headerDone = false;

  for (const section of splitSections(markdown)) {
    const path = section.path;
    const blocks = splitTableBlocks(section.lines);
    const tableIndex = blocks.findIndex((block) => block.kind === 'table');
    const lead = tableIndex > 0 ? trimBlankEdges(blockLines(blocks.slice(0, tableIndex))) : [];
    if (headerDone || tableIndex < 0 || lead.length === 0) {
      chunks.push(...chunkTableSection(path, section.lines, options, warnings));
      continue;
    }
    headerDone = true;

    const fits = (content: string): boolean => countTokens(buildEmbeddingText({ section_path: path, content })) <= options.maxTokens;
    const table = blocks[tableIndex] as TableBlock;
    const leadText = lead.join('\n');
    const whole = `${leadText}\n\n${tableText(table)}`;

    if (fits(whole)) {
      chunks.push(draft(path, whole, 'invoice_header'));
    } else {
      if (fits(leadText)) chunks.push(draft(path, leadText, 'invoice_header'));
      else for (const piece of chunkSection(path, lead, options)) chunks.push(draft(path, piece.content, 'text'));
      for (const segment of tableSegments(table, fits, options.repeatTableHeader, warnings)) chunks.push(draft(path, segment.text, 'table'));
    }
    chunks.push(...chunkTableSection(path, blockLines(blocks.slice(tableIndex + 1)), options, warnings));
  }
  return { chunks, warnings: [...warnings] };
}
