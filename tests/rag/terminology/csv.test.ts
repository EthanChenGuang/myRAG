import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TerminologyImportRowSchema } from '@/lib/rag-eval/contracts.generated';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';
import {
  TERMINOLOGY_CSV_COLUMNS,
  parseTerminologyCsv,
  serializeTerminologyCsv,
  type TerminologyCsvRow,
} from '@/lib/rag/terminology/csv';

/** D-35: languages come from the registry; D-37: placeholder terms only. */
const packs = getLanguageRegistry().packs;
const HAN = packs.find((pack) => pack.script === 'Hani')!.code;
const LATIN = packs.find((pack) => pack.script === 'Latn')!.code;

const HEADER = TERMINOLOGY_CSV_COLUMNS.join(',');

function row(extra: Partial<TerminologyCsvRow> = {}): TerminologyCsvRow {
  return {
    canonical: 'term alpha beta',
    variants: ['termalpha'],
    language: LATIN,
    kind: 'synonym',
    mode: 'one_way',
    enabled: true,
    note: null,
    source_language: null,
    target_language: null,
    ...extra,
  };
}

function csv(...lines: string[]): string {
  return [HEADER, ...lines].join('\n');
}

describe('parseTerminologyCsv (D-23)', () => {
  it('has the nine columns in the D-23 order', () => {
    expect(HEADER).toBe('canonical,variants,language,kind,mode,enabled,note,source_language,target_language');
  });

  it('parses a plain row, splitting variants on |', () => {
    const result = parseTerminologyCsv(csv(`term alpha beta,termalpha|alpha beta,${LATIN},synonym,one_way,true,,,`));
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([row({ variants: ['termalpha', 'alpha beta'] })]);
  });

  it('accepts a BOM and CRLF line ends', () => {
    const text = `﻿${HEADER}\r\nterm alpha beta,termalpha,${LATIN},synonym,one_way,true,,,\r\n`;
    const result = parseTerminologyCsv(text);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([row()]);
  });

  it('handles RFC 4180 quoting: an embedded comma, a doubled quote and an embedded newline', () => {
    const text = csv(`"term alpha, beta","termalpha|say ""alpha""",${LATIN},synonym,one_way,true,"line one\nline two",,`);
    const result = parseTerminologyCsv(text);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      row({ canonical: 'term alpha, beta', variants: ['termalpha', 'say "alpha"'], note: 'line one\nline two' }),
    ]);
  });

  it('reports a wrong header as one error on row 0', () => {
    const result = parseTerminologyCsv(['canonical,variants,language', `term alpha beta,termalpha,${LATIN}`].join('\n'));
    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.row).toBe(0);
  });

  it('reports a row with the wrong number of fields, numbered from 1, without throwing', () => {
    const result = parseTerminologyCsv(csv(`term alpha beta,termalpha,${LATIN},synonym,one_way,true,,,`, `term gamma delta,termgamma,${LATIN}`));
    expect(result.rows).toEqual([row()]);
    expect(result.errors.map((error) => error.row)).toEqual([2]);
  });

  it('reports an unknown kind, mode or enabled value as a row error', () => {
    const result = parseTerminologyCsv(
      csv(
        `term alpha beta,termalpha,${LATIN},nonsense,one_way,true,,,`,
        `term gamma delta,termgamma,${LATIN},synonym,both,true,,,`,
        `term epsilon zeta,termepsilon,${LATIN},synonym,one_way,maybe,,,`,
        `,termeta,${LATIN},synonym,one_way,true,,,`,
        `term eta theta,,${LATIN},synonym,one_way,true,,,`,
      ),
    );
    expect(result.rows).toEqual([]);
    expect(result.errors.map((error) => error.row)).toEqual([1, 2, 3, 4, 5]);
  });

  it('accepts true and false in any case, makes an empty mode one_way and empty languages null', () => {
    const result = parseTerminologyCsv(
      csv(`term alpha beta,termalpha,${LATIN},synonym,,FALSE,,,`, `term gamma delta,termgamma,${LATIN},synonym,equivalent,True,a note,,`),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      row({ enabled: false }),
      row({ canonical: 'term gamma delta', variants: ['termgamma'], mode: 'equivalent', note: 'a note' }),
    ]);
  });

  it('parses a translation row with both languages set', () => {
    const result = parseTerminologyCsv(csv(`term alpha beta,术语甲乙丙,${HAN},translation,one_way,true,,${HAN},${LATIN}`));
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      row({ variants: ['术语甲乙丙'], language: HAN, kind: 'translation', source_language: HAN, target_language: LATIN }),
    ]);
  });

  it('refuses a file over 1 MB', () => {
    const base = csv(`term alpha beta,termalpha,${LATIN},synonym,one_way,true,,,`);
    const over = `${base}\n${'x'.repeat(1024 * 1024 + 1 - Buffer.byteLength(base, 'utf8') - 1)}`;
    expect(Buffer.byteLength(over, 'utf8')).toBe(1024 * 1024 + 1);
    const result = parseTerminologyCsv(over);
    expect(result.limit).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it('refuses 5,001 rows and accepts 5,000', () => {
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `term ${index},t${index},${LATIN},synonym,one_way,true,,,`);
    const atLimit = parseTerminologyCsv(csv(...lines(5000)));
    expect(atLimit.limit).toBe(false);
    expect(atLimit.rows).toHaveLength(5000);
    const over = parseTerminologyCsv(csv(...lines(5001)));
    expect(over.limit).toBe(true);
    expect(over.rows).toEqual([]);
    expect(over.errors).toHaveLength(1);
  });

  it('strips exactly one leading quote only before = + - @ tab or CR', () => {
    const result = parseTerminologyCsv(
      csv(
        `'=SUM(A1),'-1|'hello|''=x,${LATIN},synonym,one_way,true,'@note,,`,
        `"'\tterm alpha beta","'\rtermalpha",${LATIN},synonym,one_way,true,'+x,,`,
      ),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toEqual(row({ canonical: '=SUM(A1)', variants: ['-1', "'hello", "'=x"], note: '@note' }));
    expect(result.rows[1]).toEqual(row({ canonical: '\tterm alpha beta', variants: ['\rtermalpha'], note: '+x' }));
  });
});

describe('serializeTerminologyCsv (D-23, OWASP CSV injection)', () => {
  it('writes the header and one line per row', () => {
    const text = serializeTerminologyCsv([row(), row({ canonical: 'term gamma delta', variants: ['termgamma', 'gamma'], enabled: false })]);
    expect(text.split('\r\n')).toEqual([
      HEADER,
      `term alpha beta,termalpha,${LATIN},synonym,one_way,true,,,`,
      `term gamma delta,termgamma|gamma,${LATIN},synonym,one_way,false,,,`,
      '',
    ]);
  });

  it("prefixes a cell that starts with = + - @ tab or CR with a single quote", () => {
    const text = serializeTerminologyCsv([row({ canonical: '=SUM(A1)', variants: ['-1'], note: '@x' })]);
    const line = text.split('\r\n')[1]!;
    expect(line).toBe(`'=SUM(A1),'-1,${LATIN},synonym,one_way,true,'@x,,`);
    expect(serializeTerminologyCsv([row({ canonical: '+x' })])).toContain("'+x,");
    expect(serializeTerminologyCsv([row({ canonical: '\tx' })])).toContain(`"'\tx"`);
    expect(serializeTerminologyCsv([row({ canonical: '\rx' })])).toContain(`"'\rx"`);
  });

  it('leaves plain text unchanged and quotes commas, quotes and newlines', () => {
    const text = serializeTerminologyCsv([row({ canonical: 'term, alpha', variants: ['say "a"'], note: 'one\ntwo' })]);
    expect(text.split('\r\n')[1]).toBe(`"term, alpha","say ""a""",${LATIN},synonym,one_way,true,"one\ntwo",,`);
    expect(serializeTerminologyCsv([row()])).toContain('term alpha beta,termalpha,');
  });

  it('round-trips every neutralisation case, including values that genuinely start with a quote', () => {
    const rows = [
      row({ canonical: '=SUM(A1)', variants: ['-1', "'hello", "'=x", "''+y"], note: "'@z" }),
      row({ canonical: "'hello", variants: ['@a', '\tb'], note: '\rnote' }),
      row({ canonical: 'term alpha, beta', variants: ['say "alpha"'], note: 'line one\nline two' }),
      row({ variants: ['术语甲乙丙'], language: HAN, kind: 'translation', source_language: HAN, target_language: LATIN }),
    ];
    const parsed = parseTerminologyCsv(serializeTerminologyCsv(rows));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual(rows);
  });

  it('round-trips the fixture dictionary, translation pair included', () => {
    const file = path.join(process.cwd(), 'eval/fixtures/terminology/dictionary.jsonl');
    const original = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => TerminologyImportRowSchema.parse(JSON.parse(line)) as TerminologyCsvRow);
    expect(original.some((entry) => entry.kind === 'translation' && entry.target_language !== null)).toBe(true);
    const parsed = parseTerminologyCsv(serializeTerminologyCsv(original));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual(original);
  });
});
