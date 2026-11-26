'use client';

import { ChevronDown } from 'lucide-react';
import { useModel } from '@/components/providers/model-provider';
import { useLanguage } from '@/components/providers/language-provider';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ModelSelector } from './model-selector';
import { cn } from '@/lib/utils';

interface ComposerModelPillProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}

/** Model picker in the composer tool row. Opens upward so it stays above the on-screen keyboard. */
export function ComposerModelPill({ open, onOpenChange, disabled }: ComposerModelPillProps) {
  const { selectedModel } = useModel();
  const { t } = useLanguage();
  const label = selectedModel?.displayName || t('modelSelector');

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn('chat-composer-model-pill', open && 'is-open')}
          aria-label={`${t('modelSelector')}: ${label}`}
        >
          <span className="chat-composer-model-pill__label" translate="no">
            {label}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="w-72 max-w-[calc(100vw-24px)] rounded-xl"
        style={{
          backgroundColor: 'transparent',
          border: 'none',
          boxShadow: '0 10px 40px -5px rgba(0, 0, 0, 0.15), 0 4px 25px -2px rgba(0, 0, 0, 0.1)',
          padding: 0,
          overflow: 'hidden',
          borderRadius: '12px',
          zIndex: 9999,
        }}
        // Radix passes this through to its focus scope but leaves it out of the public types. Keeping focus on the
        // textarea keeps the iOS keyboard (and the composer above it) in place while the menu is open.
        {...({ onOpenAutoFocus: (e: Event) => e.preventDefault() } as Record<string, unknown>)}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
      >
        <ModelSelector onSelect={() => onOpenChange(false)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
