export function escapeToolOutput(value: unknown): unknown {
  return value;
}

export function wrapToolResultsForPrompt(_source: string, _items: ReadonlyArray<Record<string, unknown>>): string {
  return '';
}

export function scanToolOutput(_value: unknown): string[] {
  return [];
}
