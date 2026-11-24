export interface TableBlock {
  kind: 'table';
  header: string | null;
  rows: string[];
}

export interface TextBlock {
  kind: 'text';
  lines: string[];
}

export type MarkdownBlock = TableBlock | TextBlock;

export function splitTableBlocks(lines: readonly string[]): MarkdownBlock[] {
  return lines.length === 0 ? [] : [];
}
