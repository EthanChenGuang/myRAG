import { describe, expect, test } from 'vitest';
import { maskPII } from '@/lib/rag/trace/mask';

describe('maskPII', () => {
  test('replaces e-mail addresses', () => {
    expect(maskPII('write to jane.doe+kb@example.co.uk today')).toBe('write to [EMAIL] today');
  });

  test('replaces spaced and compact IBANs', () => {
    expect(maskPII('pay GB82 WEST 1234 5698 7654 32 please')).toBe('pay [IBAN] please');
    expect(maskPII('DE89370400440532013000')).toBe('[IBAN]');
  });

  test('replaces Luhn-valid card numbers and leaves other long numbers alone', () => {
    expect(maskPII('card 4111 1111 1111 1111 expires')).toBe('card [CARD] expires');
    expect(maskPII('card 4111-1111-1111-1111.')).toBe('card [CARD].');
    expect(maskPII('order 4111 1111 1111 1112 shipped')).toBe('order 4111 1111 1111 1112 shipped');
  });

  test('masks cards before phones so a 00-prefixed card is a card', () => {
    expect(maskPII('0000 0000 0000 0000')).toBe('[CARD]');
  });

  test('replaces international and CN mobile numbers', () => {
    expect(maskPII('call +44 20 7946 0958 today')).toBe('call [PHONE] today');
    expect(maskPII('call 0039 333 1234567 now')).toBe('call [PHONE] now');
    expect(maskPII('mobile 13800138000.')).toBe('mobile [PHONE].');
  });

  test('replaces CN resident IDs and IT codice fiscale', () => {
    expect(maskPII('id 11010119900307123X end')).toBe('id [ID] end');
    expect(maskPII('cf RSSMRA85T10A562S end')).toBe('cf [ID] end');
    expect(maskPII('cf rssmra85t10a562s end')).toBe('cf [ID] end');
  });

  test('leaves plain prose and short numbers untouched', () => {
    const text = 'The refund window is 30 days for annual plans in 2026.';
    expect(maskPII(text)).toBe(text);
  });

  test('recurses into objects and arrays and keeps non-string leaves', () => {
    const input = {
      query: 'mail a@b.io',
      nested: { phones: ['+44 20 7946 0958', 7, true, null], deep: [{ id: 'RSSMRA85T10A562S' }] },
      count: 3,
      flag: false,
      nothing: null,
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    expect(maskPII(input)).toEqual({
      query: 'mail [EMAIL]',
      nested: { phones: ['[PHONE]', 7, true, null], deep: [{ id: '[ID]' }] },
      count: 3,
      flag: false,
      nothing: null,
    });
    expect(input).toEqual(snapshot);
  });

  test('returns non-string primitives unchanged', () => {
    expect(maskPII(42)).toBe(42);
    expect(maskPII(undefined)).toBeUndefined();
    expect(maskPII(null)).toBeNull();
  });
});
