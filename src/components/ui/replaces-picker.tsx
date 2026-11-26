'use client';

import * as React from 'react';
import { Check, Replace, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { replacesTemplate, replacesText } from '@/components/ui/replaces-labels';
import { cn } from '@/lib/utils';

/** A current, ready document of the workspace the upload could replace (D-41); the server validates the choice. */
export interface ReplaceCandidate {
  id: string;
  name: string;
  uploadedAt?: Date | null;
}

export function filterReplaceCandidates(candidates: ReplaceCandidate[], query: string): ReplaceCandidate[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return candidates;
  return candidates.filter((candidate) => candidate.name.toLocaleLowerCase().includes(needle));
}

/** Roving focus in the chooser list: Up and Down wrap, Home and End jump. */
export function nextRovingIndex(current: number, key: string, count: number): number {
  if (count <= 0) return 0;
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return current;
  }
}

export function replacesChooserKeyAction(key: string): 'move' | 'select' | 'close' | null {
  if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') return 'move';
  if (key === ' ' || key === 'Enter') return 'select';
  if (key === 'Escape') return 'close';
  return null;
}

/** The upload date in the UI language (Intl, medium style); an unknown language tag falls back to en. */
export function formatCandidateDate(date: Date, language: string): string {
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date);
  }
}

/** Splits a template at one placeholder so the value can be its own element, rendered as text. */
function splitTemplate(template: string, name: string): [string, string] {
  const marker = `{${name}}`;
  const at = template.indexOf(marker);
  if (at < 0) return [template, ''];
  return [template.slice(0, at), template.slice(at + marker.length)];
}

export function ReplacesTitle({ language, fileName }: { language: string; fileName: string }) {
  const [before, after] = splitTemplate(replacesTemplate('title', language), 'file');
  return (
    <>
      {before}
      <span className="inline-block max-w-full truncate align-bottom" title={fileName}>
        {fileName}
      </span>
      {after}
    </>
  );
}

export interface ReplacesChooserBodyProps {
  language: string;
  candidates: ReplaceCandidate[];
  query: string;
  onQueryChange: (query: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose?: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}

/** Search field and radiogroup of the chooser (UI-SPEC 6.12.2, section 9 item 15). */
export function ReplacesChooserBody({
  language,
  candidates,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  onClose,
  inputRef,
}: ReplacesChooserBodyProps) {
  const searchId = React.useId();
  const shown = filterReplaceCandidates(candidates, query);
  const selectedIndex = shown.findIndex((candidate) => candidate.id === selectedId);
  const [focusIndex, setFocusIndex] = React.useState<number | null>(null);
  const rowRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex =
    focusIndex !== null && focusIndex < shown.length ? focusIndex : selectedIndex >= 0 ? selectedIndex : 0;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const action = replacesChooserKeyAction(event.key);
    if (!action) return;
    if (action === 'close') {
      if (onClose) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    event.preventDefault();
    if (action === 'select') {
      const candidate = shown[activeIndex];
      if (candidate) onSelect(candidate.id);
      return;
    }
    const next = nextRovingIndex(activeIndex, event.key, shown.length);
    setFocusIndex(next);
    rowRefs.current[next]?.focus();
  };

  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid gap-1.5">
        <label htmlFor={searchId} className="text-sm font-medium">
          {replacesText('search', language)}
        </label>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={searchId}
            ref={inputRef}
            type="search"
            name="replaces-search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setFocusIndex(null);
              onQueryChange(event.target.value);
            }}
            className="pl-8"
          />
        </div>
      </div>
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{replacesText('empty', language)}</p>
      ) : shown.length === 0 ? (
        <p className="break-words text-sm text-muted-foreground">{replacesText('noMatch', language, { query: query.trim() })}</p>
      ) : (
        <ScrollArea className="max-h-72 rounded-md border [&>[data-radix-scroll-area-viewport]]:max-h-72 [&>[data-radix-scroll-area-viewport]]:overscroll-contain">
          <div role="radiogroup" aria-label={replacesText('search', language)} className="grid gap-0.5 p-1" onKeyDown={onKeyDown}>
            {shown.map((candidate, index) => {
              const checked = candidate.id === selectedId;
              return (
                <button
                  key={candidate.id}
                  ref={(node) => {
                    rowRefs.current[index] = node;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onClick={() => {
                    setFocusIndex(index);
                    onSelect(candidate.id);
                  }}
                  onFocus={() => setFocusIndex(index)}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none [contain-intrinsic-size:auto_2.75rem] [content-visibility:auto] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                    checked && 'bg-accent',
                  )}
                >
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-sm" title={candidate.name}>
                      {candidate.name}
                    </span>
                    {candidate.uploadedAt ? (
                      <span className="text-xs text-muted-foreground">{formatCandidateDate(candidate.uploadedAt, language)}</span>
                    ) : null}
                  </span>
                  {checked ? <Check aria-hidden="true" className="h-4 w-4 flex-shrink-0" /> : null}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

export interface ReplacesPickerProps {
  enabled: boolean;
  confirmedAtOnce: boolean;
  fileName: string;
  candidates: ReplaceCandidate[];
  language: string;
  value: ReplaceCandidate | null;
  onChange: (value: ReplaceCandidate | null) => void;
  disabled?: boolean;
  className?: string;
}

/** "Replaces…" trigger and chooser of one upload queue row (UI-SPEC 6.12.2); hidden unless the server enables it. */
export function ReplacesPicker({
  enabled,
  confirmedAtOnce,
  fileName,
  candidates,
  language,
  value,
  onChange,
  disabled,
  className,
}: ReplacesPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  if (!enabled) return null;

  const onOpenChange = (next: boolean) => {
    if (next) {
      setQuery('');
      setPendingId(value?.id ?? null);
    }
    setOpen(next);
  };
  const pending = candidates.find((candidate) => candidate.id === pendingId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild disabled={disabled}>
        <Button type="button" variant="outline" className={cn('h-8 px-2 gap-1 text-xs font-normal', className)}>
          <Replace aria-hidden="true" className="h-3.5 w-3.5" />
          <span>{replacesText('trigger', language)}</span>
          <span className="sr-only">{replacesText('triggerFor', language, { file: fileName })}</span>
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onEscapeKeyDown={() => setOpen(false)}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="min-w-0 break-words text-balance">
            <ReplacesTitle language={language} fileName={fileName} />
          </DialogTitle>
          <DialogDescription>{replacesText(confirmedAtOnce ? 'admin' : 'member', language)}</DialogDescription>
        </DialogHeader>
        <ReplacesChooserBody
          language={language}
          candidates={candidates}
          query={query}
          onQueryChange={setQuery}
          selectedId={pendingId}
          onSelect={setPendingId}
          inputRef={inputRef}
        />
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {replacesText('close', language)}
          </Button>
          <Button
            type="button"
            disabled={!pending}
            onClick={() => {
              if (!pending) return;
              onChange(pending);
              setOpen(false);
            }}
          >
            {replacesText('confirm', language)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The "Replaces: {name}" line under the file name, with its remove button. */
export function ReplacesLine({ language, name, onRemove, disabled }: { language: string; name: string; onRemove: () => void; disabled?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <p className="min-w-0 truncate text-xs text-muted-foreground" title={name}>
        {replacesText('line', language, { name })}
      </p>
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 flex-shrink-0" disabled={disabled} onClick={onRemove}>
        <X aria-hidden="true" className="h-3.5 w-3.5" />
        <span className="sr-only">{replacesText('remove', language, { name })}</span>
      </Button>
    </div>
  );
}
