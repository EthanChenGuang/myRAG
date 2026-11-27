import { afterEach, describe, expect, test, vi } from 'vitest';
import { CalcCheckSchema, type CalcTrace } from '@/lib/rag-eval/contracts.generated';
import { runCalcChecks, type CalcBlock, type RunCalcChecksInput } from '@/lib/rag/calc/check-step';
import { evaluateCalc } from '@/lib/rag/calc/evaluate';
import { emitNotice } from '@/lib/rag/generation/notices';

type Json = Record<string, unknown>;
type Request = CalcTrace['request'];

function chunk(name: string, value: string, alias = 'S1', extra: Json = {}): Json {
  return { name, value, source: { kind: 'chunk', alias }, ...extra };
}

function req(operands: Json[], steps: Json[]): Request {
  return { operands, steps, result: steps[steps.length - 1].id } as unknown as Request;
}

const BLOCKS: CalcBlock[] = [
  { alias: 'S1', text: 'Part A is 60 units and part B is 40 units.', language: 'en' },
  { alias: 'S2', text: 'Part C is 25 units and part D is 15 units.' },
];

const ADD_AB = req([chunk('a', '60', 'S1', { unit: 'units' }), chunk('b', '40', 'S1', { unit: 'units' })], [{ id: 's', op: 'add', args: ['a', 'b'] }]);
const ADD_CD = req([chunk('c', '25', 'S2', { unit: 'units' }), chunk('d', '15', 'S2', { unit: 'units' })], [{ id: 't', op: 'add', args: ['c', 'd'] }]);

function toolTrace(request: Request): CalcTrace {
  return { origin: 'tool', request, result: evaluateCalc(request, { aliases: new Set(['S1', 'S2']) }), anchor_offset: null };
}

function run(extra: Partial<RunCalcChecksInput>) {
  return runCalcChecks({
    traces: [],
    invalid: 0,
    offered: true,
    rawText: '',
    blocks: BLOCKS,
    question: 'What are the totals?',
    answerLanguage: 'en',
    ...extra,
  });
}

afterEach(() => vi.restoreAllMocks());

describe('runCalcChecks', () => {
  test('one verified and one corrected: one calc_corrected notice, calc_mismatch, primary is the last', () => {
    const out = run({ traces: [toolTrace(ADD_AB), toolTrace(ADD_CD)], rawText: 'First 100 [S1]. Then 45 [S2].' });
    expect(out.checks.map((c) => c.status)).toEqual(['verified', 'corrected']);
    for (const c of out.checks) expect(CalcCheckSchema.safeParse(c).success).toBe(true);
    expect(out.primary).toBe(out.checks[1]);
    expect(out.primary).toMatchObject({ stated: '45', recomputed: '40' });
    expect(out.notices).toEqual([emitNotice('calc_corrected', { language: 'en', params: { value: '40 units' } })]);
    expect(out.reviewReasons).toEqual(['calc_mismatch']);
  });

  test('only an invalid block marker: one trace_invalid check and one calc_not_verified notice', () => {
    const out = run({ invalid: 1, rawText: 'The total is 100 [S1].' });
    expect(out.checks).toHaveLength(1);
    expect(out.checks[0]).toMatchObject({ status: 'not_verified', reason: 'trace_invalid', origin: 'trailing_block' });
    expect(CalcCheckSchema.safeParse(out.checks[0]).success).toBe(true);
    expect(out.notices).toEqual([emitNotice('calc_not_verified', { language: 'en' })]);
    expect(out.reviewReasons).toEqual(['calc_unverified']);
  });

  test('invalid markers given as an array count one check each; their identical notice is emitted once', () => {
    const out = run({ invalid: [{}, {}], rawText: 'x' });
    expect(out.checks).toHaveLength(2);
    expect(out.notices).toHaveLength(1);
    expect(out.reviewReasons).toEqual(['calc_unverified']);
  });

  test('offered, no trace, a number found nowhere: not_verified trace_missing', () => {
    const raw = 'The total is 130 [S1].';
    const out = run({ rawText: raw });
    expect(out.checks).toHaveLength(1);
    expect(out.checks[0]).toMatchObject({ status: 'not_verified', reason: 'trace_missing', origin: null, stated: '130' });
    expect(raw.slice(out.checks[0].stated_span!.start, out.checks[0].stated_span!.end)).toBe('130');
    expect(CalcCheckSchema.safeParse(out.checks[0]).success).toBe(true);
    expect(out.notices).toEqual([emitNotice('calc_not_verified', { language: 'en' })]);
    expect(out.reviewReasons).toEqual(['calc_unverified']);
  });

  test('offered, no trace, every number present in the question or a block: no check, no notice', () => {
    const out = run({ rawText: '1. Part A is 60 [S1].\n2. Part D is 15 [S2].\nFor 3 parts.', question: 'What about 3 parts?' });
    expect(out).toEqual({ checks: [], primary: null, notices: [], reviewReasons: [] });
  });

  test('not offered and no trace: nothing is checked', () => {
    expect(run({ offered: false, rawText: 'The total is 130 [S1].' }).checks).toEqual([]);
  });

  test('a rejected tool result followed by a successful one: only the successful trace is checked', () => {
    const rejected: CalcTrace = { origin: 'tool', request: ADD_AB, result: evaluateCalc({}, { aliases: new Set() }), anchor_offset: null };
    const out = run({ traces: [rejected, toolTrace(ADD_CD)], rawText: 'It is 40 [S2].' });
    expect(out.checks.map((c) => c.status)).toEqual(['verified']);
    expect(out.notices).toEqual([]);
    expect(out.reviewReasons).toEqual([]);
  });

  test('only a rejected tool result: the trace_missing rule applies', () => {
    const rejected: CalcTrace = { origin: 'tool', request: ADD_AB, result: evaluateCalc({}, { aliases: new Set() }), anchor_offset: null };
    expect(run({ traces: [rejected], rawText: 'It is 130 [S1].' }).checks[0]).toMatchObject({ reason: 'trace_missing' });
  });

  test('a trailing-block trace without a result is checked', () => {
    const block: CalcTrace = { origin: 'trailing_block', request: ADD_AB, result: null, anchor_offset: 10 };
    const out = run({ traces: [block], rawText: 'It is 100 [S1].' });
    expect(out.checks[0]).toMatchObject({ status: 'verified', origin: 'trailing_block' });
  });

  test('a corrected and a not_verified calculation give both notices and both reasons once', () => {
    const missing = req([chunk('x', '61', 'S1')], [{ id: 'r', op: 'sum', args: ['x'] }]);
    const out = run({ traces: [toolTrace(ADD_AB), toolTrace(ADD_CD), toolTrace(missing), toolTrace(missing)], rawText: 'First 101 [S1]. Then 45 [S2].' });
    expect(out.checks.map((c) => c.status)).toEqual(['corrected', 'corrected', 'not_verified', 'not_verified']);
    expect(out.notices.map((n) => n.kind)).toEqual(['calc_corrected', 'calc_corrected', 'calc_not_verified']);
    expect(out.reviewReasons).toEqual(['calc_mismatch', 'calc_unverified']);
  });

  test('an exception thrown inside the check is caught as check_error', () => {
    const exploding = { origin: 'tool', result: { status: 'ok' }, anchor_offset: null } as unknown as CalcTrace;
    Object.defineProperty(exploding, 'request', {
      get() {
        throw new Error('boom');
      },
    });
    const out = run({ traces: [exploding], rawText: 'It is 100 [S1].' });
    expect(out.checks).toHaveLength(1);
    expect(out.checks[0]).toMatchObject({ status: 'not_verified', reason: 'check_error' });
    expect(CalcCheckSchema.safeParse(out.checks[0]).success).toBe(true);
    expect(out.reviewReasons).toEqual(['calc_unverified']);
  });

  test('never throws for malformed input', () => {
    const bad = [null, undefined, {}, { traces: null }, { traces: [null], blocks: [null], rawText: 5 }];
    for (const input of bad) {
      expect(() => runCalcChecks(input as unknown as RunCalcChecksInput)).not.toThrow();
    }
    const out = runCalcChecks({ traces: [null] } as unknown as RunCalcChecksInput);
    expect(out.checks[0]).toMatchObject({ status: 'not_verified', reason: 'check_error' });
  });

  test('logs one [Calc] line with counts and statuses, and nothing without checks', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    run({ traces: [toolTrace(ADD_AB)], rawText: 'It is 100 [S1].' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/^\[Calc\]/);
    expect(JSON.stringify(log.mock.calls[0])).not.toContain('It is');
    log.mockClear();
    run({ offered: false, rawText: 'It is 100.' });
    expect(log).not.toHaveBeenCalled();
  });
});
