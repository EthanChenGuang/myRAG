import lexicon from './rewrite-gate.lexicon.json';

export type GateLang = 'zh' | 'en' | 'it';

export const CJK_SHARE_FOR_ZH = 0.3;

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LATIN_LETTER = /\p{Script=Latin}/gu;
const WORD = /\p{L}+/gu;

const EN_STOPWORDS: ReadonlySet<string> = new Set(lexicon.stopwords.en);
const IT_STOPWORDS: ReadonlySet<string> = new Set(lexicon.stopwords.it);

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) count += 1;
  return count;
}

export function countCjkChars(text: string): number {
  return countMatches(text, CJK_CHAR);
}

/**
 * XLG-01 query language for the query layer: CJK share of letters >= 30% gives zh, else an Italian
 * stopword score above the English one gives it, else en. Phase 4's queryLanguage stays separate.
 */
export function detectGateLanguage(text: string): GateLang {
  const cjk = countCjkChars(text);
  const latin = countMatches(text, LATIN_LETTER);
  if (cjk > 0 && cjk / (cjk + latin) >= CJK_SHARE_FOR_ZH) return 'zh';

  let en = 0;
  let it = 0;
  WORD.lastIndex = 0;
  const lower = text.toLowerCase();
  let match: RegExpExecArray | null;
  while ((match = WORD.exec(lower)) !== null) {
    const word = match[0];
    if (EN_STOPWORDS.has(word)) en += 1;
    if (IT_STOPWORDS.has(word)) it += 1;
  }
  return it > en ? 'it' : 'en';
}
