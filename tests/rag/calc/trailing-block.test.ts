import { describe, expect, it } from 'vitest';
import { CALC_BLOCK_CLOSE, CALC_BLOCK_OPEN } from '@/lib/rag/calc/block-tag';
import {
  createCalcBlockExtractor,
  extractCalcBlocks,
  type CalcBlockEvent,
  type CalcBlockOptions,
} from '@/lib/rag/generation/calc-block';

const REQUEST = {
  operands: [
    { name: 'a', value: '3', source: { kind: 'chunk', alias: 'S1' } },
    { name: 'b', value: '4', source: { kind: 'chunk', alias: 'S2' } },
  ],
  steps: [{ id: 'total', op: 'add', args: ['a', 'b'] }],
  result: 'total',
};
const BLOCK = `${CALC_BLOCK_OPEN}${JSON.stringify(REQUEST)}${CALC_BLOCK_CLOSE}`;

const FIXTURES: Record<string, string> = {
  en: `The first value is 3 [S1] and the second is 4 [S2].\n\nTotal is 7.\n\n${BLOCK}`,
  zh: `第一个数值是 3【S1】，第二个数值是 4【S2】。\n\n合计为 7。\n\n${BLOCK}\n`,
  it: `Il primo valore è 3 [S1, S2] e il secondo è 4.\n${BLOCK}\n\nIl totale è 7 <calc non è un tag.`,
};

function run(text: string, options: Omit<CalcBlockOptions, 'onTrace'> = {}) {
  const events: CalcBlockEvent[] = [];
  const result = extractCalcBlocks(text, { ...options, onTrace: (event) => events.push(event) });
  return { ...result, events };
}

function runPieces(pieces: readonly string[], options: Omit<CalcBlockOptions, 'onTrace'> = {}) {
  const events: CalcBlockEvent[] = [];
  const extractor = createCalcBlockExtractor({ ...options, onTrace: (event) => events.push(event) });
  let visible = '';
  for (const piece of pieces) visible += extractor.push(piece);
  visible += extractor.flush();
  return { visibleText: visible, rawText: extractor.rawText(), events };
}

describe('calc block extractor', () => {
  it('removes the trailing block and records one trailing_block trace at its position', () => {
    const text = `Total is 7.\n\n${BLOCK}`;
    const result = run(text);
    expect(result.visibleText).toBe('Total is 7.');
    expect(result.rawText).toBe('Total is 7.');
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]).toEqual({ origin: 'trailing_block', request: REQUEST, anchor_offset: 'Total is 7.'.length });
    expect(result.invalid).toEqual([]);
    expect(result.events).toEqual(result.traces);
  });

  it('keeps the text around a block in the middle with the whitespace before it', () => {
    const result = run(`A.\n\n${BLOCK}\n\nB.`);
    expect(result.visibleText).toBe('A.\n\nB.');
    expect(result.traces[0]?.anchor_offset).toBe(2);
  });

  it('releases text whose tag prefix diverges unchanged', () => {
    const text = 'A value <calc is not a tag, nor is <calc_tracer> or <cal.';
    expect(run(text).visibleText).toBe(text);
    expect(runPieces([...text]).visibleText).toBe(text);
  });

  it('removes an unterminated block and records it invalid unterminated', () => {
    const result = run(`Total is 7.\n\n${CALC_BLOCK_OPEN}{"operands": [`);
    expect(result.visibleText).toBe('Total is 7.');
    expect(result.traces).toEqual([]);
    expect(result.invalid).toEqual([{ invalid: 'unterminated', anchor_offset: 11 }]);
  });

  it('removes a block over the bound and records it invalid too_long', () => {
    const long = `${CALC_BLOCK_OPEN}${'x'.repeat(8001)}${CALC_BLOCK_CLOSE}`;
    const result = run(`Total is 7.${long} Done.`);
    expect(result.visibleText).toBe('Total is 7. Done.');
    expect(result.invalid).toEqual([{ invalid: 'too_long', anchor_offset: 11 }]);
    const unterminated = run(`Total is 7.${CALC_BLOCK_OPEN}${'x'.repeat(9000)}`);
    expect(unterminated.visibleText).toBe('Total is 7.');
    expect(unterminated.invalid).toEqual([{ invalid: 'too_long', anchor_offset: 11 }]);
  });

  it('honours a smaller bound', () => {
    const result = run(`Total.${BLOCK}`, { maxBlockChars: 10 });
    expect(result.invalid.map((entry) => entry.invalid)).toEqual(['too_long']);
  });

  it('records invalid JSON as parse and a wrong shape as schema', () => {
    expect(run(`T.${CALC_BLOCK_OPEN}{not json${CALC_BLOCK_CLOSE}`).invalid).toEqual([{ invalid: 'parse', anchor_offset: 2 }]);
    const wrong = run(`T.${CALC_BLOCK_OPEN}${JSON.stringify({ ...REQUEST, extra: 1 })}${CALC_BLOCK_CLOSE}`);
    expect(wrong.invalid).toEqual([{ invalid: 'schema', anchor_offset: 2 }]);
    expect(wrong.visibleText).toBe('T.');
  });

  it('accepts a block whose JSON sits in a code fence', () => {
    const fenced = run(`T.${CALC_BLOCK_OPEN}\n\`\`\`json\n${JSON.stringify(REQUEST)}\n\`\`\`\n${CALC_BLOCK_CLOSE}`);
    expect(fenced.traces).toHaveLength(1);
  });

  it('removes a stray close tag', () => {
    expect(run(`Total is 7.${CALC_BLOCK_CLOSE}`).visibleText).toBe('Total is 7.');
  });

  it('leaves text without a block byte-identical, trailing whitespace included', () => {
    const text = 'Plain answer [S1] with spaces   \n\n';
    expect(run(text).visibleText).toBe(text);
    expect(runPieces([...text]).visibleText).toBe(text);
  });

  it('strips citation markers from the visible text only when asked, keeping them in the raw text', () => {
    const text = `Value 3 [S1] and 4 [S2, S3].\n[S4] Next line.\n\n${BLOCK}`;
    const plain = run(text);
    expect(plain.visibleText).toBe('Value 3 [S1] and 4 [S2, S3].\n[S4] Next line.');
    const stripped = run(text, { stripMarkers: true });
    expect(stripped.visibleText).toBe('Value 3 and 4.\nNext line.');
    expect(stripped.rawText).toBe('Value 3 [S1] and 4 [S2, S3].\n[S4] Next line.');
    expect(runPieces(['Value 3 [S', '1] and 4 [S2', ', S3].\n[', 'S4]  Next line.'], { stripMarkers: true }).visibleText).toBe(
      'Value 3 and 4.\nNext line.',
    );
  });
});

describe('whole-text twin agrees with every split', () => {
  const cases: Array<[string, string, Omit<CalcBlockOptions, 'onTrace'>]> = [];
  for (const [language, text] of Object.entries(FIXTURES)) {
    cases.push([`${language} plain`, text, {}]);
    cases.push([`${language} stripped`, text, { stripMarkers: true }]);
  }
  cases.push(['unterminated', `Total is 7 [S1].\n\n${CALC_BLOCK_OPEN}{"operands":`, { stripMarkers: true }]);
  cases.push(['invalid', `Total [S1] is 7.${CALC_BLOCK_OPEN}{bad}${CALC_BLOCK_CLOSE}  after`, {}]);

  it.each(cases)('split %s at every character boundary', (_name, text, options) => {
    const whole = run(text, options);
    expect(whole.visibleText).not.toContain(CALC_BLOCK_OPEN);
    expect(whole.visibleText).not.toContain('"operands"');
    for (let cut = 0; cut <= text.length; cut++) {
      const split = runPieces([text.slice(0, cut), text.slice(cut)], options);
      expect(split.visibleText, `cut ${cut}`).toBe(whole.visibleText);
      expect(split.rawText, `cut ${cut}`).toBe(whole.rawText);
      expect(split.events, `cut ${cut}`).toEqual(whole.events);
    }
    const chars = runPieces([...text], options);
    expect(chars.visibleText).toBe(whole.visibleText);
    expect(chars.events).toEqual(whole.events);
  });

  it('the fixture answers lose exactly the block', () => {
    expect(run(FIXTURES.en!).visibleText).toBe('The first value is 3 [S1] and the second is 4 [S2].\n\nTotal is 7.');
    expect(run(FIXTURES.zh!, { stripMarkers: true }).visibleText).toBe('第一个数值是 3，第二个数值是 4。\n\n合计为 7。');
    expect(run(FIXTURES.it!).visibleText).toBe('Il primo valore è 3 [S1, S2] e il secondo è 4.\nIl totale è 7 <calc non è un tag.');
    for (const text of Object.values(FIXTURES)) expect(run(text).traces).toHaveLength(1);
  });
});
