'use client';

type Counts = { uncited: number; unsupported: number };
type Texts = { uncited: string; unsupported: string };

export function legendItemText(_text: string, _count: number, _language: string): string {
  return '';
}
export function legendAnnouncement(_initial: Counts, _current: Counts, _texts: Texts, _language: string): string {
  return 'x';
}
export function AnswerMarkLegend(_props: { counts: Counts; texts: Texts; language: string; uiLanguage: string; live?: boolean }) {
  return null;
}
