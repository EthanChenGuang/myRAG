'use client';

export interface ReplaceCandidate {
  id: string;
  name: string;
  uploadedAt?: Date | null;
}

export function filterReplaceCandidates(candidates: ReplaceCandidate[], _query: string): ReplaceCandidate[] {
  return candidates;
}

export function nextRovingIndex(current: number, _key: string, _count: number): number {
  return current;
}

export function replacesChooserKeyAction(_key: string): 'move' | 'select' | 'close' | null {
  return null;
}

export interface ReplacesChooserBodyProps {
  language: string;
  candidates: ReplaceCandidate[];
  query: string;
  onQueryChange: (query: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ReplacesChooserBody(_props: ReplacesChooserBodyProps) {
  return null;
}

export function ReplacesTitle(_props: { language: string; fileName: string }) {
  return null;
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

export function ReplacesPicker(_props: ReplacesPickerProps) {
  return null;
}

export function ReplacesLine(_props: { language: string; name: string; onRemove: () => void; disabled?: boolean }) {
  return null;
}
