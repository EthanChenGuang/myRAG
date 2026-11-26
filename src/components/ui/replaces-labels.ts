export type ReplacesTextKey =
  | 'trigger' | 'title' | 'member' | 'admin' | 'search' | 'empty' | 'noMatch' | 'close' | 'confirm' | 'line' | 'remove';

export function replacesText(_key: ReplacesTextKey, _language: string, _vars: Record<string, string | number> = {}): string {
  return '';
}
