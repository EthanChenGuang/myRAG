import { getLanguageRegistry, registryOrder, type LanguagePack, type LanguageRegistry } from './registry';

/** A language code from config/rag/language-packs.json. */
export type DetectedLanguage = string;

const HAN_SHARE_FOR_ZH = 0.2;
const HAN_SCRIPT = 'Hani';

interface DetectionPack {
  code: string;
  han: boolean;
  stopwords: ReadonlySet<string>;
}

const packCache = new WeakMap<LanguageRegistry, DetectionPack[]>();

function detectionPacks(): DetectionPack[] {
  const registry = getLanguageRegistry();
  let packs = packCache.get(registry);
  if (!packs) {
    packs = registry.packs.map((pack: LanguagePack) => ({
      code: pack.code,
      han: pack.script === HAN_SCRIPT,
      stopwords: new Set(pack.stopwords.detection),
    }));
    packCache.set(registry, packs);
  }
  return packs;
}

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _match of text.matchAll(pattern)) count += 1;
  return count;
}

/**
 * Dominant language of a text among the registry languages (or `candidates`), or null without evidence.
 * Han share of all letters decides a Han-script language; Latin text is split by detection-stopword hits,
 * a tie going to the earlier language in registry order with `confident: false`.
 * `confidence` is 0..1: for Han, 0.5 at the share threshold rising to 1 at all-Han text; for stopwords,
 * (best - second) / (best + second) scaled by d / (d + 1) with d = best - second; 0 without evidence.
 */
export type LanguageDetection = {
  language: DetectedLanguage | null;
  confident: boolean;
  confidence: number;
};

const NONE: LanguageDetection = { language: null, confident: false, confidence: 0 };

export function detectLanguageWithConfidence(text: string, candidates?: readonly string[]): LanguageDetection {
  const all = detectionPacks();
  let packs = all;
  if (candidates !== undefined) {
    const wanted = new Set(registryOrder(candidates));
    packs = all.filter((pack) => wanted.has(pack.code));
    if (packs.length === 0) return NONE;
    if (packs.length === 1) return { language: packs[0]!.code, confident: true, confidence: 1 };
  }

  const han = countMatches(text, /\p{Script=Han}/gu);
  const latin = countMatches(text, /\p{Script=Latin}/gu);
  const letters = han + latin;
  if (letters === 0) return NONE;
  const hanPack = packs.find((pack) => pack.han);
  const hanShare = han / letters;
  if (hanPack && hanShare >= HAN_SHARE_FOR_ZH) {
    const confidence = 0.5 + (0.5 * (hanShare - HAN_SHARE_FOR_ZH)) / (1 - HAN_SHARE_FOR_ZH);
    return { language: hanPack.code, confident: true, confidence };
  }

  const wordPacks = packs.filter((pack) => pack.stopwords.size > 0);
  const counts = wordPacks.map(() => 0);
  for (const match of text.toLowerCase().matchAll(/\p{L}+/gu)) {
    const word = match[0];
    wordPacks.forEach((pack, index) => {
      if (pack.stopwords.has(word)) counts[index]! += 1;
    });
  }
  let bestIndex = -1;
  let best = 0;
  let second = 0;
  counts.forEach((count, index) => {
    if (count > best) {
      second = best;
      best = count;
      bestIndex = index;
    } else if (count > second) {
      second = count;
    }
  });
  if (bestIndex < 0) return NONE;
  const margin = best - second;
  const confidence = (margin / (best + second)) * (margin / (margin + 1));
  return { language: wordPacks[bestIndex]!.code, confident: margin > 0, confidence };
}

export function detectLanguage(text: string, candidates?: readonly string[]): DetectedLanguage | null {
  return detectLanguageWithConfidence(text, candidates).language;
}
