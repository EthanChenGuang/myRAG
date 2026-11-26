'use client';

import type { UIMessage } from 'ai';
import type { EmbedRatingReason, EmbedRatingStrings, EmbedRatingVote } from '../embed-rating-strings';

export type EmbedRatingOutcome = 'saved' | 'gone' | 'rateLimited' | 'failed';
export interface EmbedRatingState {
  vote: EmbedRatingVote | null;
  reasons: EmbedRatingReason[];
  sending: boolean;
  status: 'none' | 'saved' | 'failed' | 'rateLimited';
  gone: boolean;
}

export const INITIAL_EMBED_RATING: EmbedRatingState = { vote: null, reasons: [], sending: false, status: 'none', gone: false };

export function feedbackTokenOf(_message: UIMessage): string | null {
  return null;
}

export function embedRatingToken(_input: { message: UIMessage; isLast: boolean; status: string }): string | null {
  return null;
}

export async function postEmbedRating(_body: unknown, _fetchImpl?: unknown): Promise<EmbedRatingOutcome> {
  return 'failed';
}

export function startEmbedVote(_state: EmbedRatingState, _vote: EmbedRatingVote, _reasons: EmbedRatingReason[]): EmbedRatingState | null {
  return null;
}

export function finishEmbedVote(_sending: EmbedRatingState, previous: EmbedRatingState, _outcome: EmbedRatingOutcome): EmbedRatingState {
  return previous;
}

export function EmbedRatingView(_props: { state: EmbedRatingState; strings: EmbedRatingStrings; onVote: () => void }) {
  return null;
}

export function EmbedRating(_props: { token: string }) {
  return null;
}
