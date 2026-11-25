export type ChineseScript = 'hans' | 'hant' | 'ambiguous';

export function chineseScript(_text: string): ChineseScript {
  return 'ambiguous';
}

export const SIMPLIFIED_ONLY: ReadonlySet<string> = new Set();
export const TRADITIONAL_ONLY: ReadonlySet<string> = new Set();
