'use client';

import { Lock, Users, X } from 'lucide-react';
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
import { accessGroupText } from '@/components/ui/access-group-labels';
import type { AccessGroupOption, AccessGroupsMine } from '@/lib/stores/access-groups-store';
import { cn } from '@/lib/utils';

/** The three states of the upload choice (UI-SPEC 6.2.3): untouched sends nothing; the server applies D-16 and D-19. */
export type AccessPickerValue =
  | { kind: 'untouched' }
  | { kind: 'everyone' }
  | { kind: 'groups'; groupIds: string[] };

export const ACCESS_UNTOUCHED: AccessPickerValue = { kind: 'untouched' };

export type AccessPickerItem =
  | { type: 'everyone'; label: string; checked: boolean }
  | { type: 'separator'; key: string }
  | { type: 'label'; label: string }
  | { type: 'group'; id: string; name: string; checked: boolean }
  | { type: 'note'; text: string }
  | { type: 'clear'; label: string };

export const ACCESS_PICKER_TRIGGER_CLASS = 'h-8 max-w-[12rem] px-2 gap-1 text-xs font-normal';
export const ACCESS_PICKER_MENU_CLASS = 'w-64 max-h-72 overflow-y-auto overscroll-contain';
export const ACCESS_PICKER_ITEM_CLASS = 'text-sm whitespace-normal break-words';

/** The picker is rendered only with the switch on, in a team workspace, for a caller who has a group to assign (UI-SPEC 6.2.3). */
export function accessPickerVisible(mine: AccessGroupsMine): boolean {
  return mine.enabled && !mine.personal && mine.assignableGroups.length > 0;
}

/** The value as the menu shows it: groups the caller may no longer assign are left out; with none left it reads as untouched. */
export function visibleAccessValue(value: AccessPickerValue, groups: readonly AccessGroupOption[]): AccessPickerValue {
  if (value.kind !== 'groups') return value;
  const known = new Set(groups.map((group) => group.id));
  const groupIds = value.groupIds.filter((id) => known.has(id));
  return groupIds.length > 0 ? { kind: 'groups', groupIds } : ACCESS_UNTOUCHED;
}

/** Menu content in UI-SPEC 6.2.3 order: Everyone, the groups, the note and, for a touched value, Clear choice. */
export function buildAccessPickerItems(
  groups: readonly AccessGroupOption[],
  value: AccessPickerValue,
  language: string,
): AccessPickerItem[] {
  const shown = visibleAccessValue(value, groups);
  const chosen = new Set(shown.kind === 'groups' ? shown.groupIds : []);
  const items: AccessPickerItem[] = [
    { type: 'everyone', label: accessGroupText('term.everyone', language), checked: shown.kind === 'everyone' },
    { type: 'separator', key: 'groups' },
    { type: 'label', label: accessGroupText('field.onlyGroups', language) },
  ];
  const seen = new Set<string>();
  for (const group of groups) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    items.push({ type: 'group', id: group.id, name: group.name, checked: chosen.has(group.id) });
  }
  items.push({ type: 'separator', key: 'note' }, { type: 'note', text: accessGroupText('picker.note', language) });
  if (shown.kind !== 'untouched') items.push({ type: 'clear', label: accessGroupText('picker.clear', language) });
  return items;
}

/** Ticking Everyone unticks every group; ticking a group unticks Everyone; unticking the last group returns to untouched. */
export function toggleAccessPickerValue(
  value: AccessPickerValue,
  target: 'everyone' | { groupId: string },
  checked: boolean,
  groups: readonly AccessGroupOption[],
): AccessPickerValue {
  if (target === 'everyone') return checked ? { kind: 'everyone' } : ACCESS_UNTOUCHED;
  const current = visibleAccessValue(value, groups);
  const ids = current.kind === 'groups' ? current.groupIds : [];
  const next = checked ? (ids.includes(target.groupId) ? ids : [...ids, target.groupId]) : ids.filter((id) => id !== target.groupId);
  if (next.length === 0) return ACCESS_UNTOUCHED;
  const order = new Map(groups.map((group, index) => [group.id, index]));
  return { kind: 'groups', groupIds: [...next].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)) };
}

/**
 * The `access` form field of 04.3-23 (`{"everyone":true}` or `{"groupIds":[...]}`), or null for untouched. Group ids only:
 * the browser never builds or sends a key (D-06).
 */
export function accessFormValue(value: AccessPickerValue | null | undefined): string | null {
  if (!value || value.kind === 'untouched') return null;
  if (value.kind === 'everyone') return JSON.stringify({ everyone: true });
  if (value.groupIds.length === 0) return null;
  return JSON.stringify({ groupIds: value.groupIds });
}

export function accessPickerTriggerLabel(value: AccessPickerValue, groups: readonly AccessGroupOption[], language: string): string {
  const shown = visibleAccessValue(value, groups);
  if (shown.kind === 'everyone') return accessGroupText('picker.everyone', language);
  if (shown.kind === 'groups') return accessGroupText('picker.groups', language, { n: shown.groupIds.length });
  return accessGroupText('picker.trigger', language);
}

/** Checkbox items keep the menu open (UI-SPEC 3.2). */
export function keepAccessMenuOpen(event: Event): void {
  event.preventDefault();
}

export interface AccessGroupPickerProps {
  value: AccessPickerValue;
  groups: readonly AccessGroupOption[];
  language: string;
  fileName: string;
  onChange: (value: AccessPickerValue) => void;
  disabled?: boolean;
  className?: string;
  error?: string | null;
}

/** The Access trigger of one upload queue row (UI-SPEC 6.10), after the 3.2 triggers. Group names are text children only. */
export function AccessGroupPicker({ value, groups, language, fileName, onChange, disabled, className, error }: AccessGroupPickerProps) {
  const items = buildAccessPickerItems(groups, value, language);
  const shown = visibleAccessValue(value, groups);
  const label = accessPickerTriggerLabel(value, groups, language);
  const names = shown.kind === 'groups' ? groups.filter((group) => shown.groupIds.includes(group.id)).map((group) => group.name) : [];
  const Icon = shown.kind === 'groups' ? Lock : Users;
  const picker = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          aria-label={`${label}, ${accessGroupText('picker.aria', language, { file: fileName })}`}
          title={names.length > 0 ? `${label} (${names.join(', ')})` : label}
          className={cn(ACCESS_PICKER_TRIGGER_CLASS, className)}
        >
          <Icon aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={ACCESS_PICKER_MENU_CLASS}>
        {items.map((item) => {
          switch (item.type) {
            case 'everyone':
              return (
                <DropdownMenuCheckboxItem
                  key="everyone"
                  checked={item.checked}
                  className={ACCESS_PICKER_ITEM_CLASS}
                  onSelect={keepAccessMenuOpen}
                  onCheckedChange={(checked) => onChange(toggleAccessPickerValue(value, 'everyone', checked === true, groups))}
                >
                  {item.label}
                </DropdownMenuCheckboxItem>
              );
            case 'separator':
              return <DropdownMenuSeparator key={`separator-${item.key}`} />;
            case 'label':
              return (
                <DropdownMenuLabel key="label" className="text-xs">
                  {item.label}
                </DropdownMenuLabel>
              );
            case 'group':
              return (
                <DropdownMenuCheckboxItem
                  key={`group-${item.id}`}
                  checked={item.checked}
                  className={ACCESS_PICKER_ITEM_CLASS}
                  onSelect={keepAccessMenuOpen}
                  onCheckedChange={(checked) => onChange(toggleAccessPickerValue(value, { groupId: item.id }, checked === true, groups))}
                >
                  {item.name}
                </DropdownMenuCheckboxItem>
              );
            case 'note':
              return (
                <p key="note" className="px-2 py-1 text-xs text-muted-foreground">
                  {item.text}
                </p>
              );
            case 'clear':
              return (
                <DropdownMenuItem key="clear" className="text-sm" onSelect={() => onChange(ACCESS_UNTOUCHED)}>
                  {item.label}
                </DropdownMenuItem>
              );
          }
        })}
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

export interface AccessChoiceLineProps {
  value: AccessPickerValue;
  groups: readonly AccessGroupOption[];
  language: string;
  onChange: (value: AccessPickerValue) => void;
  disabled?: boolean;
}

/** The line under the file name (UI-SPEC 6.2.3 and 6.10): nothing while untouched, Everyone with a clear button, or removable chips. */
export function AccessChoiceLine({ value, groups, language, onChange, disabled }: AccessChoiceLineProps) {
  const shown = visibleAccessValue(value, groups);
  if (shown.kind === 'untouched') return null;
  if (shown.kind === 'everyone') {
    return (
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <span>{accessGroupText('audience.everyone', language)}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={disabled}
          onClick={() => onChange(ACCESS_UNTOUCHED)}
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">{accessGroupText('picker.clear', language)}</span>
        </Button>
      </div>
    );
  }
  const chosen = groups.filter((group) => shown.groupIds.includes(group.id));
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <span>{accessGroupText('audience.label', language)}</span>
      <ul role="list" className="flex min-w-0 flex-wrap items-center gap-1">
        {chosen.map((group) => (
          <li key={group.id} className="inline-flex min-w-0 items-center gap-1 rounded border border-input px-1">
            <span className="max-w-[10rem] truncate" title={group.name}>
              {group.name}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={disabled}
              onClick={() => onChange(toggleAccessPickerValue(value, { groupId: group.id }, false, groups))}
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
              <span className="sr-only">{accessGroupText('action.removeGroupChip', language, { group: group.name })}</span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A 400 `group_not_allowed` answer to an upload (04.3-23): the file was not stored and the picker reloads its groups. */
export function isGroupNotAllowed(status: number, body: unknown): boolean {
  if (status !== 400 || !body || typeof body !== 'object') return false;
  return (body as Record<string, unknown>).error === 'group_not_allowed';
}
