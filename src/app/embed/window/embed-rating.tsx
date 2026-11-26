'use client';

import type { UIMessage } from 'ai';
import { Check, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  EMBED_RATING_REASONS,
  EMBED_RATING_STRINGS,
  embedRatingLocale,
  type EmbedRatingReason,
  type EmbedRatingStrings,
  type EmbedRatingVote,
} from '../embed-rating-strings';

export type EmbedRatingOutcome = 'saved' | 'gone' | 'rateLimited' | 'failed';

export interface EmbedRatingState {
  vote: EmbedRatingVote | null;
  reasons: EmbedRatingReason[];
  sending: boolean;
  status: 'none' | 'saved' | 'failed' | 'rateLimited';
  gone: boolean;
}

export interface EmbedRatingBody {
  token: string;
  vote: EmbedRatingVote;
  reasons: EmbedRatingReason[];
}

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status'>>;

export const INITIAL_EMBED_RATING: EmbedRatingState = { vote: null, reasons: [], sending: false, status: 'none', gone: false };

const RATING_ENDPOINT = '/api/embed/feedback';
const RATING_TIMEOUT_MS = 10000;

export function feedbackTokenOf(message: UIMessage): string | null {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const token = (metadata as { feedbackToken?: unknown }).feedbackToken;
  return typeof token === 'string' && token !== '' ? token : null;
}

/** D-11: a rating exists only for a finished assistant answer with text whose stream carried a token. */
export function embedRatingToken(input: { message: UIMessage; isLast: boolean; status: string }): string | null {
  const { message, isLast, status } = input;
  if (message.role !== 'assistant' || message.id === 'greeting') return null;
  if (isLast && (status === 'streaming' || status === 'submitted' || status === 'error')) return null;
  const text = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
  if (!text.trim()) return null;
  return feedbackTokenOf(message);
}

export async function postEmbedRating(body: EmbedRatingBody, fetchImpl: FetchLike = fetch): Promise<EmbedRatingOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATING_TIMEOUT_MS);
  try {
    const response = await fetchImpl(RATING_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.ok) return 'saved';
    if (response.status === 404) return 'gone';
    if (response.status === 429) return 'rateLimited';
    return 'failed';
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}

/** Returns the sending state, or null when the click changes nothing (same vote, already sending, control gone). */
export function startEmbedVote(state: EmbedRatingState, vote: EmbedRatingVote, reasons: EmbedRatingReason[]): EmbedRatingState | null {
  if (state.sending || state.gone) return null;
  const nextReasons = vote === 'not_helpful' ? EMBED_RATING_REASONS.filter((r) => reasons.includes(r)) : [];
  const sameReasons = nextReasons.length === state.reasons.length && nextReasons.every((r) => state.reasons.includes(r));
  if (state.vote === vote && sameReasons) return null;
  return { vote, reasons: nextReasons, sending: true, status: 'none', gone: false };
}

export function finishEmbedVote(sending: EmbedRatingState, previous: EmbedRatingState, outcome: EmbedRatingOutcome): EmbedRatingState {
  if (outcome === 'gone') return { ...previous, sending: false, gone: true };
  if (outcome === 'saved') return { ...sending, sending: false, status: 'saved' };
  return { ...previous, sending: false, status: outcome };
}

const THUMB_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-lg text-gray-600 transition-colors motion-reduce:transition-none hover:bg-gray-200 touch-manipulation focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:cursor-wait';
const CHIP_CLASS =
  'inline-flex min-h-8 items-center gap-1 rounded-2xl border bg-white px-2 py-1 text-xs text-gray-900 touch-manipulation focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:cursor-wait';

export function EmbedRatingView(props: {
  state: EmbedRatingState;
  strings: EmbedRatingStrings;
  onVote: (vote: EmbedRatingVote, reasons: EmbedRatingReason[], button: HTMLButtonElement) => void;
}) {
  const { state, strings, onVote } = props;
  const statusText =
    state.status === 'saved' ? strings.saved : state.status === 'failed' ? strings.failed : state.status === 'rateLimited' ? strings.rateLimited : '';
  const isError = state.status === 'failed' || state.status === 'rateLimited';
  const thumb = (vote: EmbedRatingVote, label: string, Icon: typeof ThumbsUp) => {
    const pressed = state.vote === vote;
    return (
      <button
        type="button"
        aria-pressed={pressed}
        aria-label={label}
        title={label}
        disabled={state.sending}
        onClick={(event) => {
          if (!pressed) onVote(vote, [], event.currentTarget);
        }}
        className={`${THUMB_CLASS}${pressed ? ' text-gray-900' : ''}`}
      >
        <Icon aria-hidden="true" className={`h-4 w-4${pressed ? ' fill-current' : ''}`} />
      </button>
    );
  };

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-1" role="group" aria-label={strings.group}>
        {thumb('helpful', strings.helpful, ThumbsUp)}
        {thumb('not_helpful', strings.notHelpful, ThumbsDown)}
        <span role="status" aria-live="polite" className={`ml-1 text-xs ${isError ? 'text-red-700' : 'text-gray-600'}`}>
          {statusText}
        </span>
      </div>
      {state.vote === 'not_helpful' && (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label={strings.reasonsLegend}>
          <span className="basis-full text-xs text-gray-600">{strings.reasonsLegend}</span>
          {EMBED_RATING_REASONS.map((reason) => {
            const pressed = state.reasons.includes(reason);
            return (
              <button
                key={reason}
                type="button"
                aria-pressed={pressed}
                disabled={state.sending}
                onClick={(event) => {
                  const next = pressed ? state.reasons.filter((r) => r !== reason) : [...state.reasons, reason];
                  onVote('not_helpful', next, event.currentTarget);
                }}
                className={`${CHIP_CLASS} ${pressed ? 'border-gray-900' : 'border-gray-300'}`}
              >
                {pressed && <Check aria-hidden="true" className="h-3 w-3" />}
                <span>{strings.reasons[reason]}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/** The embed window's rating control; the token stays in React state only. */
export function EmbedRating({ token }: { token: string }) {
  const [state, setState] = useState<EmbedRatingState>(INITIAL_EMBED_RATING);
  const lastButton = useRef<HTMLButtonElement | null>(null);
  const strings = EMBED_RATING_STRINGS[embedRatingLocale(typeof navigator === 'undefined' ? '' : navigator.language)];

  useEffect(() => {
    const button = lastButton.current;
    if (state.sending || !button || !button.isConnected) return;
    if (document.activeElement === null || document.activeElement === document.body) button.focus();
  }, [state.sending]);

  if (state.gone) return null;

  const onVote = async (vote: EmbedRatingVote, reasons: EmbedRatingReason[], button: HTMLButtonElement) => {
    const sending = startEmbedVote(state, vote, reasons);
    if (!sending) return;
    const previous = state;
    lastButton.current = button;
    setState(sending);
    const outcome = await postEmbedRating({ token, vote: sending.vote as EmbedRatingVote, reasons: sending.reasons });
    setState(finishEmbedVote(sending, previous, outcome));
  };

  return <EmbedRatingView state={state} strings={strings} onVote={onVote} />;
}
