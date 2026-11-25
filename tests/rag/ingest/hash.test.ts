import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HASH_NORMALIZATION_VERSION,
  contentHash,
  fileSha256,
  normalizeForHash,
} from '@/lib/rag/ingest/hash';

interface HashVector {
  name: string;
  text: string;
  normalized: string;
  sha256: string;
}

const vectors = JSON.parse(
  readFileSync(new URL('../../fixtures/ingest/hash-vectors.json', import.meta.url), 'utf8'),
) as { normalization_version: number; vectors: HashVector[] };

describe('content hash normalisation (D-09)', () => {
  it('pins the normalisation version', () => {
    expect(HASH_NORMALIZATION_VERSION).toBe(1);
    expect(vectors.normalization_version).toBe(HASH_NORMALIZATION_VERSION);
  });

  it('unifies CRLF, CR and LF', () => {
    expect(contentHash('A\r\nB')).toBe(contentHash('A\nB'));
    expect(contentHash('A\rB')).toBe(contentHash('A\nB'));
  });

  it('collapses runs of spaces and tabs to one space', () => {
    expect(contentHash('a  b\t c')).toBe(contentHash('a b c'));
  });

  it('collapses runs of newlines to one newline but keeps a single newline', () => {
    expect(contentHash('A\n\n\nB')).toBe(contentHash('A\nB'));
    expect(contentHash('A\nB')).not.toBe(contentHash('A B'));
  });

  it('removes spaces around newlines and trims', () => {
    expect(contentHash(' A \n B ')).toBe(contentHash('A\nB'));
    expect(normalizeForHash('  \n A \n  \n B\n ')).toBe('A\nB');
  });

  it('applies NFKC so full-width forms match their ASCII forms', () => {
    expect(contentHash('ＡＢＣ１２３')).toBe(contentHash('ABC123'));
  });

  it('keeps case', () => {
    expect(contentHash('Abc')).not.toBe(contentHash('abc'));
  });

  it('produces a 64 character lowercase hex digest', () => {
    expect(contentHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches every committed zh/en/it vector', () => {
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(6);
    for (const v of vectors.vectors) {
      expect(normalizeForHash(v.text), `${v.name} normalised`).toBe(v.normalized);
      expect(contentHash(v.text), `${v.name} hash`).toBe(v.sha256);
    }
  });

  it('hashes identically for composed and decomposed accents', () => {
    expect(contentHash('Città')).toBe(contentHash('Città'));
  });
});

describe('fileSha256', () => {
  it('is stable for the same bytes and differs for different bytes', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(fileSha256(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(fileSha256(new Uint8Array([1, 2, 3, 4]))).toBe(fileSha256(a));
    expect(fileSha256(b)).not.toBe(fileSha256(a));
  });

  it('matches the known digest of the empty input', () => {
    expect(fileSha256(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
