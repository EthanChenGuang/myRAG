import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EMBEDDER_ID = 'fixture-ngram';
export const EMBEDDER_VERSION = 1;

const DIMENSIONS = 1536;
const WORD_WEIGHT = 1.0;
const TRIGRAM_WEIGHT = 0.3;
const HAN_UNIGRAM_WEIGHT = 0.5;
const HAN_BIGRAM_WEIGHT = 1.0;

const LATIN_STOPWORDS = new Set(
  (
    'a an the of to in on for and or is are was were be been do does did what which who whom how many much can could ' +
    'i my me we our you your it its this that these those with at by from as if than then there have has had will ' +
    'would should not no per ' +
    'il lo la le gli un una uno di da in con su per tra fra e ed o che chi cosa come quanto quanti quale quali ' +
    'sono sei siamo siete era ero non del della dei delle al alla ai alle nel nella nei nelle ' +
    'mi ti ci vi si io tu lui lei noi voi loro ha ho hai abbiamo hanno'
  ).split(/\s+/),
);

const HAN_STOPWORDS = ['多少', '可以', '什么', '怎么', '如何', '是否', '的', '是', '了', '在', '和', '有', '我', '你', '吗', '呢', '吧', '与', '及', '或', '就', '都', '也', '为'].sort(
  (a, b) => b.length - a.length,
);

const TOKEN_RE = /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu;
const HAN_RE = /^\p{Script=Han}+$/u;

const hashCache = new Map<string, [number, number]>();

function bucketAndSign(feature: string): [number, number] {
  const cached = hashCache.get(feature);
  if (cached) return cached;
  const digest = crypto.createHash('sha256').update(feature).digest();
  const result: [number, number] = [digest.readUInt32BE(0) % DIMENSIONS, (digest[4] & 1) === 0 ? 1 : -1];
  hashCache.set(feature, result);
  return result;
}

function splitHanOnStopwords(run: string): string[] {
  let text = run;
  for (const stop of HAN_STOPWORDS) text = text.split(stop).join(' ');
  return text.split(' ').filter((segment) => segment.length > 0);
}

function collectFeatures(text: string): Map<string, number> {
  const features = new Map<string, number>();
  const add = (feature: string, weight: number) => features.set(feature, (features.get(feature) ?? 0) + weight);

  for (const token of text.normalize('NFKC').toLowerCase().match(TOKEN_RE) ?? []) {
    if (HAN_RE.test(token)) {
      for (const segment of splitHanOnStopwords(token)) {
        const chars = Array.from(segment);
        for (let i = 0; i < chars.length; i += 1) {
          add(`hu:${chars[i]}`, HAN_UNIGRAM_WEIGHT);
          if (i + 1 < chars.length) add(`hb:${chars[i]}${chars[i + 1]}`, HAN_BIGRAM_WEIGHT);
        }
      }
      continue;
    }
    if (LATIN_STOPWORDS.has(token)) continue;
    add(`w:${token}`, WORD_WEIGHT);
    const padded = Array.from(`#${token}#`);
    for (let i = 0; i + 3 <= padded.length; i += 1) add(`t:${padded.slice(i, i + 3).join('')}`, TRIGRAM_WEIGHT);
  }

  if (features.size === 0) features.set('__empty__', 1);
  return features;
}

export function embedText(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const [feature, weight] of collectFeatures(text)) {
    const [bucket, sign] = bucketAndSign(feature);
    vector[bucket] += sign * weight;
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return vector.map((x) => (norm === 0 ? 0 : x / norm));
}

export function embedderSourceSha256(): string {
  return crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex');
}
