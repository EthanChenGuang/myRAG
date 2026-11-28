import { describe, expect, test } from 'vitest';
import type { CalcTrace } from '@/lib/rag-eval/contracts.generated';
import { observeCalc } from '@/lib/rag/calc/observe';

type Request = CalcTrace['request'];

const CAP_REQUEST = {
  operands: [
    { name: 'items', values: ['60', '70', '40'], unit: 'EUR', source: { kind: 'chunk', alias: 'S1' } },
    { name: 'cap', value: '50', unit: 'EUR', source: { kind: 'chunk', alias: 'S1' } },
  ],
  steps: [
    { id: 'capped', op: 'cap_each', args: ['items', 'cap'], label: 'capped items' },
    { id: 'total', op: 'sum', args: ['capped'], label: 'total' },
  ],
  result: 'total',
} as unknown as Request;

function toolTrace(request: Request): CalcTrace {
  return { origin: 'tool', request, result: null, anchor_offset: 0 };
}

describe('observeCalc stated number (05.2.1-23)', () => {
  test('a total equal to the cap operand is observed as stated, not the listed step value', () => {
    const observed = observeCalc({
      rawText: 'capped items: 140.\ntotal: 50 EUR. [S1]',
      traces: [toolTrace(CAP_REQUEST)],
      aliases: new Set(['S1']),
      language: 'en',
    });
    expect(observed).toMatchObject({ stated: '50', tool_used: true, origin: 'tool' });
  });

  test('the right total is observed', () => {
    const observed = observeCalc({
      rawText: 'capped items: 140.\ntotal: 140 EUR. [S1]',
      traces: [toolTrace(CAP_REQUEST)],
      aliases: new Set(['S1']),
      language: 'en',
    });
    expect(observed.stated).toBe('140');
  });
});
