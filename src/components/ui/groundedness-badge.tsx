'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { AlertTriangle, CircleDashed, ShieldCheck } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/components/providers/language-provider';
import { groundednessBadgeState, type GroundednessBadgeState } from '@/lib/chat/badge-state';
import type { AnswerGroundedness } from '@/lib/chat/answer-metadata';
import { useAnswerRecordsStore } from '@/lib/stores/answer-records-store';
import { answerQualityStrings } from '@/translations/answer-quality';

export interface GroundednessBadgeProps {
  answerId: string;
  /** The message metadata copy, used when no record is loaded (shared chats). */
  fallback?: AnswerGroundedness;
  className?: string;
}

const STATE_STYLES: Record<GroundednessBadgeState, string> = {
  verified: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
  possibly_unreliable: 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  not_checked: 'bg-gray-100 text-gray-700 ring-gray-200 dark:bg-[#2A2A2A] dark:text-gray-300 dark:ring-[#3A3A3A]',
};

const STATE_ICONS = {
  verified: ShieldCheck,
  possibly_unreliable: AlertTriangle,
  not_checked: CircleDashed,
} as const;

/** D-20: the three-state groundedness pill with a one-sentence tooltip. Renders nothing when the rule hides it. */
export function GroundednessBadge({ answerId, fallback, className }: GroundednessBadgeProps) {
  const { language } = useLanguage();
  const { status, label, reason, ragMode, hasRecord } = useAnswerRecordsStore(
    useShallow((s) => {
      const record = Object.prototype.hasOwnProperty.call(s.records, answerId) ? s.records[answerId] : undefined;
      const source = record?.groundedness ?? fallback;
      return {
        status: source?.status,
        label: source?.label ?? null,
        reason: source?.reason ?? null,
        ragMode: record?.ragMode ?? null,
        hasRecord: record !== undefined,
      };
    }),
  );
  const state = groundednessBadgeState(status ? { status, label, reason } : null, hasRecord ? ragMode : null);
  if (!state) return null;

  const strings = answerQualityStrings(language);
  const Icon = STATE_ICONS[state];
  const text = strings.badgeLabels[state];
  const tooltip = strings.badgeTooltips[state];

  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <span
            tabIndex={0}
            data-groundedness-badge={state}
            className={cn(
              'inline-flex h-6 shrink-0 select-none whitespace-nowrap items-center gap-1 rounded-full px-2 text-xs font-medium ring-1 ring-inset',
              'cursor-default touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6417]/60',
              STATE_STYLES[state],
              className,
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{text}</span>
            <span className="sr-only">: {tooltip}</span>
          </span>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="bottom"
            sideOffset={6}
            collisionPadding={12}
            className={cn(
              'z-[99999] max-w-64 rounded-md px-2.5 py-1.5 text-xs leading-snug text-pretty shadow-md',
              'bg-gray-900 text-white dark:bg-[#1A1A1A] dark:text-[#E6E6E6] dark:ring-1 dark:ring-[#3A3A3A]',
            )}
          >
            {tooltip}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
