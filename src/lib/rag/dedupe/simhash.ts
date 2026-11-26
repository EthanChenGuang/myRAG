export const SIMHASH_SHINGLE_SIZE = 3;
export const SIMHASH_BAND_COUNT = 8;
export const SIMHASH_BAND_BITS = 8;

export function simhash64(_text: string): bigint {
  return 0n;
}

export function simhashBands(_hash: bigint): number[] {
  return [];
}

export function hammingDistance64(_a: bigint, _b: bigint): number {
  return 0;
}

export function toInt64String(_hash: bigint): string {
  return '0';
}

export function fromInt64(_value: string | number | bigint): bigint {
  return 0n;
}
