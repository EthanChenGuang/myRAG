import { HiddenTextRulesSchema, type HiddenTextRules } from '@/lib/rag-eval/contracts.generated';
import rawRules from '../../../../config/rag/hidden-text-rules.json';

/** The zero-width code points of D-33, in this order in every report. */
export const ZERO_WIDTH_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff] as const;

const BYTE_ORDER_MARK = 0xfeff;
const ZERO_WIDTH_GLOBAL = /[​‌‍⁠﻿]/gu;

export interface ZeroWidthFinding {
  /** Counted by code point; a U+FEFF at position 0 is a byte-order mark and is not counted. */
  total: number;
  /** `U+200B` style labels with their counts, in ZERO_WIDTH_CODE_POINTS order; only code points that occur. */
  byCodePoint: Array<{ codePoint: string; count: number }>;
}

export function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Counts the zero-width characters of a text. Never returns any of the text itself. */
export function findZeroWidth(text: string): ZeroWidthFinding {
  const counts = new Map<number, number>();
  if (typeof text === 'string' && text.length > 0) {
    for (const match of text.matchAll(ZERO_WIDTH_GLOBAL)) {
      const codePoint = match[0].codePointAt(0) as number;
      if (codePoint === BYTE_ORDER_MARK && match.index === 0) continue;
      counts.set(codePoint, (counts.get(codePoint) ?? 0) + 1);
    }
  }
  const byCodePoint = ZERO_WIDTH_CODE_POINTS.filter((codePoint) => counts.has(codePoint)).map((codePoint) => ({
    codePoint: codePointLabel(codePoint),
    count: counts.get(codePoint) as number,
  }));
  return { total: byCodePoint.reduce((sum, entry) => sum + entry.count, 0), byCodePoint };
}

/** Removes every zero-width character, a leading byte-order mark included. */
export function stripZeroWidth(text: string): string {
  return text.replace(ZERO_WIDTH_GLOBAL, '');
}

let loaded: HiddenTextRules | null = null;
let override: unknown = undefined;

/** config/rag/hidden-text-rules.json, validated with the generated schema once. Throws when the file is invalid. */
export function loadHiddenTextRules(): HiddenTextRules {
  if (!loaded) loaded = HiddenTextRulesSchema.parse(override === undefined ? rawRules : override);
  return loaded;
}

export function setHiddenTextRulesForTests(raw: unknown): void {
  override = raw;
  loaded = null;
}

export function resetHiddenTextRulesForTests(): void {
  override = undefined;
  loaded = null;
}
