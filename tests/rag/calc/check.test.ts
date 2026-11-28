import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { CalcCheckSchema, type CalcTrace } from '@/lib/rag-eval/contracts.generated';
import { canonicalJson } from '@/lib/rag-eval/trace';
import { checkCalculation, locateStatedNumber, stepsListed, traceHash, type CheckInput } from '@/lib/rag/calc/check';
import { evaluateCalc } from '@/lib/rag/calc/evaluate';
import { parseDecimal } from '@/lib/rag/calc/rational';

type Json = Record<string, unknown>;
type Request = CalcTrace['request'];

function q(name: string, value: string, extra: Json = {}): Json {
  return { name, value, source: { kind: 'question' }, ...extra };
}

function chunk(name: string, value: string, alias = 'S1', extra: Json = {}): Json {
  return { name, value, source: { kind: 'chunk', alias }, ...extra };
}

function list(name: string, values: string[], alias = 'S1', extra: Json = {}): Json {
  return { name, values, source: { kind: 'chunk', alias }, ...extra };
}

function step(id: string, op: string, args: string[], extra: Json = {}): Json {
  return { id, op, args, ...extra };
}

function req(operands: Json[], steps: Json[], result?: string): Request {
  return { operands, steps, result: result ?? (steps[steps.length - 1].id as string) } as unknown as Request;
}

function trace(request: Request, extra: Partial<CalcTrace> = {}): CalcTrace {
  return { origin: 'tool', request, result: null, anchor_offset: null, ...extra };
}

const BLOCKS: Record<string, string> = {
  S1: 'Item A is 60 EUR, item B is 70 EUR and item C is 40 EUR. Each item counts at most 50 EUR.',
  S2: 'The shared amount is 100 units.',
  S3: 'Voce A 1.000,25 EUR e voce B 250,25 EUR.',
};

function input(t: CalcTrace, rawText: string, extra: Partial<CheckInput> = {}): CheckInput {
  return {
    trace: t,
    rawText,
    blockText: (alias) => BLOCKS[alias] ?? null,
    blockLanguage: (alias) => (alias === 'S3' ? 'it' : 'en'),
    question: 'What is the total?',
    answerLanguage: 'en',
    ...extra,
  };
}

const PER_ITEM = trace(
  req(
    [list('items', ['60', '70', '40'], 'S1', { unit: 'EUR' }), chunk('cap', '50', 'S1', { unit: 'EUR' })],
    [step('capped', 'cap_each', ['items', 'cap'], { label: 'capped items' }), step('total', 'sum', ['capped'], { label: 'total' })],
  ),
);

function valid(check: unknown): void {
  expect(CalcCheckSchema.safeParse(check).success).toBe(true);
}

describe('checkCalculation', () => {
  test('a per-item cap trace whose stated total matches is verified', () => {
    const raw = 'Total: 140 [S1].';
    const { check, noticeValue } = checkCalculation(input(PER_ITEM, raw));
    valid(check);
    expect(check).toMatchObject({ status: 'verified', stated: '140', recomputed: '140', unit: 'EUR', origin: 'tool', reason: null });
    expect(check.stated_span).toEqual({ start: 7, end: 10 });
    expect(raw.slice(7, 10)).toBe('140');
    expect(noticeValue).toBeNull();
  });

  test('the rule-skipping shape (correct trace, cap-on-total number stated) is corrected', () => {
    const { check, noticeValue } = checkCalculation(input(PER_ITEM, 'Total: 120 [S1].'));
    valid(check);
    expect(check).toMatchObject({ status: 'corrected', stated: '120', recomputed: '140', unit: 'EUR' });
    expect(noticeValue).toBe('140 EUR');
  });

  test('a chunk operand absent from its cited block is not verified', () => {
    const t = trace(req([chunk('a', '45', 'S1'), chunk('b', '50', 'S1')], [step('s', 'add', ['a', 'b'])]));
    const { check } = checkCalculation(input(t, 'The sum is 95 [S1].'));
    valid(check);
    expect(check).toMatchObject({ status: 'not_verified', reason: 'operand_not_located', recomputed: '95' });
  });

  test('every list value must be in the cited block', () => {
    const t = trace(req([list('items', ['60', '70', '45'], 'S1', { unit: 'EUR' })], [step('total', 'sum', ['items'])]));
    expect(checkCalculation(input(t, 'Total: 175 [S1].')).check).toMatchObject({ status: 'not_verified', reason: 'operand_not_located' });
  });

  describe('stated places without a round step', () => {
    const t = trace(req([chunk('amount', '100', 'S2'), q('people', '3')], [step('share', 'divide', ['amount', 'people'])]));
    const ask = { question: 'How much is it for 3 people?' };
    test.each([
      ['The result is 33.33 [S2].', 'verified'],
      ['The result is 33.3333 [S2].', 'verified'],
      ['The result is 33.4 [S2].', 'corrected'],
    ])('%s is %s', (raw, status) => {
      const { check } = checkCalculation(input(t, raw, ask));
      valid(check);
      expect(check.status).toBe(status);
    });

    test('the notice value uses the stated places', () => {
      expect(checkCalculation(input(t, 'The result is 33.4 [S2].', ask)).noticeValue).toBe('33.3');
    });
  });

  test('a round step compares with the rounded value only', () => {
    const t = trace(
      req([chunk('amount', '100', 'S2'), q('people', '3')], [step('share', 'divide', ['amount', 'people']), step('r', 'round', ['share'], { rounding: { mode: 'half_even', places: 0 } })]),
    );
    const ask = { question: 'How much is it for 3 people?' };
    expect(checkCalculation(input(t, 'It is 33 [S2].', ask)).check.status).toBe('verified');
    expect(checkCalculation(input(t, 'It is 33.33 [S2].', ask)).check.status).toBe('corrected');
  });

  test('a sentence restating an operand after the total still picks the total', () => {
    const t = trace(req([chunk('a', '60', 'S1'), chunk('b', '40', 'S1')], [step('s', 'add', ['a', 'b'])]));
    const raw = 'The total is 100, from 60 [S1].';
    const { check } = checkCalculation(input(t, raw));
    expect(check.status).toBe('verified');
    expect(raw.slice(check.stated_span!.start, check.stated_span!.end)).toBe('100');
  });

  test('an intermediate step value is skipped', () => {
    const t = trace(
      req([chunk('a', '60', 'S1'), chunk('b', '40', 'S1'), chunk('c', '50', 'S1')], [step('ab', 'add', ['a', 'b']), step('total', 'subtract', ['ab', 'c'])]),
    );
    expect(checkCalculation(input(t, 'So 50 remain, after 100 [S1].')).check).toMatchObject({ status: 'verified', stated: '50' });
  });

  test('without citations the number nearest to the anchor is stated', () => {
    const t = trace(req([chunk('a', '60', 'S1'), chunk('b', '40', 'S1')], [step('s', 'add', ['a', 'b'])]), { anchor_offset: 12 });
    const raw = 'The sum: 100. A later note: 99.';
    expect(checkCalculation(input(t, raw)).check).toMatchObject({ status: 'verified', stated: '100' });
    const atEnd = trace(t.request, { anchor_offset: raw.length });
    expect(checkCalculation(input(atEnd, raw)).check).toMatchObject({ status: 'corrected', stated: '99' });
    const noAnchor = trace(t.request);
    expect(checkCalculation(input(noAnchor, raw)).check).toMatchObject({ status: 'corrected', stated: '99' });
  });

  test('a question-only calculation needs its operands in the question', () => {
    const t = trace(req([q('a', '12'), q('b', '30')], [step('s', 'add', ['a', 'b'])]));
    expect(checkCalculation(input(t, 'It is 42.', { question: 'What is 12 plus 30?' })).check.status).toBe('verified');
    expect(checkCalculation(input(t, 'It is 42.', { question: 'What is 12 plus 31?' })).check).toMatchObject({
      status: 'not_verified',
      reason: 'operand_not_located',
    });
  });

  test('blocks are read in their own language and the answer in the answer language', () => {
    const t = trace(req([chunk('a', '1000.25', 'S3', { unit: 'EUR' }), chunk('b', '250.25', 'S3', { unit: 'EUR' })], [step('s', 'add', ['a', 'b'])]));
    const { check, noticeValue } = checkCalculation(input(t, 'Il totale è 1.250,40 EUR [S3].', { answerLanguage: 'it' }));
    expect(check).toMatchObject({ status: 'corrected', stated: '1250.4', recomputed: '1250.5' });
    expect(noticeValue).toBe('1.250,50 EUR');
    expect(checkCalculation(input(t, 'Il totale è 1.250,50 EUR [S3].', { answerLanguage: 'it' })).check.status).toBe('verified');
  });

  test('a rejected trace is not verified as trace_invalid', () => {
    const t = trace(req([chunk('a', '60', 'S1'), q('z', '0')], [step('s', 'divide', ['a', 'z'])]));
    expect(checkCalculation(input(t, 'It is 0 [S1].')).check).toMatchObject({ status: 'not_verified', reason: 'trace_invalid' });
  });

  test('an alias without a block is not verified as trace_invalid', () => {
    const t = trace(req([chunk('a', '60', 'S9'), chunk('b', '40', 'S9')], [step('s', 'add', ['a', 'b'])]));
    expect(checkCalculation(input(t, 'It is 100 [S9].')).check).toMatchObject({ status: 'not_verified', reason: 'trace_invalid' });
  });

  test('an answer without a candidate number is stated_not_found', () => {
    const t = trace(req([chunk('a', '60', 'S1'), chunk('b', '40', 'S1')], [step('s', 'add', ['a', 'b'])]));
    const { check } = checkCalculation(input(t, 'From 60 and 40 [S1].'));
    valid(check);
    expect(check).toMatchObject({ status: 'not_verified', reason: 'stated_not_found', recomputed: '100' });
  });

  describe('a sentence naming the result step label (05.2.1-23)', () => {
    const SHARE = trace(
      req(
        [chunk('a', '60', 'S1', { unit: 'EUR' }), chunk('b', '70', 'S1', { unit: 'EUR' }), q('share', '10')],
        [
          step('base', 'add', ['a', 'b'], { label: 'sum of the items' }),
          step('added', 'percentage', ['base', 'share'], { label: 'added share' }),
          step('size', 'add', ['base', 'added'], { label: 'counted size' }),
        ],
      ),
    );
    const shareAsk = { question: 'What is the counted size with a 10 percent share?' };

    test('a total equal to an operand (the cap applied to the sum) is corrected, not verified', () => {
      const { check, noticeValue } = checkCalculation(input(PER_ITEM, 'capped items: 140.\ntotal: 50 EUR. [S1]'));
      valid(check);
      expect(check).toMatchObject({ status: 'corrected', stated: '50', recomputed: '140' });
      expect(noticeValue).toBe('140 EUR');
    });

    test('a total equal to an intermediate (the share left out) is corrected, not stated_not_found', () => {
      const { check } = checkCalculation(input(SHARE, 'sum of the items: 130.\nadded share: 13.\ncounted size: 130 EUR [S1].', shareAsk));
      valid(check);
      expect(check).toMatchObject({ status: 'corrected', stated: '130', recomputed: '143' });
    });

    test('the right total after the label stays verified', () => {
      expect(checkCalculation(input(PER_ITEM, 'capped items: 140.\ntotal: 140 EUR. [S1]')).check).toMatchObject({ status: 'verified', stated: '140' });
      expect(
        checkCalculation(input(SHARE, 'sum of the items: 130.\nadded share: 13.\ncounted size: 143 EUR [S1].', shareAsk)).check,
      ).toMatchObject({ status: 'verified', stated: '143' });
    });

    test('a citing sentence with a candidate still wins over the label', () => {
      const raw = 'The total depends on the cap of 50 EUR. The items come to 140 EUR [S1].';
      expect(checkCalculation(input(PER_ITEM, raw)).check).toMatchObject({ status: 'verified', stated: '140' });
    });

    test('an operand-only citing sentence without the label is still skipped', () => {
      const raw = 'Each item counts at most 50 EUR [S1]. So the items come to 140 EUR.';
      expect(checkCalculation(input(PER_ITEM, raw)).check).toMatchObject({ status: 'verified', stated: '140' });
    });
  });

  test('a stated number with a magnitude word compares at its own scale', () => {
    const t = trace(req([chunk('amount', '100', 'S2'), q('k', '20000')], [step('m', 'multiply', ['amount', 'k'])]));
    const ask = { question: 'What is it times 20000?' };
    expect(checkCalculation(input(t, 'It is 2 million [S2].', ask)).check.status).toBe('verified');
    expect(checkCalculation(input(t, 'It is 2.1 million [S2].', ask)).check.status).toBe('corrected');
  });

  test('trace_hash is the sha256 of the canonical request JSON', () => {
    const expected = createHash('sha256').update(canonicalJson(PER_ITEM.request), 'utf8').digest('hex');
    expect(traceHash(PER_ITEM.request)).toBe(expected);
    expect(checkCalculation(input(PER_ITEM, 'Total: 140 [S1].')).check.trace_hash).toBe(expected);
  });
});

describe('locateStatedNumber', () => {
  test('the last citing sentence with a candidate wins over a later uncited number', () => {
    const raw = 'Total: 140 [S1]. Call 555 for help.';
    const m = locateStatedNumber(raw, { aliases: new Set(['S1']), excluded: [], anchor: raw.length, language: 'en' });
    expect(m?.raw).toBe('140');
  });

  test('a citation of another alias does not count', () => {
    const raw = 'Total: 140 [S2]. Later: 7.';
    const m = locateStatedNumber(raw, { aliases: new Set(['S1']), excluded: [], anchor: raw.length, language: 'en' });
    expect(m?.raw).toBe('7');
  });

  test('excluded values are skipped and nothing left gives null', () => {
    const raw = 'From 60 [S1].';
    expect(locateStatedNumber(raw, { aliases: new Set(['S1']), excluded: [parseDecimal('60')], anchor: 0, language: 'en' })).toBeNull();
  });
});

describe('stepsListed', () => {
  const result = evaluateCalc(PER_ITEM.request, { aliases: new Set(['S1']) });

  test('true when every labelled intermediate step value appears before the stated total', () => {
    expect(stepsListed('Capped items: 140; total 140 [S1].', PER_ITEM, result, 'en', 25)).toBe(true);
  });

  test('false when a labelled step value is missing before the total', () => {
    const t = trace(
      req([chunk('a', '60', 'S1'), chunk('b', '40', 'S1'), chunk('c', '50', 'S1')], [step('ab', 'add', ['a', 'b'], { label: 'sum' }), step('total', 'subtract', ['ab', 'c'])]),
    );
    const r = evaluateCalc(t.request, { aliases: new Set(['S1']) });
    expect(stepsListed('So 50 remain [S1].', t, r, 'en')).toBe(false);
    expect(stepsListed('60 plus 40 is 100; so 50 remain [S1].', t, r, 'en')).toBe(true);
    expect(stepsListed('So 50 remain, after 100 [S1].', t, r, 'en', 3)).toBe(false);
  });

  test('false for a rejected result', () => {
    expect(stepsListed('140', PER_ITEM, evaluateCalc({}, { aliases: new Set() }), 'en')).toBe(false);
  });
});
