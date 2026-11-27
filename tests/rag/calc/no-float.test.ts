import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const CALC_DIR = fileURLToPath(new URL('../../../src/lib/rag/calc/', import.meta.url));

const BANNED_TOKENS = ['Number(', 'Number.', 'parseFloat', 'parseInt', 'Math.', 'Date.', 'new Date', 'toFixed'];

// A decimal literal (1.5, .5) or an exponent literal (1e3), not part of an identifier or a longer number.
const FLOAT_LITERALS = [/(?<![\w$.])\d+\.\d+/, /(?<![\w$.\d])\.\d+/, /(?<![\w$.])\d+(?:\.\d+)?[eE][+-]?\d+/];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

export function floatFindings(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const token of BANNED_TOKENS) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tail = /[\w$]$/.test(token) ? '(?![\\w$])' : '';
    if (new RegExp(`(?<![\\w$])${escaped}${tail}`).test(code)) found.push(token);
  }
  for (const re of FLOAT_LITERALS) {
    const m = re.exec(code);
    if (m) found.push(`literal ${m[0]}`);
  }
  return found;
}

function calcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...calcFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

describe('float ban scan', () => {
  test.each([
    ['const x = parseFloat(s);', 'parseFloat'],
    ['const x = Number(s);', 'Number('],
    ['if (Number.isInteger(x)) {}', 'Number.'],
    ['const y = Math.round(x);', 'Math.'],
    ['const t = Date.UTC(2000, 0, 1);', 'Date.'],
    ['const t = new Date();', 'new Date'],
    ['const s = x.toFixed(2);', 'toFixed'],
    ['const s = parseInt(x, 10);', 'parseInt'],
    ['const half = 0.5;', 'literal 0.5'],
    ['const half = .5;', 'literal .5'],
    ['const big = 1e3;', 'literal 1e3'],
  ])('flags %j', (source, finding) => {
    expect(floatFindings(source)).toContain(finding);
  });

  test.each([
    'const ten = BigInt(10);',
    'const v2 = items.length;',
    "const re = /^-?[0-9]+(?:\\.[0-9]+)?$/;",
    'const a = x.n * y.d;',
    '// Math.round is not used; see 5.2.1',
    'type CivilDate = { year: number };',
    'const n = dayNumber(date);',
    'const z = isNaNumber.x + myMath.y + toFixedWidth(s);',
  ])('passes %j', (source) => {
    expect(floatFindings(source)).toEqual([]);
  });

  test('every file under src/lib/rag/calc/ is float-free', () => {
    const files = calcFiles(CALC_DIR);
    expect(files.map((f) => path.basename(f))).toEqual(expect.arrayContaining(['rational.ts', 'dates.ts', 'operations.ts']));
    for (const file of files) {
      expect(floatFindings(readFileSync(file, 'utf8')), path.relative(CALC_DIR, file)).toEqual([]);
    }
  });
});
