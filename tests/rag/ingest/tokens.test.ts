import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEncoding = vi.hoisted(() => vi.fn());

vi.mock('tiktoken', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tiktoken')>();
  getEncoding.mockImplementation(actual.get_encoding);
  return { ...actual, get_encoding: getEncoding };
});

import { countTokens, truncateToTokens } from '@/lib/rag/ingest/text/tokens';

const ZH = '合同自签署之日起生效，有效期为三年，到期前三十日内任何一方可书面提出。';
const EN =
  'The contract takes effect on the date of signature and remains valid for three years unless either party gives written notice of renewal at least thirty days before the expiry date.';
const IT = 'Il contratto entra in vigore alla data della firma e resta valido per tre anni, salvo rinnovo scritto.';

describe('countTokens (cl100k_base, D-22)', () => {
  beforeEach(() => {
    getEncoding.mockClear();
  });

  it('gives the counts the sidecar reports on the shared zh/en/it samples', () => {
    expect(countTokens(ZH)).toBe(35);
    expect(countTokens(EN)).toBe(32);
    expect(countTokens(IT)).toBe(27);
  });

  it('counts the empty string as zero', () => {
    expect(countTokens('')).toBe(0);
  });

  it('creates the encoder lazily and only once', async () => {
    vi.resetModules();
    getEncoding.mockClear();
    const fresh = await import('@/lib/rag/ingest/text/tokens');
    expect(getEncoding).not.toHaveBeenCalled();
    fresh.countTokens('one');
    fresh.countTokens('two');
    fresh.countTokens('three');
    expect(getEncoding).toHaveBeenCalledTimes(1);
    expect(getEncoding).toHaveBeenCalledWith('cl100k_base');
  });
});

describe('truncateToTokens', () => {
  it('returns text that fits unchanged', () => {
    expect(truncateToTokens(EN, 100)).toBe(EN);
  });

  it('cuts to at most the token budget and keeps a prefix of the input', () => {
    const cut = truncateToTokens(EN, 10);
    expect(countTokens(cut)).toBeLessThanOrEqual(10);
    expect(cut.length).toBeGreaterThan(0);
    expect(EN.startsWith(cut)).toBe(true);
  });

  it('never leaves a broken multi-byte character at the cut', () => {
    const cut = truncateToTokens(ZH, 7);
    expect(cut).not.toContain('�');
    expect(ZH.startsWith(cut)).toBe(true);
    expect(countTokens(cut)).toBeLessThanOrEqual(7);
  });

  it('returns an empty string for a zero budget', () => {
    expect(truncateToTokens(EN, 0)).toBe('');
  });
});
