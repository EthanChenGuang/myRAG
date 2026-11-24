import { splitAtIdentifiers } from '../ids/shapes';

export const LEXICAL_VERSION = 1;

const zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const HAN_OR_OTHER = /(\p{Script=Han}+)|([^\p{Script=Han}]+)/gu;

function foldLatin(run: string): string[] {
  const folded = run.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  return folded.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function segment(text: string): string[] {
  const out: string[] = [];
  for (const run of text.matchAll(HAN_OR_OTHER)) {
    if (run[1]) {
      for (const part of zhSegmenter.segment(run[1])) {
        if (part.isWordLike) out.push(part.segment);
      }
    } else if (run[2]) {
      out.push(...foldLatin(run[2]));
    }
  }
  return out;
}

/**
 * The one application tokenizer behind lexical_text: identifiers verbatim, Han words from Intl.Segmenter,
 * Latin text lowercased with diacritics folded.
 */
export function lexicalTokens(text: string): string[] {
  const out: string[] = [];
  for (const piece of splitAtIdentifiers(text.normalize('NFKC'))) {
    if (piece.identifier) out.push(piece.text);
    else out.push(...segment(piece.text));
  }
  return out;
}

export function lexicalText(prefix: string[], content: string): string {
  const tokens = [...prefix.flatMap((part) => lexicalTokens(part)), ...lexicalTokens(content)];
  return tokens.join(' ');
}
