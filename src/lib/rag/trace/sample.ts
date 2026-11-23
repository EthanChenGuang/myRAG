export type SamplePrefix = 'trace' | 'review';

export function isSampled(_requestId: string, _rate: number, _prefix: SamplePrefix = 'trace'): boolean {
  return false;
}
