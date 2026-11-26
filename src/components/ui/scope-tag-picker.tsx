'use client';

import { Tags } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { scopeDimensionLabel, scopeTagText } from '@/components/ui/scope-tag-labels';
import { cn } from '@/lib/utils';

/** One active value of the workspace vocabulary, as the picker-defaults answer lists it (D-40). */
export interface ScopeTagVocabularyEntry {
  dimension: string;
  value: string;
  label: string;
}

export interface ScopeTagGroup {
  dimension: string;
  label: string;
  items: Array<{ tag: string; label: string; checked: boolean }>;
}

export const SCOPE_TAG_MENU_CLASS = 'w-64 max-h-72 overflow-y-auto overscroll-contain';
export const SCOPE_TAG_ITEM_CLASS = 'whitespace-normal break-words [contain-intrinsic-size:auto_2rem] [content-visibility:auto]';

export const SCOPE_TAG_TRIGGER_CLASS = 'h-8 px-2 gap-1 text-xs font-normal';

function isEntry(entry: ScopeTagVocabularyEntry): boolean {
  return (
    typeof entry?.dimension === 'string' &&
    entry.dimension.length > 0 &&
    typeof entry.value === 'string' &&
    entry.value.length > 0 &&
    typeof entry.label === 'string'
  );
}

/** Groups the vocabulary by dimension in its own order; each item carries its dimension:value tag. */
export function buildScopeTagGroups(vocabulary: ScopeTagVocabularyEntry[], language: string, value: string[]): ScopeTagGroup[] {
  const chosen = new Set(value);
  const groups: ScopeTagGroup[] = [];
  for (const entry of vocabulary) {
    if (!isEntry(entry)) continue;
    let group = groups.find((each) => each.dimension === entry.dimension);
    if (!group) {
      group = { dimension: entry.dimension, label: scopeDimensionLabel(entry.dimension, language), items: [] };
      groups.push(group);
    }
    const tag = `${entry.dimension}:${entry.value}`;
    if (group.items.some((item) => item.tag === tag)) continue;
    group.items.push({ tag, label: entry.label, checked: chosen.has(tag) });
  }
  return groups;
}

export function toggleScopeTag(value: string[], tag: string, checked: boolean): string[] {
  if (checked) return value.includes(tag) ? value : [...value, tag];
  return value.filter((each) => each !== tag);
}

/** Checkbox items keep the menu open (UI-SPEC 3.2). */
export function keepScopeTagMenuOpen(event: Event): void {
  event.preventDefault();
}

export function scopeTagTriggerLabel(count: number, language: string): string {
  return count > 0 ? scopeTagText('count', language, { n: count }) : scopeTagText('trigger', language);
}

export interface ScopeTagPickerProps {
  enabled: boolean;
  vocabulary: ScopeTagVocabularyEntry[];
  value: string[];
  language: string;
  fileName: string;
  onChange: (value: string[]) => void;
  disabled?: boolean;
  className?: string;
  error?: string | null;
}

/** Tag picker of one upload queue row (UI-SPEC 6.12.1); hidden unless the server enables tags and lists an active value. */
export function ScopeTagPicker({ enabled, vocabulary, value, language, fileName, onChange, disabled, className, error }: ScopeTagPickerProps) {
  const groups = enabled ? buildScopeTagGroups(vocabulary, language, value) : [];
  if (groups.length === 0) return null;
  const known = new Map(groups.flatMap((group) => group.items.map((item) => [item.tag, item.label] as const)));
  const selected = value.filter((tag) => known.has(tag));
  const selectedLabels = selected.map((tag) => known.get(tag) as string).join(', ');
  const picker = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          aria-label={`${scopeTagTriggerLabel(selected.length, language)}, ${scopeTagText('aria', language, { file: fileName })}`}
          title={selectedLabels || undefined}
          className={cn(SCOPE_TAG_TRIGGER_CLASS, className)}
        >
          <Tags aria-hidden="true" className="h-3.5 w-3.5" />
          <span>{scopeTagTriggerLabel(selected.length, language)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={SCOPE_TAG_MENU_CLASS}>
        {groups.map((group, index) => (
          <div key={group.dimension} role="group" aria-label={group.label}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-xs">{group.label}</DropdownMenuLabel>
            {group.items.map((item) => (
              <DropdownMenuCheckboxItem
                key={item.tag}
                checked={item.checked}
                className={SCOPE_TAG_ITEM_CLASS}
                onSelect={keepScopeTagMenuOpen}
                onCheckedChange={(checked) => onChange(toggleScopeTag(selected, item.tag, checked === true))}
              >
                {item.label}
              </DropdownMenuCheckboxItem>
            ))}
          </div>
        ))}
        {selected.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-sm" onSelect={() => onChange([])}>
              {scopeTagText('clear', language)}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  if (!error) return picker;
  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      {picker}
      <p role="alert" className="max-w-[16rem] text-xs text-muted-foreground">
        {error}
      </p>
    </div>
  );
}
