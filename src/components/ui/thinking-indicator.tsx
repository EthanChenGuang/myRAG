'use client';

import { useLanguage } from '@/components/providers/language-provider';

/** Shown while an answer is being retrieved and generated: three orbiting dots and a label with a light sweep. */
export function ThinkingIndicator() {
  const { t } = useLanguage();
  const label = t('thinkingStatus');
  return (
    <div className="chat-thinking" role="status" aria-live="polite">
      <span className="chat-thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="chat-thinking-label" data-text={label}>
        {label}
      </span>
    </div>
  );
}
