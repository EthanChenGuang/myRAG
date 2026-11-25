import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  checkCondensed,
  checkSubQuestions,
  checkVariant,
  DEFAULT_POST_CHECK_LIMITS,
  type CondensedCheck,
  type SubQuestionsCheck,
  type VariantCheck,
} from '@/lib/rag/query/post-checks';

const LIMITS = DEFAULT_POST_CHECK_LIMITS;

describe('checkVariant', () => {
  it('drops a variant that loses a protected token', () => {
    const result = checkVariant(
      { kind: 'expand', text: 'fix the timeout error', input: 'how do I fix ERR_TIMEOUT', protectedTokens: ['ERR_TIMEOUT'] },
      LIMITS,
    );
    expect(result).toEqual({ ok: false, skip: { kind: 'expand', reason: 'protected_token_lost' } });
  });

  it('keeps a variant that keeps every protected token verbatim', () => {
    const text = 'how to fix ERR_TIMEOUT on device AB12';
    const result = checkVariant(
      { kind: 'translate', text, input: 'come risolvo ERR_TIMEOUT su AB12', protectedTokens: ['ERR_TIMEOUT', 'AB12'] },
      LIMITS,
    );
    expect(result).toEqual({ ok: true, text });
  });

  it('is case-sensitive: a lower-cased code counts as lost', () => {
    const result = checkVariant(
      { kind: 'expand', text: 'fix err_timeout', input: 'fix ERR_TIMEOUT', protectedTokens: ['ERR_TIMEOUT'] },
      LIMITS,
    );
    expect(result.ok).toBe(false);
  });

  it('drops a variant over the absolute character cap', () => {
    const input = 'x'.repeat(200);
    const result = checkVariant({ kind: 'expand', text: 'y'.repeat(501), input, protectedTokens: [] }, LIMITS);
    expect(result).toEqual({ ok: false, skip: { kind: 'expand', reason: 'length' } });
    expect(checkVariant({ kind: 'expand', text: 'y'.repeat(500), input, protectedTokens: [] }, LIMITS).ok).toBe(true);
  });

  it('drops a variant longer than 4 times a short input', () => {
    const input = 'warranty?';
    const result = checkVariant({ kind: 'expand', text: 'w'.repeat(input.length * 4 + 1), input, protectedTokens: [] }, LIMITS);
    expect(result).toEqual({ ok: false, skip: { kind: 'expand', reason: 'length' } });
    expect(checkVariant({ kind: 'expand', text: 'w'.repeat(input.length * 4), input, protectedTokens: [] }, LIMITS).ok).toBe(true);
  });

  it('counts characters as code points, not UTF-16 units', () => {
    const input = '保修多久';
    const text = '𠀀'.repeat(16);
    expect(checkVariant({ kind: 'translate', text, input, protectedTokens: [] }, LIMITS).ok).toBe(true);
  });

  it('drops an empty or blank variant', () => {
    expect(checkVariant({ kind: 'expand', text: '   ', input: 'warranty', protectedTokens: [] }, LIMITS)).toEqual({
      ok: false,
      skip: { kind: 'expand', reason: 'empty' },
    });
  });

  it('exempts HyDE passages from the protected-token check (A-10) and from the ratio cap', () => {
    const passage = 'The device reports a timeout when the network does not answer within thirty seconds.';
    const result = checkVariant({ kind: 'hyde', text: passage, input: 'ERR_TIMEOUT?', protectedTokens: ['ERR_TIMEOUT'] }, LIMITS);
    expect(result).toEqual({ ok: true, text: passage });
  });

  it('still caps HyDE passages at the absolute character limit', () => {
    const result = checkVariant({ kind: 'hyde', text: 'p'.repeat(501), input: 'q', protectedTokens: [] }, LIMITS);
    expect(result).toEqual({ ok: false, skip: { kind: 'hyde', reason: 'length' } });
  });

  it('reads caps from the limits argument', () => {
    const result = checkVariant(
      { kind: 'expand', text: 'abcdefghijk', input: 'abcdefghij', protectedTokens: [] },
      { ...LIMITS, variantMaxChars: 10 },
    );
    expect(result).toEqual({ ok: false, skip: { kind: 'expand', reason: 'length' } });
  });
});

describe('checkCondensed', () => {
  it('treats a condensed query equal to the input after whitespace and case folding as pass-through', () => {
    const input = 'quanto dura la garanzia?';
    const result = checkCondensed({ text: ' Quanto  dura la garanzia? ', input, protectedTokens: [] }, LIMITS);
    expect(result).toEqual({ text: input, passThrough: true, skip: null });
  });

  it('uses the condensed text when it differs and passes the checks', () => {
    const result = checkCondensed(
      { text: 'Quanto dura la garanzia in Italia?', input: "E per l'Italia?", protectedTokens: [] },
      LIMITS,
    );
    expect(result).toEqual({ text: 'Quanto dura la garanzia in Italia?', passThrough: false, skip: null });
  });

  it('falls back to the input when the condensed query loses a protected token', () => {
    const input = '那个 ERR_TIMEOUT 怎么修？';
    const result = checkCondensed({ text: '路由器超时错误怎么修？', input, protectedTokens: ['ERR_TIMEOUT'] }, LIMITS);
    expect(result).toEqual({ text: input, passThrough: false, skip: { kind: 'condense', reason: 'protected_token_lost' } });
  });

  it('falls back to the input when the condensed query is too long', () => {
    const input = 'and AB12?';
    const result = checkCondensed({ text: `AB12 ${'z'.repeat(60)}`, input, protectedTokens: ['AB12'] }, LIMITS);
    expect(result).toEqual({ text: input, passThrough: false, skip: { kind: 'condense', reason: 'length' } });
  });
});

describe('checkSubQuestions', () => {
  const input = 'compare AB12 and AB13 battery, price, weight, size, colour and warranty';
  const tokens = ['AB12', 'AB13'];

  it('cuts to the cap and records the cut once', () => {
    const questions = ['battery', 'price', 'weight', 'size', 'colour', 'warranty'].map((f) => `AB12 vs AB13 ${f}`);
    const result = checkSubQuestions({ questions, input, protectedTokens: tokens }, LIMITS);
    expect(result.subQuestions).toEqual(questions.slice(0, 4));
    expect(result.notCompound).toBe(false);
    expect(result.skipped).toEqual([{ kind: 'decompose', reason: 'cap', count: 2 }]);
  });

  it('drops a sub-question that loses a protected token before applying the cap', () => {
    const questions = ['AB12 battery', 'ab-13 battery', 'AB13 price', 'AB12 weight', 'AB13 size', 'AB12 colour'];
    const result = checkSubQuestions({ questions, input, protectedTokens: tokens }, LIMITS);
    expect(result.subQuestions).toEqual(['AB12 battery', 'AB13 price', 'AB12 weight', 'AB13 size']);
    expect(result.skipped).toEqual([
      { kind: 'decompose', reason: 'protected_token_lost', index: 1 },
      { kind: 'decompose', reason: 'cap', count: 1 },
    ]);
  });

  it('keeps per-entity sub-questions of a comparison while together they cover every token', () => {
    const result = checkSubQuestions(
      { questions: ['What is the AB12 battery life?', 'What is the AB13 battery life?'], input, protectedTokens: tokens },
      LIMITS,
    );
    expect(result.subQuestions).toHaveLength(2);
    expect(result.skipped).toEqual([]);
  });

  it('discards the whole list when the kept sub-questions no longer cover every protected token', () => {
    const result = checkSubQuestions(
      { questions: ['What is the AB12 battery life?', 'What is the AB12 price?'], input, protectedTokens: tokens },
      LIMITS,
    );
    expect(result).toEqual({
      subQuestions: [],
      notCompound: false,
      skipped: [{ kind: 'decompose', reason: 'protected_token_lost' }],
    });
  });

  it('maps an empty list to not compound', () => {
    expect(checkSubQuestions({ questions: [], input, protectedTokens: tokens }, LIMITS)).toEqual({
      subQuestions: [],
      notCompound: true,
      skipped: [],
    });
  });

  it('maps a single question equal to the input to not compound', () => {
    const result = checkSubQuestions({ questions: [` ${input.toUpperCase()} `], input, protectedTokens: [] }, LIMITS);
    expect(result).toEqual({ subQuestions: [], notCompound: true, skipped: [] });
  });

  it('drops an over-long sub-question with reason length', () => {
    const result = checkSubQuestions(
      { questions: ['AB12 and AB13 price', `AB12 ${'q'.repeat(600)}`], input, protectedTokens: tokens },
      LIMITS,
    );
    expect(result.subQuestions).toEqual(['AB12 and AB13 price']);
    expect(result.skipped).toEqual([{ kind: 'decompose', reason: 'length', index: 1 }]);
  });
});

describe('post-check outputs carry query text and skip records only (D-15)', () => {
  const FORBIDDEN = ['scope', 'filters', 'mode', 'tools', 'tenant', 'tenantKey'] as const;
  type Forbidden = (typeof FORBIDDEN)[number];
  type Keys<T> = T extends unknown ? keyof T : never;

  it('result types have no scope, filters, mode or tools key', () => {
    expectTypeOf<Extract<Keys<VariantCheck>, Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<Keys<CondensedCheck>, Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<Keys<SubQuestionsCheck>, Forbidden>>().toEqualTypeOf<never>();
  });

  it('runtime results expose only the documented keys', () => {
    const variant = checkVariant({ kind: 'expand', text: 'a', input: 'b', protectedTokens: [] }, LIMITS);
    const condensed = checkCondensed({ text: 'a', input: 'b', protectedTokens: [] }, LIMITS);
    const subs = checkSubQuestions({ questions: ['a', 'b'], input: 'a and b', protectedTokens: [] }, LIMITS);
    expect(Object.keys(variant).sort()).toEqual(['ok', 'text']);
    expect(Object.keys(condensed).sort()).toEqual(['passThrough', 'skip', 'text']);
    expect(Object.keys(subs).sort()).toEqual(['notCompound', 'skipped', 'subQuestions']);
  });

  it('ignores scope-like fields smuggled in through the input object', () => {
    const smuggled = { kind: 'expand', text: 'a', input: 'b', protectedTokens: [], scope: 'tenant-x', mode: 'bypass' } as const;
    const result = checkVariant(smuggled, LIMITS);
    expect(Object.keys(result).sort()).toEqual(['ok', 'text']);
  });
});
