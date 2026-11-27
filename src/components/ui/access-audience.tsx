'use client';

import * as React from 'react';
import { AlertTriangle, Lock, Plus, ShieldAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { accessGroupText, type AccessGroupLabelKey } from '@/components/ui/access-group-labels';
import type { AccessGroupOption } from '@/lib/stores/access-groups-store';
import { cn } from '@/lib/utils';

export type AudienceKind = 'everyone' | 'groups' | 'uploader_only';
/** `restricted` is the only reading a non-admin gets: the server sends them one boolean per document (D-29). */
export type AudienceReading = AudienceKind | 'restricted';

/** A document's access as the server gives it: the boolean for every caller, the rest for admins only (UI-SPEC 8.1). */
export interface AudienceInput {
  restricted: boolean;
  kind?: AudienceKind;
  groupIds?: string[];
  groupNames?: string[];
  peopleCount?: number;
  fallbackReason?: string | null;
}

/** A reason sentence; an unknown code sits between `before` and `after` and is rendered as a `code` element. */
export interface AudienceReason {
  before: string;
  code: string | null;
  after: string;
}

export interface AudienceView {
  reading: AudienceReading;
  label: string | null;
  tone: 'neutral' | 'warning' | null;
  everyoneText: string | null;
  groupNames: string[];
  groupsLine: string | null;
  peopleLine: string | null;
  reason: AudienceReason | null;
  hint: string | null;
}

const KNOWN_REASONS: Record<string, AccessGroupLabelKey> = {
  group_deleted: 'reason.group_deleted',
  unmapped_source: 'reason.unmapped_source',
  source_error: 'reason.source_error',
};

const WARNING_TONE = 'text-amber-700 dark:text-amber-300';
const CODE_MARK = '\u0000code\u0000';

function reasonOf(code: string | null | undefined, language: string): AudienceReason | null {
  if (!code) return null;
  const known = Object.prototype.hasOwnProperty.call(KNOWN_REASONS, code) ? KNOWN_REASONS[code] : undefined;
  if (known) return { before: accessGroupText(known, language), code: null, after: '' };
  const sentence = accessGroupText('reason.other', language, { code: CODE_MARK });
  const at = sentence.indexOf(CODE_MARK);
  if (at < 0) return { before: sentence, code, after: '' };
  return { before: sentence.slice(0, at), code, after: sentence.slice(at + CODE_MARK.length) };
}

function kindOf(audience: AudienceInput): AudienceKind {
  if (audience.kind === 'everyone' || audience.kind === 'groups' || audience.kind === 'uploader_only') return audience.kind;
  return audience.restricted ? 'groups' : 'everyone';
}

/**
 * The one place that turns a document's access into words (UI-SPEC 6.2.1). A non-admin gets the Restricted mark and its hint
 * only: no group names, no reason, no count, whatever else the input carries.
 */
export function buildAudienceView(audience: AudienceInput, isAdmin: boolean, language: string): AudienceView {
  const everyoneText = accessGroupText('audience.everyone', language);
  const empty: AudienceView = {
    reading: 'everyone',
    label: null,
    tone: null,
    everyoneText,
    groupNames: [],
    groupsLine: null,
    peopleLine: null,
    reason: null,
    hint: null,
  };
  const kind = kindOf(audience);
  if (!isAdmin) {
    if (!audience.restricted && kind === 'everyone') return empty;
    return {
      ...empty,
      reading: 'restricted',
      label: accessGroupText('badge.restricted', language),
      tone: 'neutral',
      everyoneText: null,
      hint: accessGroupText('badge.restrictedHint', language),
    };
  }
  if (kind === 'everyone') return empty;
  const people = typeof audience.peopleCount === 'number' && audience.peopleCount > 0 ? audience.peopleCount : 0;
  const peopleLine = people > 0 ? accessGroupText('audience.people', language, { count: people }) : null;
  if (kind === 'uploader_only') {
    return {
      ...empty,
      reading: 'uploader_only',
      label: accessGroupText('audience.uploaderOnly', language),
      tone: 'warning',
      everyoneText: null,
      reason: reasonOf(audience.fallbackReason, language),
    };
  }
  const groupNames = (audience.groupNames ?? []).filter((name) => typeof name === 'string');
  return {
    ...empty,
    reading: 'groups',
    label: accessGroupText('badge.restricted', language),
    tone: 'neutral',
    everyoneText: null,
    groupNames,
    groupsLine: groupNames.length > 0 ? accessGroupText('audience.groups', language, { groups: groupNames.join(', ') }) : null,
    peopleLine,
  };
}

/** The mark under a file name (UI-SPEC 6.2.1): static text, no border, no background, no role. */
export function RestrictedMark({ view, className }: { view: AudienceView; className?: string }) {
  if (!view.label) return null;
  const warning = view.tone === 'warning';
  const Icon = warning ? ShieldAlert : Lock;
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs', warning ? WARNING_TONE : 'text-muted-foreground', className)}
      title={view.hint ?? undefined}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0" />
      <span>{view.label}</span>
      {view.hint ? <span className="sr-only">{`. ${view.hint}`}</span> : null}
    </span>
  );
}

function ReasonText({ reason }: { reason: AudienceReason }) {
  return (
    <>
      {reason.before}
      {reason.code ? (
        <code className="font-mono" translate="no">
          {reason.code}
        </code>
      ) : null}
      {reason.after}
    </>
  );
}

/**
 * The read-only audience of a document. In the list, Everyone shows nothing (the quiet default); in a dialog it is the text.
 * Admin lines are 12px, muted and truncated with the full text in `title`.
 */
export function AudienceLine({ view, context, className }: { view: AudienceView; context: 'list' | 'dialog'; className?: string }) {
  if (view.reading === 'everyone') {
    if (context === 'list' || !view.everyoneText) return null;
    return <p className={cn('text-sm', className)}>{view.everyoneText}</p>;
  }
  const details = [view.groupsLine, view.peopleLine].filter((line): line is string => Boolean(line)).join(', ');
  const lineClass = context === 'list' ? 'truncate' : 'break-words';
  return (
    <div className={cn('grid min-w-0 gap-1', className)}>
      <RestrictedMark view={view} />
      {details ? (
        <p className={cn('text-xs text-muted-foreground', lineClass)} title={details}>
          {details}
        </p>
      ) : null}
      {view.reason ? (
        <p className={cn('text-xs text-muted-foreground', context === 'list' ? 'line-clamp-2' : 'break-words')}>
          <ReasonText reason={view.reason} />
        </p>
      ) : null}
    </div>
  );
}

export type AudienceChoice = 'everyone' | 'groups';

/** The editable choice (UI-SPEC 6.2.2). Chips stay in memory while Everyone is chosen. */
export interface AudienceFieldState {
  choice: AudienceChoice | null;
  chips: string[];
  restrictedNow: boolean;
  mixed: boolean;
}

export interface AudienceFieldDocument {
  kind: AudienceKind;
  groupIds: string[];
}

export type AudienceFieldAction =
  | { type: 'everyone' }
  | { type: 'groups' }
  | { type: 'add'; groupId: string }
  | { type: 'remove'; groupId: string };

function sameAudience(a: AudienceFieldDocument, b: AudienceFieldDocument): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'groups') return true;
  const left = new Set(a.groupIds);
  const right = new Set(b.groupIds);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * One document: its audience is pre-chosen, except the fallback audience, which is never offered, so nothing is chosen.
 * Several documents that differ: nothing is chosen and the mixed line shows.
 */
export function initAudienceField(documents: readonly AudienceFieldDocument[]): AudienceFieldState {
  const restrictedNow = documents.some((document) => document.kind !== 'everyone');
  const first = documents[0];
  if (!first) return { choice: null, chips: [], restrictedNow, mixed: false };
  const mixed = documents.some((document) => !sameAudience(first, document));
  if (mixed || first.kind === 'uploader_only') return { choice: null, chips: [], restrictedNow, mixed };
  if (first.kind === 'everyone') return { choice: 'everyone', chips: [], restrictedNow, mixed: false };
  return { choice: 'groups', chips: [...new Set(first.groupIds)], restrictedNow, mixed: false };
}

export function audienceFieldReducer(state: AudienceFieldState, action: AudienceFieldAction): AudienceFieldState {
  switch (action.type) {
    case 'everyone':
      return state.choice === 'everyone' ? state : { ...state, choice: 'everyone' };
    case 'groups':
      return state.choice === 'groups' ? state : { ...state, choice: 'groups' };
    case 'add':
      return state.chips.includes(action.groupId) ? state : { ...state, chips: [...state.chips, action.groupId] };
    case 'remove':
      return state.chips.includes(action.groupId) ? { ...state, chips: state.chips.filter((id) => id !== action.groupId) } : state;
  }
}

export interface AudienceFieldRadio {
  value: AudienceChoice;
  label: string;
  help: string;
  disabled: boolean;
}

export interface AudienceFieldDerived {
  radios: AudienceFieldRadio[];
  /** Chosen groups that still exist, in the order of the group list; empty while Everyone is chosen. */
  chips: AccessGroupOption[];
  addable: AccessGroupOption[];
  canSave: boolean;
  needGroup: string | null;
  widen: string | null;
  mixed: string | null;
  /** The relabel body's choice (group ids or everyone, never a key), or null while the field cannot be saved. */
  submit: { everyone: true } | { groupIds: string[] } | null;
}

export function deriveAudienceField(
  state: AudienceFieldState,
  groups: readonly AccessGroupOption[],
  language: string,
  options: { mode: 'org' | 'single'; bulk?: boolean },
): AudienceFieldDerived {
  const chosen = new Set(state.chips);
  const known = groups.filter((group, index) => groups.findIndex((each) => each.id === group.id) === index);
  const chips = state.choice === 'groups' ? known.filter((group) => chosen.has(group.id)) : [];
  const addable = known.filter((group) => !chosen.has(group.id));
  const noGroups = known.length === 0;
  const radios: AudienceFieldRadio[] = [
    {
      value: 'everyone',
      label: accessGroupText('term.everyone', language),
      help: accessGroupText(options.mode === 'org' ? 'field.everyoneHelp.org' : 'field.everyoneHelp.single', language),
      disabled: false,
    },
    {
      value: 'groups',
      label: accessGroupText('field.onlyGroups', language),
      help: accessGroupText(noGroups ? 'field.noGroups' : 'field.onlyGroupsHelp', language),
      disabled: noGroups,
    },
  ];
  const needGroup = state.choice === 'groups' && chips.length === 0 ? accessGroupText('field.needGroup', language) : null;
  const widen =
    state.choice === 'everyone' && state.restrictedNow
      ? accessGroupText(options.bulk ? 'field.widenMany' : 'field.widen', language)
      : null;
  const submit =
    state.choice === 'everyone'
      ? ({ everyone: true } as const)
      : state.choice === 'groups' && chips.length > 0
        ? { groupIds: chips.map((group) => group.id) }
        : null;
  return {
    radios,
    chips,
    addable,
    canSave: submit !== null,
    needGroup,
    widen,
    mixed: state.mixed && state.choice === null ? accessGroupText('field.mixed', language) : null,
    submit,
  };
}

/** The id of the need-group line, for the save button's `aria-describedby` while it is disabled. */
export function audienceFieldNeedGroupId(id: string): string {
  return `${id}-need-group`;
}

export interface AudienceFieldProps {
  state: AudienceFieldState;
  onChange: (state: AudienceFieldState) => void;
  groups: readonly AccessGroupOption[];
  language: string;
  mode: 'org' | 'single';
  bulk?: boolean;
  id?: string;
  disabled?: boolean;
}

/** The audience field (UI-SPEC 6.2.2, 9 item 3): fieldset and legend, two radios, the chip list and Add group. */
export function AudienceField({ state, onChange, groups, language, mode, bulk, id, disabled }: AudienceFieldProps) {
  const generatedId = React.useId();
  const baseId = id ?? `audience-${generatedId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const derived = deriveAudienceField(state, groups, language, { mode, bulk });
  const [announcement, setAnnouncement] = React.useState('');
  const [focusTarget, setFocusTarget] = React.useState<string | null>(null);
  const chipButtons = React.useRef(new Map<string, HTMLButtonElement>());
  const addButton = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    if (!focusTarget) return;
    const target = focusTarget === 'add' ? addButton.current : chipButtons.current.get(focusTarget);
    target?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const dispatch = (action: AudienceFieldAction) => onChange(audienceFieldReducer(state, action));

  const removeChip = (group: AccessGroupOption) => {
    const index = derived.chips.findIndex((chip) => chip.id === group.id);
    const next = derived.chips[index + 1];
    dispatch({ type: 'remove', groupId: group.id });
    setAnnouncement(accessGroupText('chip.removed', language, { group: group.name }));
    setFocusTarget(next ? next.id : 'add');
  };

  const addChip = (group: AccessGroupOption) => {
    dispatch({ type: 'add', groupId: group.id });
    setAnnouncement(accessGroupText('chip.added', language, { group: group.name }));
  };

  const groupsLabelId = `${baseId}-groups-label`;
  return (
    <fieldset className="grid min-w-0 gap-4" disabled={disabled}>
      <legend className="mb-2 text-sm font-semibold">{accessGroupText('audience.label', language)}</legend>
      {derived.mixed ? <p className="text-sm text-muted-foreground">{derived.mixed}</p> : null}
      {derived.radios.map((radio) => {
        const inputId = `${baseId}-${radio.value}`;
        const helpId = `${inputId}-help`;
        return (
          <div key={radio.value} className="grid min-w-0 gap-1">
            <div className="flex items-center gap-2">
              <input
                id={inputId}
                type="radio"
                name={`${baseId}-choice`}
                value={radio.value}
                checked={state.choice === radio.value}
                disabled={radio.disabled}
                aria-describedby={helpId}
                className="h-4 w-4 accent-primary"
                onChange={() => dispatch({ type: radio.value })}
              />
              <label
                htmlFor={inputId}
                id={radio.value === 'groups' ? groupsLabelId : undefined}
                className={cn('text-sm', radio.disabled && 'text-muted-foreground')}
              >
                {radio.label}
              </label>
            </div>
            <p id={helpId} className="pl-6 text-xs text-muted-foreground">
              {radio.help}
            </p>
            {radio.value === 'groups' && state.choice === 'groups' ? (
              <div className="grid min-w-0 gap-2 pl-6">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {derived.chips.length > 0 ? (
                    <ul role="list" aria-labelledby={groupsLabelId} className="flex min-w-0 flex-wrap items-center gap-2">
                      {derived.chips.map((group) => (
                        <li
                          key={group.id}
                          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-input px-1 text-xs"
                        >
                          <span className="min-w-0 break-words">{group.name}</span>
                          <Button
                            ref={(node) => {
                              if (node) chipButtons.current.set(group.id, node);
                              else chipButtons.current.delete(group.id);
                            }}
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 flex-shrink-0"
                            onClick={() => removeChip(group)}
                          >
                            <X aria-hidden="true" className="h-3.5 w-3.5" />
                            <span className="sr-only">{accessGroupText('action.removeGroupChip', language, { group: group.name })}</span>
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild disabled={derived.addable.length === 0}>
                      <Button ref={addButton} type="button" variant="outline" className="h-8 gap-1 px-2 text-xs font-normal">
                        <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                        <span>{accessGroupText('action.addGroup', language)}</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64 max-h-72 overflow-y-auto overscroll-contain">
                      {groups.length === 0 ? (
                        <p className="px-2 py-1 text-xs text-muted-foreground">{accessGroupText('field.noGroups', language)}</p>
                      ) : (
                        derived.addable.map((group) => (
                          <DropdownMenuItem
                            key={group.id}
                            className="whitespace-normal break-words text-sm"
                            onSelect={(event) => {
                              event.preventDefault();
                              addChip(group);
                            }}
                          >
                            {group.name}
                          </DropdownMenuItem>
                        ))
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {derived.needGroup ? (
                  <p id={audienceFieldNeedGroupId(baseId)} className="text-xs text-muted-foreground">
                    {derived.needGroup}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {derived.widen ? (
        <p className={cn('flex items-start gap-1 text-sm', WARNING_TONE)}>
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{derived.widen}</span>
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{accessGroupText('field.effect', language)}</p>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </fieldset>
  );
}
