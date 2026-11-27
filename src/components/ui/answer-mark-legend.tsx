'use client';

import { useEffect, useState } from 'react';
import type { SentenceMarkKind } from '@/lib/chat/sentence-marks';
import { SentenceMarkGlyph } from './sentence-mark';

export type MarkCounts = Readonly<Record<SentenceMarkKind, number>>;
export type MarkTexts = Readonly<Record<SentenceMarkKind, string>>;

export interface AnswerMarkLegendProps {
  counts: MarkCounts;
  texts: MarkTexts;
  /** The answer language; set as lang only when it differs from the UI language. */
  language: string;
  uiLanguage: string;
  /** True for an answer that finished in this session; a reopened chat announces nothing. */
  live?: boolean;
}

const KINDS: readonly SentenceMarkKind[] = ['uncited', 'unsupported'];

/** `{text}: {n}`, with the full-width colon in zh (UI-SPEC 6.3); no plural form is needed. */
export function legendItemText(text: string, count: number, language: string): string {
  let shown = String(count);
  try {
    shown = new Intl.NumberFormat(language).format(count);
  } catch {
    // An unknown language tag keeps the plain digits.
  }
  return language.toLowerCase().startsWith('zh') ? `${text}：${shown}` : `${text}: ${shown}`;
}

/** The items that appeared after the first render, for the polite status region; '' when none did. */
export function legendAnnouncement(initial: MarkCounts, current: MarkCounts, texts: MarkTexts, language: string): string {
  return KINDS.filter((kind) => initial[kind] <= 0 && current[kind] > 0 && texts[kind])
    .map((kind) => legendItemText(texts[kind], current[kind], language))
    .join(' ');
}

/** GEN-09, GEN-10 (UI-SPEC 6.3): one line under the answer naming and counting the marks; nothing when no mark shows. */
export function AnswerMarkLegend({ counts, texts, language, uiLanguage, live = false }: AnswerMarkLegendProps) {
  const [initial] = useState<MarkCounts>(counts);
  const [announcement, setAnnouncement] = useState('');
  const uncited = counts.uncited;
  const unsupported = counts.unsupported;
  const uncitedText = texts.uncited;
  const unsupportedText = texts.unsupported;

  useEffect(() => {
    if (!live) return;
    const current = { uncited, unsupported };
    setAnnouncement(legendAnnouncement(initial, current, { uncited: uncitedText, unsupported: unsupportedText }, language));
  }, [live, initial, uncited, unsupported, uncitedText, unsupportedText, language]);

  const items = KINDS.filter((kind) => counts[kind] > 0 && texts[kind]);
  if (items.length === 0) return null;

  return (
    <div
      data-mark-legend=""
      lang={language !== uiLanguage ? language : undefined}
      className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400"
    >
      {items.map((kind) => (
        <span key={kind} data-mark-legend-item={kind} className="inline-flex items-center gap-1 tabular-nums">
          <SentenceMarkGlyph kind={kind} />
          {legendItemText(texts[kind], counts[kind], language)}
        </span>
      ))}
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
    </div>
  );
}
