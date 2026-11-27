export function setModelContextLengthOverrides(_overrides: Readonly<Record<string, number>> | null): void {}
export function modelContextLength(_modelId: string, _source: Record<string, string | undefined> = process.env): number | null {
  return null;
}
export function modelFamily(_modelId: string): string | null {
  return null;
}
