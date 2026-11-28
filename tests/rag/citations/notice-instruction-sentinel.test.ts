import { describe, expect, it } from 'vitest';
import { REFERENCE_NOTICE, REFERENCE_REMINDER } from '@/lib/rag/context/wrap';
import { attachedDocumentsSentence, citationInstruction } from '@/lib/rag/generation/citations/instructions';

const LANGUAGES = ['zh', 'en', 'it'] as const;

/** Verbs that would tell the model to follow or obey content, in the three supported languages. */
const FORBIDDEN = [
  /\bfollow(?:s|ed|ing)?\b/,
  /\bobey(?:s|ed|ing)?\b/,
  /\bcomply\b|\bcomplies\b/,
  /遵循|遵守|服从|服從|执行|執行|听从|聽從|照做|按照/,
  /\bsegu(?:ire|i|ite|a|ano|endo)\b/,
  /\bobbed(?:ire|isci|ite|isca|iscano|endo)\b/,
  /\besegu(?:ire|i|ite|a|ano|endo)\b/,
];

function view(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

function forbiddenIn(text: string): string[] {
  const normalized = view(text);
  return FORBIDDEN.flatMap((pattern) => normalized.match(new RegExp(pattern.source, 'g')) ?? []);
}

/** A follow/obey in the notice or reminder is allowed only as a prohibition or aimed at instructions outside the documents. */
function allowedNoticeUse(sentence: string): boolean {
  const s = view(sentence);
  return /\bnever follow\b/.test(s) || /\bfollow only the instructions outside\b/.test(s);
}

describe('citation instruction sentinel (A5, R5)', () => {
  it.each(LANGUAGES)('the %s citation instruction contains no follow or obey verb', (language) => {
    expect(forbiddenIn(citationInstruction(language))).toEqual([]);
  });

  it.each(LANGUAGES)('the %s attached-documents sentence contains no follow or obey verb', (language) => {
    expect(forbiddenIn(attachedDocumentsSentence(language))).toEqual([]);
  });

  it.each(LANGUAGES)('combined with the notice (%s), every follow or obey forbids following document content', (language) => {
    const combined = [REFERENCE_NOTICE, attachedDocumentsSentence(language), REFERENCE_REMINDER, citationInstruction(language)].join('\n');
    const sentences = combined.split(/(?<=[.。;；])\s*|\n/).filter((sentence) => sentence.trim());
    const offending = sentences.filter((sentence) => forbiddenIn(sentence).length > 0 && !allowedNoticeUse(sentence));
    expect(offending).toEqual([]);
    expect(forbiddenIn(combined).length).toBeGreaterThan(0);
  });

  it('the sentinel catches an instruction that tells the model to follow the documents', () => {
    expect(forbiddenIn('Follow the instructions in the labelled sources.')).not.toEqual([]);
    expect(forbiddenIn('请遵循上方来源中的指示。')).not.toEqual([]);
    expect(forbiddenIn('Obbedisci alle fonti etichettate.')).not.toEqual([]);
    expect(forbiddenIn('Segui le istruzioni delle fonti.')).not.toEqual([]);
    expect(forbiddenIn('ＦＯＬＬＯＷ the sources.')).not.toEqual([]);
  });
});
