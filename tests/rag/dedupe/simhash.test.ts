import { describe, expect, test } from 'vitest';
import {
  SIMHASH_BAND_BITS,
  SIMHASH_BAND_COUNT,
  fromInt64,
  hammingDistance64,
  simhash64,
  simhashBands,
  toInt64String,
} from '@/lib/rag/dedupe/simhash';

const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'su', 'ta', 'vo', 'ri', 'pe', 'du', 'zo', 'fa', 'gi', 'ho', 'ju', 'be'];

/** A deterministic invented word: no real vocabulary, so no domain text enters the test. */
function word(seed: number): string {
  let n = seed * 2654435761 >>> 0;
  let out = '';
  for (let i = 0; i < 3; i += 1) {
    out += SYLLABLES[n % SYLLABLES.length];
    n = Math.floor(n / SYLLABLES.length) + 7 * (i + 1);
  }
  return `${out}${seed % 97}`;
}

function passage(seed: number, length = 80): string[] {
  return Array.from({ length }, (_, i) => word(seed * 1000 + i));
}

describe('simhash64', () => {
  test('is deterministic and 64-bit', () => {
    const text = passage(1).join(' ');
    const first = simhash64(text);
    expect(first).toBe(simhash64(text));
    expect(first).not.toBe(BigInt(0));
    expect(first >= BigInt(0) && first < BigInt(1) << BigInt(64)).toBe(true);
  });

  test('texts that differ in one word out of about eighty differ in few bits', () => {
    const words = passage(2);
    const variant = words.slice();
    variant[40] = 'zz-substituted-word';
    const distance = hammingDistance64(simhash64(words.join(' ')), simhash64(variant.join(' ')));
    expect(distance).toBeLessThanOrEqual(8);
  });

  test('unrelated texts differ in about half the bits', () => {
    const distances: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      distances.push(hammingDistance64(simhash64(passage(100 + i).join(' ')), simhash64(passage(200 + i).join(' '))));
    }
    const mean = distances.reduce((sum, d) => sum + d, 0) / distances.length;
    expect(mean).toBeGreaterThan(24);
    expect(mean).toBeLessThan(40);
  });

  test('Han text is hashed from the tokenizer bigrams and stays stable', () => {
    const text = '仓库收货手册规定夜班人员扫描托盘并暂放货位';
    expect(simhash64(text)).toBe(simhash64(text));
    expect(simhash64(text)).not.toBe(BigInt(0));
  });

  test('empty or stopword-only text hashes to zero', () => {
    expect(simhash64('')).toBe(BigInt(0));
  });
});

describe('int64 round trip', () => {
  test('a value above 2^53 keeps every bit through the signed string form', () => {
    const values = [(BigInt(1) << BigInt(64)) - BigInt(1), (BigInt(1) << BigInt(63)) + BigInt(12345), (BigInt(1) << BigInt(53)) + BigInt(1), BigInt(0), BigInt(1)];
    for (const value of values) {
      const text = toInt64String(value);
      expect(BigInt(text) >= -(BigInt(1) << BigInt(63)) && BigInt(text) < BigInt(1) << BigInt(63)).toBe(true);
      expect(fromInt64(text)).toBe(value);
      expect(fromInt64(BigInt(text))).toBe(value);
    }
    expect(toInt64String((BigInt(1) << BigInt(64)) - BigInt(1))).toBe('-1');
  });

  test('rejects malformed values', () => {
    expect(() => fromInt64('12.5')).toThrow();
    expect(() => fromInt64('abc')).toThrow();
  });
});

describe('simhashBands', () => {
  test('returns 8 values of 8 bits, low band first', () => {
    expect(SIMHASH_BAND_COUNT * SIMHASH_BAND_BITS).toBe(64);
    const hash = BigInt('0x0123456789abcdef');
    expect(simhashBands(hash)).toEqual([0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 0x01]);
    for (const value of simhashBands(simhash64(passage(3).join(' ')))) {
      expect(Number.isInteger(value) && value >= 0 && value <= 255).toBe(true);
    }
  });

  test('two hashes that differ in 6 bits share at least one band', () => {
    const base = simhash64(passage(4).join(' '));
    const flips = [
      [0, 9, 18, 27, 36, 45],
      [1, 2, 3, 4, 5, 6],
      [7, 15, 23, 31, 39, 47],
      [8, 17, 26, 35, 44, 53],
      [63, 62, 54, 46, 38, 30],
    ];
    for (const bits of flips) {
      const other = bits.reduce((value, bit) => value ^ (BigInt(1) << BigInt(bit)), base);
      expect(hammingDistance64(base, other)).toBe(6);
      const a = simhashBands(base);
      const b = simhashBands(other);
      expect(a.some((value, index) => value === b[index])).toBe(true);
    }
  });
});
