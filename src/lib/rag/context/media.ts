export interface MediaContextRow {
  document_id: string;
  content: string;
  similarity: number;
}

export function formatImageContext(_rows: MediaContextRow[]): string {
  return '';
}

export function formatVideoContext(_rows: MediaContextRow[]): string {
  return '';
}
