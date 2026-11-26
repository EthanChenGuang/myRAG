export type ScopeTagTextKey = 'trigger' | 'count' | 'aria' | 'clear' | 'unknownTag';

export function scopeTagText(_key: ScopeTagTextKey, _language: string, _vars: Record<string, string | number> = {}): string {
  return '';
}

export function scopeDimensionLabel(dimension: string, _language: string): string {
  return dimension;
}
