export interface ZipfPickerOptions {
  seed: number;
  size: number;
  exponent?: number;
}

export interface NeutralLexicalCorpusOptions {
  seed: number;
  chunks: number;
  vocabulary: number;
  minLength: number;
  maxLength: number;
  exponent?: number;
}

export function zipfPicker(_options: ZipfPickerOptions): () => number {
  return () => -1;
}

export function neutralLexicalCorpus(_options: NeutralLexicalCorpusOptions): string[][] {
  return [];
}
