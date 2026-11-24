import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyTaxId, isValidEuVat, isValidPartitaIva, isValidUscc, normalizeTaxId } from '@/lib/rag/ids/tax-ids';

interface Vector {
  scheme: 'it_iva' | 'cn_uscc' | 'eu_vat' | 'unknown';
  value: string;
  valid: boolean;
}

const FILE = path.resolve(__dirname, '../fixtures/ingest/tax-id-vectors.json');
const VECTORS = (JSON.parse(fs.readFileSync(FILE, 'utf8')) as { vectors: Vector[] }).vectors;

const DIRECT = {
  it_iva: isValidPartitaIva,
  cn_uscc: isValidUscc,
  eu_vat: isValidEuVat,
} as const;

describe('tax-id validators against the python-stdnum vectors (D-26, D-28)', () => {
  it('the vector file covers every scheme with valid and invalid entries', () => {
    for (const scheme of ['it_iva', 'cn_uscc', 'eu_vat'] as const) {
      const own = VECTORS.filter((vector) => vector.scheme === scheme);
      expect(own.some((vector) => vector.valid), `${scheme} valid`).toBe(true);
      expect(own.some((vector) => !vector.valid), `${scheme} invalid`).toBe(true);
    }
    expect(VECTORS.some((vector) => vector.scheme === 'unknown')).toBe(true);
  });

  it.each(VECTORS.map((vector) => [vector.scheme, vector.value, vector.valid] as const))(
    'classifies %s %j as valid=%s like python-stdnum',
    (scheme, value, valid) => {
      const check = classifyTaxId(value);
      expect(check.scheme).toBe(scheme);
      expect(check.valid).toBe(valid);
    },
  );

  it('the direct validator of each scheme agrees with every vector of that scheme', () => {
    for (const vector of VECTORS.filter((entry) => entry.scheme !== 'unknown')) {
      const direct = DIRECT[vector.scheme as keyof typeof DIRECT];
      expect(direct(vector.value), `${vector.scheme} ${vector.value}`).toBe(vector.valid);
    }
  });

  it('normalises like the sidecar: separators removed, upper case', () => {
    expect(normalizeTaxId('it 999 999 999 90')).toBe('IT99999999990');
    expect(normalizeTaxId('91000000-ma0000000-n')).toBe('91000000MA0000000N');
    expect(normalizeTaxId('99999999990')).toBe('99999999990');
  });

  it('applies the Italian province rule and the all-zero rule on top of the check digit', () => {
    expect(isValidPartitaIva('00000011015')).toBe(false);
    expect(isValidPartitaIva('00000000018')).toBe(false);
    expect(isValidPartitaIva('IT99999999990')).toBe(true);
  });

  it('rejects USCC characters outside the alphabet and wrong lengths', () => {
    expect(isValidUscc('91000000IA0000000N')).toBe(false);
    expect(isValidUscc('91000000MA0000000')).toBe(false);
    expect(isValidUscc('')).toBe(false);
  });

  it('treats an unsupported or unknown country prefix as not valid', () => {
    expect(isValidEuVat('XX12345678')).toBe(false);
    expect(isValidEuVat('LV770192')).toBe(false);
    expect(isValidEuVat('')).toBe(false);
  });
});
