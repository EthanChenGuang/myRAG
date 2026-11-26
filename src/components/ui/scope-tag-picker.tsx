'use client';

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

export const SCOPE_TAG_MENU_CLASS = '';
export const SCOPE_TAG_ITEM_CLASS = '';

export function buildScopeTagGroups(_vocabulary: ScopeTagVocabularyEntry[], _language: string, _value: string[]): ScopeTagGroup[] {
  return [];
}

export function toggleScopeTag(value: string[], _tag: string, _checked: boolean): string[] {
  return value;
}

export function keepScopeTagMenuOpen(_event: Event): void {}

export function scopeTagTriggerLabel(_count: number, _language: string): string {
  return '';
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

export function ScopeTagPicker(_props: ScopeTagPickerProps) {
  return null;
}
