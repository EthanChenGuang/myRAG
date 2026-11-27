'use client';

import type { AccessGroupOption } from '@/lib/stores/access-groups-store';

export type AudienceKind = 'everyone' | 'groups' | 'uploader_only';
export type AudienceReading = AudienceKind | 'restricted';

export interface AudienceInput {
  restricted: boolean;
  kind?: AudienceKind;
  groupIds?: string[];
  groupNames?: string[];
  peopleCount?: number;
  fallbackReason?: string | null;
}

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

export function buildAudienceView(_audience: AudienceInput, _isAdmin: boolean, _language: string): AudienceView {
  return { reading: 'everyone', label: null, tone: null, everyoneText: null, groupNames: [], groupsLine: null, peopleLine: null, reason: null, hint: null };
}

export type AudienceChoice = 'everyone' | 'groups';

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

export function initAudienceField(_documents: readonly AudienceFieldDocument[]): AudienceFieldState {
  return { choice: 'everyone', chips: [], restrictedNow: false, mixed: false };
}

export function audienceFieldReducer(state: AudienceFieldState, _action: AudienceFieldAction): AudienceFieldState {
  return state;
}

export interface AudienceFieldRadio {
  value: AudienceChoice;
  label: string;
  help: string;
  disabled: boolean;
}

export interface AudienceFieldDerived {
  radios: AudienceFieldRadio[];
  chips: AccessGroupOption[];
  addable: AccessGroupOption[];
  canSave: boolean;
  needGroup: string | null;
  widen: string | null;
  mixed: string | null;
  submit: { everyone: true } | { groupIds: string[] } | null;
}

export function deriveAudienceField(
  _state: AudienceFieldState,
  _groups: readonly AccessGroupOption[],
  _language: string,
  _options: { mode: 'org' | 'single'; bulk?: boolean },
): AudienceFieldDerived {
  return { radios: [], chips: [], addable: [], canSave: true, needGroup: null, widen: null, mixed: null, submit: null };
}

export function AudienceLine(_props: { view: AudienceView; context: 'list' | 'dialog' }) {
  return null;
}

export function RestrictedMark(_props: { view: AudienceView }) {
  return null;
}

export function AudienceField(_props: {
  state: AudienceFieldState;
  onChange: (state: AudienceFieldState) => void;
  groups: readonly AccessGroupOption[];
  language: string;
  mode: 'org' | 'single';
  bulk?: boolean;
  id?: string;
}) {
  return null;
}
