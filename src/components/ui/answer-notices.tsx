'use client';

import type { AnswerNotice } from '@/lib/rag-eval/contracts.generated';

export function orderNotices(notices: readonly AnswerNotice[]): AnswerNotice[] {
  return [...notices];
}

export interface AnswerNoticesProps {
  notices: readonly AnswerNotice[];
  className?: string;
}

export function AnswerNotices(_props: AnswerNoticesProps) {
  return null;
}
