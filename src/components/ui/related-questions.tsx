'use client';

import { useId } from 'react';
import { CornerDownRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface RelatedQuestionsProps {
  questions: readonly string[];
  heading: string;
  onSelect?: (question: string) => void;
  disabled?: boolean;
  className?: string;
}

const ROW_CLASSES =
  'flex w-full min-h-[44px] min-w-0 items-center gap-3 px-2 py-2.5 text-left text-[0.95rem] leading-snug text-gray-800 dark:text-gray-200';

export function RelatedQuestions({ questions, heading, onSelect, disabled = false, className }: RelatedQuestionsProps) {
  const headingId = useId();
  if (questions.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className={cn('mt-4 border-t border-black/10 pt-3 dark:border-white/10', className)} data-related-questions="">
      <p id={headingId} className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {heading}
      </p>
      <ul className="divide-y divide-black/5 dark:divide-white/5">
        {questions.map((question, index) => (
          <li key={`${index}-${question}`}>
            {onSelect ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect(question)}
                data-related-question=""
                className={cn(
                  ROW_CLASSES,
                  'group rounded-lg touch-manipulation transition-colors',
                  'hover:bg-black/5 hover:text-gray-950 dark:hover:bg-white/5 dark:hover:text-white',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6417] focus-visible:ring-offset-0',
                  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                )}
              >
                <CornerDownRight
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-gray-400 transition-colors group-hover:text-[#FF6417] group-focus-visible:text-[#FF6417] dark:text-gray-500"
                />
                <span className="min-w-0 flex-1 break-words">{question}</span>
              </button>
            ) : (
              <div className={ROW_CLASSES}>
                <CornerDownRight aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
                <span className="min-w-0 flex-1 break-words">{question}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
