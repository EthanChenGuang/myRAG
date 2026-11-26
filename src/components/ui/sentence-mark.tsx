'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SentenceMarkKind } from '@/lib/chat/sentence-marks';
import { ANSWER_TOOLTIP_CONTENT_CLASSES } from './groundedness-badge';

export interface SentenceMarkProps {
  kind: SentenceMarkKind;
  index: number;
  /** The registry text (notices.uncited or notices.not_confirmed) in the answer language. */
  text: string;
  /** The answer language; set as lang only when it differs from the UI language. */
  lang?: string;
  uiLanguage?: string;
}

/** The mark's glyph: a dashed empty circle (uncited) or the amber triangle (unsupported). Shape carries the meaning, not colour. */
export function SentenceMarkGlyph({ kind, className }: { kind: SentenceMarkKind; className?: string }) {
  if (kind === 'uncited') {
    return (
      <span
        aria-hidden="true"
        className={cn('inline-flex h-4 w-4 shrink-0 rounded-full border border-dashed border-gray-500 dark:border-gray-400', className)}
      />
    );
  }
  return (
    <span aria-hidden="true" className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center', className)}>
      <AlertTriangle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300" aria-hidden="true" />
    </span>
  );
}

/** GEN-09, GEN-10 (UI-SPEC 6.2): a 16px superscript mark in the citation slot; focus or hover shows the registry text. No click action. */
export function SentenceMark({ kind, index, text, lang, uiLanguage }: SentenceMarkProps) {
  if (!text) return null;
  const langAttr = lang && lang !== uiLanguage ? lang : undefined;
  return (
    <sup className="ml-1 align-super leading-none">
      <TooltipPrimitive.Provider delayDuration={200}>
        <TooltipPrimitive.Root>
          <TooltipPrimitive.Trigger asChild>
            <span
              tabIndex={0}
              data-sentence-mark={kind}
              data-sentence-index={index}
              lang={langAttr}
              className={cn(
                'relative inline-flex h-4 w-4 items-center justify-center rounded-full',
                'cursor-default touch-manipulation after:absolute after:-inset-2',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6417]/60',
              )}
            >
              <SentenceMarkGlyph kind={kind} />
              <span className="sr-only">{text}</span>
            </span>
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content side="top" sideOffset={8} collisionPadding={16} lang={langAttr} className={ANSWER_TOOLTIP_CONTENT_CLASSES}>
              {text}
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
      </TooltipPrimitive.Provider>
    </sup>
  );
}
