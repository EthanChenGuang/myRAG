'use client';

import { useId, useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Loader2, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/components/providers/language-provider';
import { FEEDBACK_COMMENT_MAX, submitAnswerFeedback } from '@/lib/chat/answer-feedback-client';
import { useAnswerRecordsStore } from '@/lib/stores/answer-records-store';
import type { AnswerFeedbackRequest } from '@/lib/rag-eval/contracts.generated';
import { answerQualityStrings } from '@/translations/answer-quality';

type Vote = AnswerFeedbackRequest['vote'];
type Reason = NonNullable<AnswerFeedbackRequest['reasons']>[number];

const REASONS: Reason[] = ['wrong', 'incomplete', 'not_from_documents', 'bad_citation'];

const VOTE_BUTTON =
  'flex h-8 w-8 items-center justify-center rounded-md text-gray-700 dark:text-gray-400 transition-colors duration-150 motion-reduce:transition-none ' +
  'hover:bg-[#FFE0D0] hover:text-gray-900 dark:hover:bg-[#424242] dark:hover:text-gray-200 touch-manipulation ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6417]/60 disabled:cursor-wait';

export interface AnswerFeedbackProps {
  answerId: string;
  className?: string;
}

/** D-18: thumbs up and down for a recorded answer; not helpful opens optional reasons. Hidden unless the record says feedback is enabled. */
export function AnswerFeedback({ answerId, className }: AnswerFeedbackProps) {
  const { language } = useLanguage();
  const strings = answerQualityStrings(language);
  const { enabled, feedback, chatId } = useAnswerRecordsStore(
    useShallow((s) => {
      const record = Object.prototype.hasOwnProperty.call(s.records, answerId) ? s.records[answerId] : undefined;
      return { enabled: record?.feedbackEnabled === true, feedback: record?.feedback ?? null, chatId: record?.chatId ?? null };
    }),
  );
  const [open, setOpen] = useState(false);
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const commentId = useId();
  const statusId = useId();

  if (!enabled) return null;
  const vote = feedback?.vote ?? null;

  const send = async (next: Vote, withReasons: Reason[], withComment: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await submitAnswerFeedback(answerId, {
      vote: next,
      reasons: next === 'not_helpful' ? withReasons : [],
      comment: next === 'not_helpful' && withComment.trim() ? withComment : null,
      chatId,
    });
    setBusy(false);
    if (!result.ok) setError(strings.feedbackFailed);
    return result.ok;
  };

  const onHelpful = () => {
    setOpen(false);
    if (vote !== 'helpful') void send('helpful', [], '');
  };

  const onNotHelpful = () => {
    const keep = vote === 'not_helpful' && feedback;
    setReasons(keep ? [...(feedback.reasons ?? [])] : []);
    setComment(keep ? feedback.comment ?? '' : '');
    setSaved(false);
    setError(null);
    setOpen(true);
    if (vote !== 'not_helpful') void send('not_helpful', [], '');
  };

  const toggleReason = (reason: Reason) => {
    setReasons((current) => (current.includes(reason) ? current.filter((r) => r !== reason) : [...current, reason]));
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await send('not_helpful', reasons, comment)) {
      setSaved(true);
      setOpen(false);
    }
  };

  const left = FEEDBACK_COMMENT_MAX - comment.length;

  return (
    <div className={cn('flex items-center gap-0.5', className)} data-answer-feedback={answerId}>
      <button
        type="button"
        onClick={onHelpful}
        disabled={busy}
        aria-pressed={vote === 'helpful'}
        aria-label={strings.helpfulLabel}
        title={strings.helpfulLabel}
        className={cn(VOTE_BUTTON, vote === 'helpful' && 'text-[#FF6417] dark:text-[#FF8A4D]')}
      >
        <ThumbsUp className={cn('h-4 w-4', vote === 'helpful' && 'fill-current')} aria-hidden="true" />
      </button>
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              onNotHelpful();
            }}
            disabled={busy}
            aria-pressed={vote === 'not_helpful'}
            aria-label={strings.notHelpfulLabel}
            title={strings.notHelpfulLabel}
            className={cn(VOTE_BUTTON, vote === 'not_helpful' && 'text-[#FF6417] dark:text-[#FF8A4D]')}
          >
            <ThumbsDown className={cn('h-4 w-4', vote === 'not_helpful' && 'fill-current')} aria-hidden="true" />
          </button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className={cn(
              'z-[9999] w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-gray-200 bg-white p-3 text-gray-900 shadow-lg',
              'dark:border-[#3A3A3A] dark:bg-[#242424] dark:text-gray-100 overscroll-contain',
            )}
          >
            <form onSubmit={onSubmit} className="flex flex-col gap-3">
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium text-pretty">{strings.feedbackReasonHeading}</legend>
                <div className="flex flex-wrap gap-1.5">
                  {REASONS.map((reason) => {
                    const selected = reasons.includes(reason);
                    return (
                      <button
                        key={reason}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleReason(reason)}
                        className={cn(
                          'rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors duration-150 motion-reduce:transition-none touch-manipulation',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6417]/60',
                          selected
                            ? 'bg-[#FF6417]/15 text-[#A63F0A] ring-[#FF6417]/50 dark:bg-[#FF8A4D]/20 dark:text-[#FFB48A] dark:ring-[#FF8A4D]/50'
                            : 'bg-transparent text-gray-700 ring-gray-300 hover:bg-[#FFE0D0] dark:text-gray-300 dark:ring-[#4A4A4A] dark:hover:bg-[#424242]',
                        )}
                      >
                        {strings.feedbackReasons[reason]}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <div className="flex flex-col gap-1">
                <label htmlFor={commentId} className="text-sm font-medium">
                  {strings.feedbackCommentLabel}
                </label>
                <textarea
                  id={commentId}
                  name="feedback-comment"
                  autoComplete="off"
                  rows={3}
                  maxLength={FEEDBACK_COMMENT_MAX}
                  value={comment}
                  onChange={(event) => setComment(event.target.value.slice(0, FEEDBACK_COMMENT_MAX))}
                  placeholder={strings.feedbackCommentPlaceholder}
                  aria-describedby={statusId}
                  className={cn(
                    'w-full resize-none rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm break-words placeholder:text-gray-500',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6417]/60',
                    'dark:border-[#4A4A4A] dark:bg-[#1E1E1E] dark:placeholder:text-gray-400',
                  )}
                />
                <p id={statusId} className="text-xs tabular-nums text-gray-600 dark:text-gray-400" aria-live="polite">
                  {error ?? strings.feedbackCharactersLeft(left)}
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-sm text-gray-700 touch-manipulation transition-colors duration-150 motion-reduce:transition-none hover:bg-[#FFE0D0]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6417]/60 dark:text-gray-300 dark:hover:bg-[#424242]',
                  )}
                >
                  {strings.feedbackCancel}
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className={cn(
                    'inline-flex items-center gap-1.5 touch-manipulation rounded-lg bg-[#C24A0C] px-3 py-1.5 text-sm font-medium text-white transition-colors duration-150 motion-reduce:transition-none',
                    'hover:bg-[#A63F0A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6417]/60 focus-visible:ring-offset-2',
                    'dark:focus-visible:ring-offset-[#242424] disabled:cursor-wait disabled:opacity-80',
                  )}
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                  {strings.feedbackSubmit}
                </button>
              </div>
            </form>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      <span className="sr-only" role="status" aria-live="polite">
        {saved ? strings.feedbackSaved : !open && error ? error : ''}
      </span>
    </div>
  );
}
