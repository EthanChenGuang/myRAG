export interface PageLines {
  pageCount: number;
  pages: Array<{ page: number; keys: string[] }>;
}

export function lineKey(_text: string): string {
  return '\u0000';
}

export function readPageLines(_raw: unknown): PageLines | null {
  return { pageCount: -1, pages: [] };
}
