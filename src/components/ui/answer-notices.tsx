'use client';

import { Calculator, Info, Scissors, ShieldAlert, ShieldX, type LucideIcon } from 'lucide-react';
import type { AnswerNotice } from '@/lib/rag-eval/contracts.generated';
import { cn } from '@/lib/utils';

type NoticeTone = 'neutral' | 'caution' | 'blocked';

/** UI-SPEC 13.1: neutral and caution are the groundedness badge's sets, so notices and badge match. */
const TONE_CLASSES: Record<NoticeTone, string> = {
  neutral: 'bg-gray-100 text-gray-700 ring-gray-200 dark:bg-[#2A2A2A] dark:text-gray-300 dark:ring-[#3A3A3A]',
  caution: 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  blocked: 'bg-red-50 text-red-900 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900',
};

const KNOWN_KINDS: Readonly<Record<string, { icon: LucideIcon; tone: NoticeTone; order: number }>> = {
  credential_request_blocked: { icon: ShieldX, tone: 'blocked', order: 1 },
  credential_request_warning: { icon: ShieldAlert, tone: 'caution', order: 2 },
  calc_corrected: { icon: Calculator, tone: 'caution', order: 3 },
  calc_not_verified: { icon: Calculator, tone: 'neutral', order: 4 },
  answer_truncated: { icon: Scissors, tone: 'neutral', order: 5 },
};

const UNKNOWN_KIND = { icon: Info, tone: 'neutral' as NoticeTone, order: 6 };

function styleOf(kind: string) {
  return Object.prototype.hasOwnProperty.call(KNOWN_KINDS, kind) ? KNOWN_KINDS[kind]! : UNKNOWN_KIND;
}

/** UI-SPEC 6.4: known kinds in their fixed order, unknown kinds after them in arrival order, exact duplicates once. */
export function orderNotices(notices: readonly AnswerNotice[]): AnswerNotice[] {
  const seen = new Set<string>();
  const unique = notices.filter((notice) => {
    if (!notice || typeof notice.text !== 'string' || notice.text.length === 0) return false;
    const key = `${notice.kind}\u0000${notice.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique
    .map((notice, arrival) => ({ notice, arrival, order: styleOf(notice.kind).order }))
    .sort((a, b) => a.order - b.order || a.arrival - b.arrival)
    .map(({ notice }) => notice);
}

export interface AnswerNoticesProps {
  notices: readonly AnswerNotice[];
  className?: string;
}

/** D-11, D-56 (UI-SPEC 6.4): the server's notices under an answer, each as icon plus the server's text; nothing when there is none. */
export function AnswerNotices({ notices, className }: AnswerNoticesProps) {
  const ordered = orderNotices(notices);
  if (ordered.length === 0) return null;
  return (
    <div data-answer-notices="" aria-live="polite" className={cn('mt-2 space-y-2', className)}>
      {ordered.map((notice, index) => {
        const { icon: Icon, tone } = styleOf(notice.kind);
        return (
          <div
            key={`${notice.kind}-${index}`}
            role="note"
            data-answer-notice={notice.kind}
            lang={notice.language}
            className={cn('flex items-start gap-2 rounded-lg p-2 text-sm ring-1 ring-inset break-words', TONE_CLASSES[tone])}
          >
            <span className="inline-flex h-5 shrink-0 items-center">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <p className="min-w-0">{notice.text}</p>
          </div>
        );
      })}
    </div>
  );
}
