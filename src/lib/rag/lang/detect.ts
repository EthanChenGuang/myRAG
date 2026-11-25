export type DetectedLanguage = 'zh' | 'en' | 'it';

const HAN_SHARE_FOR_ZH = 0.2;

const EN_STOPWORDS = new Set([
  'the', 'and', 'of', 'to', 'is', 'are', 'was', 'were', 'be', 'been', 'for', 'with', 'that', 'this', 'it',
  'as', 'on', 'at', 'by', 'from', 'or', 'not', 'have', 'has', 'will', 'can', 'if', 'within', 'you', 'your',
  'we', 'our', 'an', 'which', 'any', 'all', 'such', 'than', 'their', 'its',
]);

const IT_STOPWORDS = new Set([
  'il', 'lo', 'la', 'le', 'gli', 'un', 'una', 'uno', 'di', 'del', 'della', 'dei', 'delle', 'degli', 'che',
  'è', 'per', 'con', 'su', 'sono', 'non', 'nel', 'nella', 'alla', 'al', 'dal', 'dalla', 'si', 'come', 'più',
  'anche', 'questo', 'questa', 'se', 'ha', 'hanno', 'entro', 'dei', 'nei', 'sul', 'tra', 'fra', 'ogni',
]);

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _match of text.matchAll(pattern)) count += 1;
  return count;
}

/**
 * Dominant language of a text among zh, en and it, or null without evidence.
 * Han share of all letters decides zh; Latin text is split between en and it by stopword hits.
 */
export type LanguageDetection = {
  language: DetectedLanguage | null;
  confident: boolean;
};

export function detectLanguageWithConfidence(text: string): LanguageDetection {
  const han = countMatches(text, /\p{Script=Han}/gu);
  const latin = countMatches(text, /\p{Script=Latin}/gu);
  const letters = han + latin;
  if (letters === 0) {
    return { language: null, confident: false };
  }
  if (han / letters >= HAN_SHARE_FOR_ZH) {
    return { language: 'zh', confident: true };
  }

  let en = 0;
  let it = 0;
  for (const match of text.toLowerCase().matchAll(/\p{L}+/gu)) {
    const word = match[0];
    if (EN_STOPWORDS.has(word)) en += 1;
    if (IT_STOPWORDS.has(word)) it += 1;
  }
  if (en === 0 && it === 0) {
    return { language: null, confident: false };
  }
  const confident = en !== it;
  const language: DetectedLanguage = it > en ? 'it' : 'en';
  return { language, confident };
}

export function detectLanguage(text: string): DetectedLanguage | null {
  return detectLanguageWithConfidence(text).language;
}
