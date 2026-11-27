// Seeded, dependency-free generator of neutral token arrays (w0..wN, Zipf-distributed) for
// lexical tests and the benchmark. Integer LCG arithmetic keeps output identical across platforms.

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

export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function zipfCdf(size: number, exponent: number): Float64Array {
  const cdf = new Float64Array(size);
  let total = 0;
  for (let rank = 1; rank <= size; rank += 1) {
    total += exponent === 1 ? 1 / rank : 1 / Math.pow(rank, exponent);
    cdf[rank - 1] = total;
  }
  for (let i = 0; i < size; i += 1) cdf[i] /= total;
  return cdf;
}

function pickRank(cdf: Float64Array, u: number): number {
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (u < cdf[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

export function zipfPicker(options: ZipfPickerOptions, random?: () => number): () => number {
  assertPositiveInteger('size', options.size);
  const cdf = zipfCdf(options.size, options.exponent ?? 1);
  const next = random ?? lcg(options.seed);
  return () => pickRank(cdf, next());
}

export function neutralLexicalCorpus(options: NeutralLexicalCorpusOptions): string[][] {
  const { chunks, vocabulary, minLength, maxLength } = options;
  if (!Number.isInteger(chunks) || chunks < 0) throw new Error('chunks must be a non-negative integer');
  assertPositiveInteger('vocabulary', vocabulary);
  assertPositiveInteger('minLength', minLength);
  if (!Number.isInteger(maxLength) || maxLength < minLength) throw new Error('maxLength must be an integer >= minLength');

  const random = lcg(options.seed);
  const pick = zipfPicker({ seed: options.seed, size: vocabulary, exponent: options.exponent }, random);
  const span = maxLength - minLength + 1;
  const corpus: string[][] = [];
  for (let i = 0; i < chunks; i += 1) {
    const length = minLength + Math.floor(random() * span);
    const doc: string[] = [];
    for (let j = 0; j < length; j += 1) doc.push(`w${pick()}`);
    corpus.push(doc);
  }
  return corpus;
}
