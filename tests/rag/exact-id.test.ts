import { describe, expect, it } from 'vitest';
import { extractExactIds } from '@/lib/rag/retrieval/exact-id';

const values = (query: string) => extractExactIds(query).map((token) => `${token.kind}:${token.value}`);

describe('extractExactIds (D-28)', () => {
  it('reads an invoice number from a Chinese, English and Italian question', () => {
    expect(extractExactIds('发票 FT-2025-00417 的金额是多少')).toEqual([{ value: 'FT-2025-00417', kind: 'invoice' }]);
    expect(extractExactIds('What is the total of invoice FT-2025-00417?')).toEqual([{ value: 'FT-2025-00417', kind: 'invoice' }]);
    expect(extractExactIds("Qual è l'importo della fattura FT/2025/00417?")).toEqual([{ value: 'FT/2025/00417', kind: 'invoice' }]);
  });

  it('reads a valid Partita IVA and a valid EU VAT number, with their schemes', () => {
    expect(extractExactIds('P.IVA 99999999990')).toEqual([{ value: '99999999990', kind: 'tax_id', scheme: 'it_iva' }]);
    expect(extractExactIds('IT99999999990')).toEqual([{ value: 'IT99999999990', kind: 'tax_id', scheme: 'eu_vat' }]);
    expect(extractExactIds('USCC 91000000MA0000000N')).toEqual([{ value: '91000000MA0000000N', kind: 'tax_id', scheme: 'cn_uscc' }]);
  });

  it('reads a tax id written with spaces or dots as its normalised form', () => {
    expect(values('Who is VAT 999 999 999 90?')).toEqual(['tax_id:99999999990']);
    expect(values('IT 999.999.999.90')).toEqual(['tax_id:IT99999999990']);
  });

  it('does not take a checksum-invalid 11-digit number for a tax id', () => {
    expect(extractExactIds('P.IVA 99999999991')).toEqual([]);
    expect(extractExactIds('IT99999999991')).toEqual([{ value: 'IT99999999991', kind: 'model' }]);
  });

  it('reads a model-number token', () => {
    expect(extractExactIds('型号 LV-77-0192 的保修')).toEqual([{ value: 'LV-77-0192', kind: 'model' }]);
    expect(extractExactIds('How long is the warranty of XR-500B?')).toEqual([{ value: 'XR-500B', kind: 'model' }]);
  });

  it('gives no tokens for plain questions, dates, years and amounts', () => {
    for (const query of [
      'What is the refund policy?',
      '今天的天气怎么样',
      'Quanto costa il servizio nel 2025?',
      'What happened on 2025-03-15?',
      'The total was 1,200.50 euro',
      'ERR_TIMEOUT happens often',
      '',
    ]) {
      expect(extractExactIds(query), query).toEqual([]);
    }
  });

  it('takes a digits-only invoice number only when the question speaks of an invoice', () => {
    expect(values('invoice 20250417 total')).toEqual(['invoice:20250417']);
    expect(values('fattura n. 03/2025')).toEqual(['invoice:03/2025']);
    expect(values('total of 20250417')).toEqual([]);
    expect(values('invoice dated 2025-03-15')).toEqual([]);
  });

  it('applies NFKC first and keeps each token once, in query order', () => {
    expect(values('发票 ＦＴ－２０２５－００４１７ 和 ft-2025-00417 以及 LV-77-0192')).toEqual([
      'invoice:FT-2025-00417',
      'invoice:LV-77-0192',
    ]);
  });

  it('caps the number of tokens and stays linear on hostile text', () => {
    const many = Array.from({ length: 40 }, (_, index) => `AB-${1000 + index}`).join(' ');
    expect(extractExactIds(many).length).toBeLessThanOrEqual(8);
    const started = Date.now();
    expect(extractExactIds('a1-'.repeat(200000)).length).toBeLessThanOrEqual(8);
    expect(extractExactIds('1 '.repeat(200000)).length).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
