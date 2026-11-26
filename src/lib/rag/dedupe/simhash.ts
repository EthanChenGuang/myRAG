import { createHash } from 'node:crypto';
import { lexicalTokens } from '../lexical/tokenize';

/** Word shingles of this many default lexical tokens (Han bigrams already come from the tokenizer). */
export const SIMHASH_SHINGLE_SIZE = 3;
/** 8 bands of 8 bits: two hashes within 7 differing bits always share a band (research Pattern 5, assumption A2). */
export const SIMHASH_BAND_COUNT = 8;
export const SIMHASH_BAND_BITS = 8;

const UINT64 = (BigInt(1) << BigInt(64)) - BigInt(1);
const INT64_TEXT = /^-?\d{1,20}$/;

function shingles(text: string): Map<string, number> {
  const tokens = lexicalTokens(text);
  const counts = new Map<string, number>();
  if (tokens.length === 0) return counts;
  if (tokens.length < SIMHASH_SHINGLE_SIZE) {
    counts.set(tokens.join(' '), 1);
    return counts;
  }
  for (let i = 0; i + SIMHASH_SHINGLE_SIZE <= tokens.length; i += 1) {
    const shingle = tokens.slice(i, i + SIMHASH_SHINGLE_SIZE).join(' ');
    counts.set(shingle, (counts.get(shingle) ?? 0) + 1);
  }
  return counts;
}

/**
 * 64-bit SimHash over word shingles of the default lexical tokens, weighted by shingle count. Returns an unsigned value in
 * [0, 2^64); 0 for text without tokens. Send it to Postgres with toInt64String: a JSON number above 2^53 loses bits.
 */
export function simhash64(text: string): bigint {
  const counts = shingles(text);
  if (counts.size === 0) return BigInt(0);
  const weights = new Array<number>(64).fill(0);
  for (const [shingle, weight] of counts) {
    const digest = createHash('sha256').update(shingle, 'utf8').digest();
    const high = digest.readUInt32BE(0);
    const low = digest.readUInt32BE(4);
    for (let bit = 0; bit < 32; bit += 1) {
      weights[bit] = (weights[bit] as number) + ((low >>> bit) & 1 ? weight : -weight);
      weights[bit + 32] = (weights[bit + 32] as number) + ((high >>> bit) & 1 ? weight : -weight);
    }
  }
  let hash = BigInt(0);
  for (let bit = 63; bit >= 0; bit -= 1) {
    hash = (hash << BigInt(1)) | ((weights[bit] as number) > 0 ? BigInt(1) : BigInt(0));
  }
  return hash;
}

/** Band b holds bits 8b..8b+7 (low band first); the same split migration 0857 computes in SQL. */
export function simhashBands(hash: bigint): number[] {
  const value = BigInt.asUintN(64, hash);
  const bands: number[] = [];
  for (let band = 0; band < SIMHASH_BAND_COUNT; band += 1) {
    bands.push(Number((value >> BigInt(band * SIMHASH_BAND_BITS)) & BigInt('0xff')));
  }
  return bands;
}

export function hammingDistance64(a: bigint, b: bigint): number {
  let diff = BigInt.asUintN(64, a ^ b);
  let count = 0;
  while (diff > BigInt(0)) {
    diff &= diff - BigInt(1);
    count += 1;
  }
  return count;
}

/** The signed 64-bit decimal form Postgres `bigint` stores; every bit of the unsigned value survives. */
export function toInt64String(hash: bigint): string {
  return BigInt.asIntN(64, hash & UINT64).toString();
}

/** Back from a stored `bigint` (text, a safe number or a BigInt) to the unsigned SimHash. */
export function fromInt64(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return BigInt.asUintN(64, value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError('[RAG Dedupe] simhash number is not a safe integer');
    return BigInt.asUintN(64, BigInt(value));
  }
  if (!INT64_TEXT.test(value)) throw new RangeError('[RAG Dedupe] malformed simhash');
  return BigInt.asUintN(64, BigInt(value));
}
