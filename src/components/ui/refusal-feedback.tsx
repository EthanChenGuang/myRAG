'use client';

import type { RefusalFeedbackValue } from '@/lib/chat/answer-metadata';

export interface RefusalFeedbackProps {
  traceId: string;
  initial: RefusalFeedbackValue | null;
  onSaved?: (value: RefusalFeedbackValue) => void;
  focusFallback?: () => void;
  className?: string;
}

export function RefusalFeedback(_props: RefusalFeedbackProps) {
  return null;
}
