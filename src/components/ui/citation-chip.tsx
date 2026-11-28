'use client';

import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/components/providers/language-provider';
import { useSources, type Source } from '@/components/providers/sources-provider';
import { useChatStore } from '@/lib/chat-store';
import { useCitationFocusStore } from '@/lib/stores/citation-focus-store';
import { useGhostModeStore } from '@/lib/ghost-mode-store';
import { postSourceOpened, setSourcesMessage, traceForMessage } from '@/lib/chat/refusal-feedback-client';
import { answerQualityStrings } from '@/translations/answer-quality';

export interface CitationChipProps {
  n: number;
  messageId: string;
  buildSources: () => Source[];
  className?: string;
}

/** A superscript citation number; clicking it opens the sources panel at that citation's snapshot entry. */
export function CitationChip({ n, messageId, buildSources, className }: CitationChipProps) {
  const { language } = useLanguage();
  const { setSources, trackedSetIsSourcesOpen } = useSources();
  const currentChatId = useChatStore((s) => s.currentChatId);
  const { focusCitation } = useCitationFocusStore(useShallow((s) => ({ focusCitation: s.focusCitation })));
  const label = answerQualityStrings(language).chipAriaLabel(n);

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setSources(buildSources());
    focusCitation({ chatId: currentChatId, messageId, n });
    trackedSetIsSourcesOpen(true, 'CitationChip_USER_CLICK');
    setSourcesMessage(messageId);
    const traceId = traceForMessage(messageId);
    const incognito = useGhostModeStore.getState().isGhostMode || Boolean(currentChatId?.startsWith('ghost-'));
    if (traceId && !incognito) postSourceOpened(traceId, `citation:${n}`);
  };

  return (
    <sup className="ml-px align-super leading-none">
      <button
        type="button"
        data-sources-toggle="true"
        data-citation-chip={n}
        aria-label={label}
        title={label}
        onClick={handleClick}
        className={cn(
          'relative inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.65rem] font-semibold tabular-nums',
          'after:absolute after:-inset-2',
          'bg-[#FF6417]/15 text-[#C24A0C] hover:bg-[#FF6417]/25 dark:bg-[#FF8A4D]/20 dark:text-[#FFB48A] dark:hover:bg-[#FF8A4D]/35',
          'transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6417]/60',
          'touch-manipulation',
          className,
        )}
      >
        {n}
      </button>
    </sup>
  );
}
