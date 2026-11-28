'use client';

import { useRef, useState } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/components/providers/language-provider';
import { useGhostModeStore } from '@/lib/ghost-mode-store';
import {
  isRefusalControlHidden,
  isTraceId,
  postRefusalFeedback,
  REFUSAL_REASONS,
  refusalRequestFor,
  type RefusalControlAction,
} from '@/lib/chat/refusal-feedback-client';
import type { RefusalFeedbackValue, RefusalReason, RefusalVote } from '@/lib/chat/answer-metadata';
import type { RefusalFeedbackRequest } from '@/lib/rag-eval/contracts.generated';
import { answerQualityStrings } from '@/translations/answer-quality';

const PILL_STATE = {
  off: 'bg-transparent text-gray-700 ring-gray-300 hover:bg-[#FFE0D0] dark:text-gray-300 dark:ring-[#4A4A4A] dark:hover:bg-[#424242]',
  on: 'bg-[#FF6417]/15 text-[#A63F0A] ring-[#FF6417]/50 hover:bg-[#FF6417]/20 dark:bg-[#FF8A4D]/20 dark:text-[#FFB48A] dark:ring-[#FF8A4D]/50 dark:hover:bg-[#FF8A4D]/25',
};
const PILL_MOTION_FOCUS =
  'ring-1 ring-inset transition-colors duration-150 motion-reduce:transition-none touch-manipulation ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6417]/60 aria-disabled:cursor-wait';
const CHOICE =
  'relative inline-flex min-h-8 max-w-full items-center gap-1 break-words rounded-full px-4 py-1 text-left text-sm font-medium ' + PILL_MOTION_FOCUS;
const CHIP = 'relative inline-flex max-w-full items-center gap-1 break-words after:absolute after:-inset-1 rounded-full px-2 py-1 text-xs font-medium ' + PILL_MOTION_FOCUS;

export interface RefusalFeedbackProps {
  traceId: string;
  initial: RefusalFeedbackValue | null;
  onSaved?: (value: RefusalFeedbackValue) => void;
  focusFallback?: () => void;
  className?: string;
}

/** D-08: under an "information not available" or "knowledge base unavailable" message, asks whether an answer was expected. */
export function RefusalFeedback({ traceId, initial, onSaved, focusFallback, className }: RefusalFeedbackProps) {
  const { language } = useLanguage();
  const strings = answerQualityStrings(language);
  const isGhostMode = useGhostModeStore((s) => s.isGhostMode);
  const [saved, setSaved] = useState<RefusalFeedbackValue | null>(initial);
  const [pending, setPending] = useState<RefusalFeedbackRequest | null>(null);
  const [failed, setFailed] = useState<RefusalFeedbackRequest | null>(null);
  const [hidden, setHidden] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  if (isGhostMode || hidden || !isTraceId(traceId) || isRefusalControlHidden(traceId)) return null;

  const shown: { vote: RefusalVote; reasons: RefusalReason[] } | null = pending
    ? { vote: pending.vote, reasons: pending.reasons ?? [] }
    : saved;
  const busy = pending !== null;

  // A chip or the retry line can disappear under keyboard focus; focus then stays on the chosen choice, never on the page body.
  const keepFocusInside = () => {
    if (!rootRef.current?.contains(document.activeElement)) return;
    setTimeout(() => {
      const root = rootRef.current;
      if (!root || root.contains(document.activeElement)) return;
      const group = root.querySelector('[role="group"]');
      (group?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ?? group?.querySelector<HTMLButtonElement>('button'))?.focus();
    }, 0);
  };

  const send = async (request: RefusalFeedbackRequest) => {
    setPending(request);
    setAnnouncement('');
    const result = await postRefusalFeedback(traceId, request);
    setPending(null);
    if (result.ok) {
      keepFocusInside();
      setFailed(null);
      setSaved(result.feedback);
      setAnnouncement(strings.feedbackSaved);
      onSaved?.(result.feedback);
      return;
    }
    if ('hidden' in result) {
      const hadFocus = Boolean(rootRef.current?.contains(document.activeElement));
      setHidden(true);
      if (hadFocus) focusFallback?.();
      return;
    }
    keepFocusInside();
    setFailed(request);
    setAnnouncement(strings.refusalFailed);
  };

  const act = (action: RefusalControlAction) => {
    if (busy) return;
    const request = refusalRequestFor(saved, action);
    if (request) void send(request);
  };

  const choice = (vote: RefusalVote, label: string) => {
    const chosen = shown?.vote === vote;
    const spinning = chosen && pending?.vote === vote;
    return (
      <button
        type="button"
        aria-pressed={chosen}
        aria-disabled={busy || undefined}
        onClick={() => act({ type: 'vote', vote })}
        className={cn(CHOICE, chosen ? PILL_STATE.on : PILL_STATE.off)}
      >
        {spinning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          chosen && <Check className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {label}
      </button>
    );
  };

  return (
    <div ref={rootRef} className={cn('mt-2 flex flex-col gap-2', className)} data-refusal-feedback="">
      <div className="flex flex-wrap gap-2" role="group" aria-label={strings.refusalGroupLabel}>
        {choice('expected_answer', strings.refusalExpectedAnswer)}
        {choice('correct_refusal', strings.refusalCorrect)}
      </div>
      {shown?.vote === 'expected_answer' && (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-gray-700 dark:text-gray-300">{strings.feedbackReasonHeading}</legend>
          <div className="flex flex-wrap gap-2">
            {REFUSAL_REASONS.map((reason) => {
              const chosen = shown.reasons.includes(reason);
              return (
                <button
                  key={reason}
                  type="button"
                  aria-pressed={chosen}
                  aria-disabled={busy || undefined}
                  onClick={() => act({ type: 'reason', reason })}
                  className={cn(CHIP, chosen ? PILL_STATE.on : PILL_STATE.off)}
                >
                  {chosen && <Check className="h-3 w-3" aria-hidden="true" />}
                  {strings.refusalReasons[reason]}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
      {failed && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-red-700 dark:text-red-300">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{strings.refusalFailed}</span>
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) void send(failed);
            }}
            className="relative font-medium underline underline-offset-2 touch-manipulation rounded-sm hover:text-red-800 dark:hover:text-red-200 after:absolute after:-inset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6417]/60 aria-disabled:cursor-wait"
          >
            {strings.refusalRetry}
          </button>
        </p>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
